import { snippetFork } from "./snippets.ts"
import { inFork } from "./forkState.ts"
import { makeSnippetWrites } from "./snippetWrites.ts"
// The editors' write handlers (ARCHITECTURE.md "Editing the library"). They run in the
// writer worker, each as one transaction, through the library's own steps (libraryWrites.ts),
// so every change flows on to the refs that follow the edited one.
import { NOTE_SCHEMA_VERSION } from "@rp/shared/docs/note.ts"
import { DraftKey } from "@rp/shared/drafts.ts"
import {
  applyDrafts,
  canonicalJson,
  droppedDrafts,
  getAt,
  keepsRegexApproval,
  newCardNote,
  newChatNote,
  newSharedNote,
  parseField,
  validateDoc,
  withoutGrantedAgentEdits
} from "@rp/shared/editing.ts"
import { type ChatNotePosition, EditConflict, InvalidDocument } from "@rp/shared/editorApi.ts"
import type { ChatId, EntityId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import type { Doc, EntityKind } from "@rp/shared/library.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import { editedDoc } from "@rp/shared/presetConditions.ts"
import { Effect, Predicate } from "effect"
import type { SqlClient, SqlError } from "effect/sql"
import type { makeDraftStore } from "./drafts.ts"
import { makeGraphWrites } from "./graphWrites.ts"
import { noteAt } from "./noteAt.ts"
import { sharedNote } from "./sharedNotes.ts"
import { type makeLibraryQueries, type RefRow, toLibraryRef } from "./library.ts"
import type { EncodedDoc } from "./libraryWrites.ts"
import { NotFound, RefChange, RefOperationRefused, StaleWrite, type WriteOps } from "./ops.ts"
import { transaction } from "./tx.ts"

type Sql<A> = Effect.Effect<A, SqlError.SqlError>

/** The library's write steps the editors share (libraryWrites.ts). */
export interface LibrarySteps {
  readonly sql: SqlClient.SqlClient
  readonly lib: ReturnType<typeof makeLibraryQueries>
  readonly drafts: ReturnType<typeof makeDraftStore>
  readonly encode: (doc: Doc) => EncodedDoc
  readonly insertRevision: (options: {
    readonly entityId: string
    readonly schemaVersion: number
    readonly doc: EncodedDoc
    readonly parents: ReadonlyArray<string>
    readonly origin: "import" | "user" | "merge"
    readonly originRef: string | null
    readonly message: string | null
  }) => Sql<string>
  readonly moveHead: (refId: string, head: string, mergeBase: string | null) => Sql<unknown>
  readonly changed: (refId: string) => Sql<RefChange>
  readonly reload: (refId: string) => Sql<RefRow>
  readonly checkRowVersion: (ref: RefRow, expected: number) => Effect.Effect<void, StaleWrite>
  readonly revision: (id: string) => Sql<{ readonly doc_hash: string; readonly schema_version: number }>
  readonly recordMedia: (
    userId: string,
    file: { sha256: string; mime: string; byteSize: number; width: number | null; height: number | null }
  ) => Sql<string>
  readonly createUpstream: (options: {
    readonly userId: string
    readonly kind: EntityKind
    readonly label: string
    readonly subtitle: string
    readonly doc: EncodedDoc
    readonly schemaVersion: number
    readonly origin: "user" | "import"
    readonly originRef: string | null
    readonly sourcePath: string | null
    readonly sourceHash: string | null
    readonly message?: string | null
  }) => Sql<RefRow>
  readonly checkReferences: (userId: string, doc: Doc) => Effect.Effect<void, NotFound | SqlError.SqlError>
}

const parseValue = (content: string): unknown => {
  if (content === "undefined") return undefined
  try {
    return JSON.parse(content)
  } catch {
    return content
  }
}

export const makeEditorWriteHandlers = (steps: LibrarySteps) => {
  const { sql, lib, drafts } = steps

  /** The user's own change to a ref: a new revision on its head, passed on to its followers. */
  const userEdit = (ref: RefRow, doc: Doc, message: string | null, originRef: string | null) =>
    Effect.gen(function* () {
      const current = yield* steps.revision(ref.head_revision_id)
      const encoded = steps.encode(doc)
      // A change that changes nothing makes no revision.
      if (encoded.hash === current.doc_hash) return new RefChange({ ref: toLibraryRef(ref), followers: [] })
      const id = yield* steps.insertRevision({
        entityId: ref.entity_id,
        schemaVersion: current.schema_version,
        doc: encoded,
        parents: [ref.head_revision_id],
        origin: "user",
        originRef,
        message
      })
      yield* steps.moveHead(ref.id, id, null)
      return yield* steps.changed(ref.id)
    })

  /**
   * A chat's note edited from a position: a revision on the one bound there, and the binding
   * event from there on, on that branch (DESIGN §3.4), leaving the library head and sibling
   * branches as they are.
   */
  const chatNoteEdit = (userId: UserId, ref: RefRow, doc: Doc, message: string | null, position: ChatNotePosition) =>
    Effect.gen(function* () {
      const current = yield* steps.revision(ref.head_revision_id)
      // The binding supplies applicability for an edit; the import's source no longer does.
      const { source_slot_id: _source, ...edited } = doc
      const encoded = steps.encode(doc.kind === "imported_summary" ? edited : doc)
      if (encoded.hash === current.doc_hash) return new RefChange({ ref: toLibraryRef(ref), followers: [] })
      const revision = yield* steps.insertRevision({
        entityId: ref.entity_id,
        schemaVersion: current.schema_version,
        doc: encoded,
        parents: [ref.head_revision_id],
        origin: "user",
        originRef: null,
        message
      })
      yield* makeGraphWrites(sql, drafts).insertStateEvent(
        userId,
        position.chatId,
        position.slotId,
        null,
        null,
        { key: "note.binding", value: { note: ref.entity_id as EntityId, revision: revision as never } },
        position.forkId ?? null
      )
      return new RefChange({ ref: toLibraryRef({ ...ref, head_revision_id: revision }), followers: [] })
    })

  /**
   * A note slot as it stands where it's edited: a chat's note at `position` when given (its
   * branch-local revision), else the library head; and the write for its change there.
   */
  const noteSlot = (userId: UserId, refId: string, position: ChatNotePosition | undefined) =>
    Effect.gen(function* () {
      const owned = yield* lib.ownedRef(userId, refId)
      if (owned.kind !== "note") return yield* new NotFound({ entity: "note", id: refId })
      const head = yield* lib.loadDoc(owned.head_revision_id)
      const chat = Predicate.isObject(head.owner) && head.owner.chat !== undefined
      const resolved = chat && position ? yield* noteAt(sql, lib, userId, owned, position) : null
      const ref = resolved?.ref ?? owned
      const doc = resolved?.doc ?? head
      const write = (next: Doc, message: string) =>
        resolved && position ? chatNoteEdit(userId, ref, next, message, position) : userEdit(ref, next, message, null)
      return { ref, doc, write }
    })

  /** A revision of the ref's own entity, or none. */
  const entityRevision = (ref: RefRow, revisionId: string) =>
    sql<{ doc_json: string; schema_version: number; created_at: number }>`
      SELECT doc_json, schema_version, created_at FROM entity_revisions
      WHERE id = ${revisionId} AND entity_id = ${ref.entity_id}`.pipe(Effect.map(([row]) => row ?? null))

  const refused = (ref: RefRow, reason: string) => new RefOperationRefused({ refId: ref.id, reason })

  /** A new slot linked to a shared note takes its title; the shared note must be the user's, live. */
  const linkTitle = (userId: UserId, link: EntityId | undefined) =>
    Effect.gen(function* () {
      if (link === undefined) return null
      const shared = yield* sharedNote(sql, userId, link)
      if (shared === null || shared.deleted === 1) return yield* new NotFound({ entity: "note", id: link })
      return shared.title || null
    })

  const handlers = {
    ...makeSnippetWrites(steps),
    CommitEditorDrafts: ({ userId, refId, expectedRowVersion, fields, message, chatNote }) =>
      Effect.gen(function* () {
        const owned = yield* lib.ownedRef(userId, refId)
        const resolved = chatNote ? yield* noteAt(sql, lib, userId, owned, chatNote) : null
        const ref = resolved?.ref ?? owned
        for (const { draftId } of fields) yield* drafts.checkIdentity(userId, draftId)
        yield* steps.checkRowVersion(ref, expectedRowVersion)
        const head = editedDoc(ref.kind, resolved?.doc ?? (yield* lib.loadDoc(ref.head_revision_id)))
        const rows = []
        for (const { field, draftId, expectedRowVersion: expected } of fields) {
          const row = yield* drafts.find(userId, new DraftKey({ targetKind: "entity_field", targetId: refId, field }))
          // Another tab typed on since, ended it, or it's another draft (that one moved to a
          // variant): the client reads it again.
          if (row === null || row.id !== draftId || row.status !== "active" || row.row_version !== expected) {
            return yield* new StaleWrite({ entity: "draft", id: field, expected, actual: row?.row_version ?? 0 })
          }
          rows.push(row)
        }
        // A draft in something that's gone (a prompt deleted since) is set aside: its text goes
        // to the recovered texts, and the rest is saved. It's found first, so it never counts
        // as a conflict.
        const orphans = new Set(
          applyDrafts(ref.kind, head, rows)
            .problems.filter((problem) => problem.orphan)
            .map((problem) => problem.field)
        )
        // A draft started from an older revision conflicts where the saved version changed
        // the same field since, unless both say the same.
        const bases = new Map<string, Doc>()
        const conflicts = []
        for (const row of rows) {
          const field = parseField(row.field)
          if (row.base_revision === null || row.base_revision === ref.head_revision_id || field === null) continue
          if (orphans.has(row.field)) continue
          if (!bases.has(row.base_revision)) {
            const base = yield* lib.draftBase(ref.entity_id, row.base_revision)
            bases.set(row.base_revision, base === null ? {} : editedDoc(ref.kind, JSON.parse(base.doc_json) as Doc))
          }
          const saved = getAt(head, field.path)
          const draft = field.kind === "value" ? parseValue(row.content) : row.content
          const before = canonicalJson(getAt(bases.get(row.base_revision), field.path))
          if (before !== canonicalJson(saved) && canonicalJson(draft) !== canonicalJson(saved)) {
            conflicts.push({ field: row.field, draft, ...(saved === undefined ? {} : { saved }) })
          }
        }
        if (conflicts.length > 0) return yield* new EditConflict({ fields: conflicts })
        // Any other problem refuses the save.
        const kept = rows.filter((row) => !orphans.has(row.field))
        const applied = applyDrafts(ref.kind, head, kept)
        if (applied.problems.length > 0) {
          return yield* new InvalidDocument({ problems: applied.problems.map((p) => `${p.field}: ${p.message}`) })
        }
        const valid = validateDoc(ref.kind, applied.doc)
        if (!valid.ok) return yield* new InvalidDocument({ problems: valid.problems })
        // What the schema would drop (text at a key it doesn't know) is refused, never saved away.
        const dropped = droppedDrafts(applied.doc, valid.doc, kept)
        if (dropped.length > 0) {
          return yield* new InvalidDocument({
            problems: dropped.map(({ field }) => `${field}: a ${ref.kind} has no such field, so this can't be saved.`)
          })
        }
        // A note's condition card and link name only the user's own (§14.3).
        if (ref.kind === "note") yield* steps.checkReferences(userId, valid.doc)
        const change = yield* chatNote
          ? chatNoteEdit(userId, ref, valid.doc, message, chatNote)
          : userEdit(ref, valid.doc, message, null)
        let recovered = 0
        const recoveredFields: Array<string> = []
        for (const row of rows) {
          const orphan = orphans.has(row.field)
          const ended = yield* drafts.end(row, orphan ? "discarded" : "committed")
          // A set-aside draft is reported as such; what the others' sessions lost is counted.
          if (!orphan && ended.recovered > 0) {
            recovered += ended.recovered
            recoveredFields.push(row.field)
          }
        }
        return new RefChange({ ...change, setAside: [...orphans], recovered, recoveredFields })
      }).pipe(transaction(sql, "CommitEditorDrafts")),

    RestoreRevision: ({ userId, refId, revisionId, expectedRowVersion }) =>
      Effect.gen(function* () {
        const ref = yield* lib.ownedRef(userId, refId)
        yield* steps.checkRowVersion(ref, expectedRowVersion)
        const earlier = yield* entityRevision(ref, revisionId)
        if (earlier === null) return yield* new NotFound({ entity: "revision", id: revisionId })
        if (earlier.schema_version !== (yield* steps.revision(ref.head_revision_id)).schema_version) {
          return yield* refused(ref, "That revision is of another schema version, and documents can't be migrated yet.")
        }
        const head = yield* lib.loadDoc(ref.head_revision_id)
        // A permission revoked since doesn't come back with the old revision.
        let doc = withoutGrantedAgentEdits(ref.kind, head, JSON.parse(earlier.doc_json) as Doc)
        // An old revision's scripts, an import's say, don't come back approved.
        if ((ref.kind === "preset" || ref.kind === "card") && doc.regex_approved === true) {
          if (!keepsRegexApproval(head, doc)) doc = { ...doc, regex_approved: false }
        }
        const saved = new Date(earlier.created_at).toISOString().replace("T", " ").slice(0, 16)
        return yield* userEdit(
          ref,
          doc,
          `Restored the revision of ${saved} UTC`,
          JSON.stringify({ restored: revisionId })
        )
      }).pipe(transaction(sql, "RestoreRevision")),

    ForkWithDrafts: ({ userId, refId, label, subtitle, moveDrafts }) =>
      Effect.gen(function* () {
        const ref = yield* lib.ownedRef(userId, refId)
        if (ref.kind === "card") return yield* refused(ref, "Cards use independent forks.")
        if (ref.ref_kind === "chat_override") {
          return yield* refused(ref, "A chat override can't be forked; promote it to a variant instead.")
        }
        const id = uuidv7()
        const at = Date.now()
        yield* sql`INSERT INTO entity_refs ${sql.insert({
          id,
          entity_id: ref.entity_id,
          ref_kind: "variant",
          head_revision_id: ref.head_revision_id,
          follows_ref_id: ref.id,
          merge_base_revision_id: ref.head_revision_id,
          label,
          subtitle,
          created_at: at,
          updated_at: at
        })}`
        if (moveDrafts) {
          yield* sql`UPDATE drafts SET target_id = ${id}, row_version = row_version + 1, updated_at = ${at}
            WHERE user_id = ${userId} AND target_kind = 'entity_field' AND target_id = ${refId} AND status = 'active'`
        }
        return toLibraryRef(yield* steps.reload(id))
      }).pipe(transaction(sql, "ForkWithDrafts")),

    RenameRef: ({ userId, refId, label, subtitle, expectedRowVersion }) =>
      Effect.gen(function* () {
        const ref = yield* lib.ownedRef(userId, refId)
        yield* steps.checkRowVersion(ref, expectedRowVersion)
        if (ref.kind === "card") {
          const head = yield* lib.loadDoc(ref.head_revision_id)
          return (yield* userEdit(
            ref,
            { ...head, name: label, character_version: subtitle },
            "Changed card display name and version",
            null
          )).ref
        }
        yield* sql`UPDATE entity_refs SET label = ${label}, subtitle = ${subtitle}, row_version = row_version + 1,
                   updated_at = ${Date.now()} WHERE id = ${refId}`
        return toLibraryRef(yield* steps.reload(refId))
      }).pipe(transaction(sql, "RenameRef")),

    SetRegexApproval: ({ userId, refId, approved, expectedRowVersion }) =>
      Effect.gen(function* () {
        const ref = yield* lib.ownedRef(userId, refId)
        if (ref.kind !== "preset" && ref.kind !== "card")
          return yield* refused(ref, "Only presets and cards have regex scripts.")
        yield* steps.checkRowVersion(ref, expectedRowVersion)
        const head = yield* lib.loadDoc(ref.head_revision_id)
        const message = approved ? "Allowed the regex scripts to run" : "Stopped the regex scripts from running"
        return yield* userEdit(ref, { ...head, regex_approved: approved }, message, null)
      }).pipe(transaction(sql, "SetRegexApproval")),

    SetCardAvatar: ({ userId, refId, expectedRowVersion, media }) =>
      Effect.gen(function* () {
        const ref = yield* lib.ownedRef(userId, refId)
        if (ref.kind !== "card") return yield* refused(ref, "Only cards have avatars.")
        yield* steps.checkRowVersion(ref, expectedRowVersion)
        const head = yield* lib.loadDoc(ref.head_revision_id)
        const mediaId = yield* steps.recordMedia(userId, media)
        return yield* userEdit(ref, { ...head, avatar_media_id: mediaId }, "Changed the avatar", null)
      }).pipe(transaction(sql, "SetCardAvatar")),

    CreateCardNote: ({ userId, cardRefId, title, link, chatNote }) =>
      Effect.gen(function* () {
        const card = yield* lib.ownedRef(userId, cardRefId)
        if (card.kind !== "card") return yield* new NotFound({ entity: "card", id: cardRefId })
        if (chatNote) yield* snippetFork(sql, userId, chatNote.chatId, chatNote.forkId ?? null)
        const linkedTitle = yield* linkTitle(userId, link).pipe(
          chatNote ? inFork(sql, chatNote.chatId, chatNote.forkId, chatNote.slotId) : (effect) => effect
        )
        const label = linkedTitle ?? (title.trim().slice(0, 200) || "Note")
        const note = yield* steps.createUpstream({
          userId,
          kind: "note",
          label,
          subtitle: "",
          doc: steps.encode(newCardNote(card.entity_id as EntityId, label, link)),
          schemaVersion: NOTE_SCHEMA_VERSION,
          origin: "user",
          originRef: null,
          sourcePath: null,
          sourceHash: null
        })
        return toLibraryRef(note)
      }).pipe(transaction(sql, "CreateCardNote")),

    CreateChatNote: ({ userId, chatId, title, link, forkId }) =>
      Effect.gen(function* () {
        const [chat] = yield* sql<{ id: ChatId }>`
          SELECT id FROM chats WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL`
        if (!chat) return yield* new NotFound({ entity: "chat", id: chatId })
        const label = (yield* linkTitle(userId, link)) ?? (title.trim().slice(0, 200) || "Note")
        const note = yield* steps.createUpstream({
          userId,
          kind: "note",
          label,
          subtitle: "",
          doc: steps.encode(newChatNote(chat.id, label, link)),
          schemaVersion: NOTE_SCHEMA_VERSION,
          origin: "user",
          originRef: null,
          sourcePath: null,
          sourceHash: null
        })
        return toLibraryRef(note)
      }).pipe(inFork(sql, chatId, forkId, null), transaction(sql, "CreateChatNote")),

    CreateSharedNote: ({ userId, title, content, fromNoteRefId, chatNote }) =>
      Effect.gen(function* () {
        const from = fromNoteRefId === undefined ? null : yield* noteSlot(userId, fromNoteRefId, chatNote)
        if (from && from.doc.link !== undefined)
          return yield* refused(from.ref, "This note already shows a shared note; unlink it first.")
        if (from && Predicate.isObject(from.doc.owner) && from.doc.owner.shared !== undefined)
          return yield* refused(from.ref, "This is a shared note already.")
        const label = title.trim().slice(0, 200) || (from ? String(from.doc.title ?? "") : "") || "Shared note"
        const shared = yield* steps.createUpstream({
          userId,
          kind: "note",
          label,
          subtitle: "",
          doc: steps.encode(newSharedNote(label, from ? String(from.doc.content ?? "") : content)),
          schemaVersion: NOTE_SCHEMA_VERSION,
          origin: "user",
          originRef: null,
          sourcePath: null,
          sourceHash: null
        })
        // The slot shows the shared note from now on; its own text is ignored while linked.
        if (from) yield* from.write({ ...from.doc, link: shared.entity_id }, "Saved as a shared note")
        return toLibraryRef(shared)
      }).pipe(transaction(sql, "CreateSharedNote")),

    UnlinkNote: ({ userId, noteRefId, chatNote }) =>
      Effect.gen(function* () {
        const slot = yield* noteSlot(userId, noteRefId, chatNote)
        if (typeof slot.doc.link !== "string")
          return yield* refused(slot.ref, "This note isn't linked to a shared note.")
        // The shared note's last revision, in the bin or not.
        const shared = yield* sharedNote(sql, userId, slot.doc.link)
        const { link: _link, ...own } = slot.doc
        const change = yield* slot.write(
          { ...own, content: shared?.content ?? String(slot.doc.content ?? "") },
          "Unlinked from the shared note"
        )
        return change.ref
      }).pipe(
        chatNote ? inFork(sql, chatNote.chatId, chatNote.forkId, chatNote.slotId) : (effect) => effect,
        transaction(sql, "UnlinkNote")
      )
  } satisfies Partial<Parameters<typeof WriteOps.of>[0]>
  return handlers
}

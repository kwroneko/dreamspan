import { chatFork } from "./snippets.ts"
import { inFork } from "./forkState.ts"
import { makeSnippetWrites } from "./snippetWrites.ts"
// The editors' write handlers (ARCHITECTURE.md "Editing the library"). They run in the
// writer worker, each as one transaction, through the library's own steps (libraryWrites.ts),
// so every change flows on to the refs that follow the edited one.
import { NOTE_SCHEMA_VERSION } from "@rp/shared/docs/note.ts"
import { DraftKey, entityDraftTarget } from "@rp/shared/drafts.ts"
import {
  applyDrafts,
  canonicalJson,
  droppedDrafts,
  getAt,
  HELD_FIELD,
  isHeldField,
  keepsRegexApproval,
  newCardNote,
  newChatNote,
  newSharedNote,
  parseField,
  validateDoc,
  withoutGrantedAgentEdits
} from "@rp/shared/editing.ts"
import { type ChatNotePosition, EditConflict, InvalidDocument } from "@rp/shared/editorApi.ts"
import type { ChatId, EntityId, SlotId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import type { Doc, EntityKind } from "@rp/shared/library.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import { CardDoc } from "@rp/shared/docs/card.ts"
import { Schema } from "effect"
import type { Bin } from "./bin.ts"
import { snapCrop } from "@rp/shared/media.ts"
import { editedDoc } from "@rp/shared/presetConditions.ts"
import { heldPromptPaths, parseHeld } from "@rp/shared/presetHeld.ts"
import { Effect, Predicate } from "effect"
import type { SqlClient, SqlError } from "effect/sql"
import { fieldContent, type makeDraftStore } from "./drafts.ts"
import { makeGraphWrites } from "./graphWrites.ts"
import { noteHere } from "./noteAt.ts"
import { replacementConflict } from "./noteReplacementWrites.ts"
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
    readonly origin: "import" | "user" | "merge" | "generation"
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
    readonly origin: "user" | "import" | "generation"
    readonly originRef: string | null
    readonly sourcePath: string | null
    readonly sourceHash: string | null
    readonly message?: string | null
  }) => Sql<RefRow>
  /** A fork, every kind's: a new entity from a revision of `ref`'s (its head by default). */
  readonly forkEntity: (options: {
    readonly userId: UserId
    readonly ref: RefRow
    readonly label: string
    readonly subtitle: string
    readonly source?: string
    readonly doc?: Doc
    readonly message?: string
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

export const makeEditorWriteHandlers = (steps: LibrarySteps, bin: Bin) => {
  const { sql, lib, drafts } = steps

  /** The user's own change to a ref: a new revision on its head, passed on to its followers. */
  const userEdit = (
    ref: RefRow,
    doc: Doc,
    message: string | null,
    originRef: string | null,
    origin: "user" | "generation" = "user"
  ) =>
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
        origin,
        originRef,
        message
      })
      yield* steps.moveHead(ref.id, id, null)
      return yield* steps.changed(ref.id)
    })

  bin.assetRestorers.set("card_asset", (userId, origin) =>
    Effect.gen(function* () {
      const ref = yield* lib.ownedRef(userId, String(origin.refId))
      if (ref.kind !== "card" || ref.entity_id !== origin.entityId)
        return yield* new NotFound({ entity: "card", id: String(origin.refId) })
      const head = Schema.decodeUnknownSync(CardDoc)(yield* lib.loadDoc(ref.head_revision_id))
      const asset = Schema.decodeUnknownSync(CardDoc.fields.assets)([origin.asset])![0]!
      if (head.assets?.some((a) => a.uri === asset.uri)) return
      const assets = [...(head.assets ?? [])]
      assets.splice(Math.min(assets.length, Number(origin.index)), 0, asset)
      yield* userEdit(
        ref,
        { ...head, assets, asset_media_ids: { ...head.asset_media_ids, [asset.uri]: String(origin.mediaId) } },
        "Restored a gallery image",
        null
      )
    })
  )

  /**
   * A chat's note edited from a position: a revision on the one bound there, and the binding
   * event from there on, on that branch (DESIGN §3.4), leaving the library head and sibling
   * branches as they are.
   */
  const chatNoteEdit = (
    userId: UserId,
    ref: RefRow,
    doc: Doc,
    message: string | null,
    position: ChatNotePosition,
    origin: "user" | "generation" = "user",
    originRef: string | null = null,
    /** Where it's edited, as `noteHere` resolved it: its branch's latest message. */
    at: { readonly fork: string; readonly tip: string | null } | null = null
  ) =>
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
        origin,
        originRef,
        message
      })
      // From the branch's latest message on: an edit is tied to the chat's current state.
      const graph = makeGraphWrites(sql, drafts)
      yield* graph.insertStateEvent(
        userId,
        position.chatId,
        at === null ? position.slotId : (at.tip as SlotId | null),
        null,
        null,
        { key: "note.binding", value: { note: ref.entity_id as EntityId, revision: revision as never } },
        at?.fork ?? position.forkId ?? null
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
      const resolved = chat && position ? yield* noteHere(sql, lib, userId, owned, position) : null
      const ref = resolved?.ref ?? owned
      const doc = resolved?.doc ?? head
      const write = (next: Doc, message: string) =>
        resolved && position
          ? chatNoteEdit(userId, ref, next, message, position, "user", null, resolved)
          : userEdit(ref, next, message, null)
      return { ref, doc, write }
    })

  /** A revision of the ref's own entity, or none. */
  const entityRevision = (ref: RefRow, revisionId: string) =>
    sql<{ doc_json: string; schema_version: number; created_at: number }>`
      SELECT doc_json, schema_version, created_at FROM entity_revisions
      WHERE id = ${revisionId} AND entity_id = ${ref.entity_id}`.pipe(Effect.map(([row]) => row ?? null))

  const refused = (ref: RefRow, reason: string) => new RefOperationRefused({ refId: ref.id, reason })

  /** A ref's fields changed since its last revision, the held structural changes aside. */
  const liveDrafts = (userId: UserId, target: string) =>
    Effect.gen(function* () {
      const fields = yield* sql<{ field: string }>`SELECT field FROM drafts WHERE user_id = ${userId}
        AND target_kind = 'entity_field' AND target_id = ${target} AND status = 'active' ORDER BY field`
      const rows = []
      for (const { field } of fields) {
        if (isHeldField(field)) continue
        const row = yield* drafts.find(userId, new DraftKey({ targetKind: "entity_field", targetId: target, field }))
        if (row !== null) rows.push(row)
      }
      return rows
    })

  /** An entity's upstream ref, the user's own; null if there's none. */
  const upstreamRef = (userId: UserId, entity: string) =>
    sql<{ id: string }>`SELECT r.id FROM entity_refs r JOIN entities e ON e.id = r.entity_id
      WHERE r.entity_id = ${entity} AND e.owner_user_id = ${userId} LIMIT 1`.pipe(
      Effect.map(([row]) => row?.id ?? null)
    )

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
        const resolved = chatNote ? yield* noteHere(sql, lib, userId, owned, chatNote) : null
        const ref = resolved?.ref ?? owned
        // A chat's own note's drafts are its branch's.
        const target = entityDraftTarget(refId, resolved?.scope)
        for (const { draftId } of fields) yield* drafts.checkIdentity(userId, draftId)
        yield* steps.checkRowVersion(ref, expectedRowVersion)
        const head = editedDoc(ref.kind, resolved?.doc ?? (yield* lib.loadDoc(ref.head_revision_id)))
        const rows = []
        // The held structural changes go in only as the bar's Save applies them, as other fields.
        for (const { field, draftId, expectedRowVersion: expected } of fields.filter((f) => !isHeldField(f.field))) {
          const row = yield* drafts.find(userId, new DraftKey({ targetKind: "entity_field", targetId: target, field }))
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
        const dropped = droppedDrafts(ref.kind, applied.doc, valid.doc, kept)
        if (dropped.length > 0) {
          return yield* new InvalidDocument({
            problems: dropped.map(({ field }) => `${field}: a ${ref.kind} has no such field, so this can't be saved.`)
          })
        }
        // A note's condition cards and link name only the user's own (§14.3).
        if (ref.kind === "note") yield* steps.checkReferences(userId, valid.doc)
        if (ref.kind === "note") {
          const conflict = yield* replacementConflict(sql, userId, ref.entity_id, valid.doc, chatNote, head)
          if (conflict) return yield* new InvalidDocument({ problems: [conflict] })
        }
        const change = yield* chatNote
          ? chatNoteEdit(userId, ref, valid.doc, message, chatNote, "user", null, resolved)
          : userEdit(ref, valid.doc, message, null)
        let recovered = 0
        const recoveredFields: Array<string> = []
        for (const row of rows) {
          const orphan = orphans.has(row.field)
          const ended = yield* drafts.end(row, orphan ? "discarded" : "committed", change.ref.headRevisionId)
          // A set-aside draft is reported as such; what the others' sessions lost is counted.
          if (!orphan && ended.recovered > 0) {
            recovered += ended.recovered
            recoveredFields.push(row.field)
          }
        }
        return new RefChange({ ...change, setAside: [...orphans], recovered, recoveredFields })
      }).pipe(transaction(sql, "CommitEditorDrafts")),

    RestoreRevision: ({ userId, refId, revisionId, expectedRowVersion, chatNote }) =>
      Effect.gen(function* () {
        const owned = yield* lib.ownedRef(userId, refId)
        // A chat's own note is restored on its branch, from the position on, as its Save writes.
        const resolved = chatNote ? yield* noteHere(sql, lib, userId, owned, chatNote) : null
        const ref = resolved?.ref ?? owned
        yield* steps.checkRowVersion(ref, expectedRowVersion)
        const earlier = yield* entityRevision(ref, revisionId)
        if (earlier === null) return yield* new NotFound({ entity: "revision", id: revisionId })
        if (earlier.schema_version !== (yield* steps.revision(ref.head_revision_id)).schema_version) {
          return yield* refused(ref, "That revision is of another schema version, and documents can't be migrated yet.")
        }
        const head = resolved?.doc ?? (yield* lib.loadDoc(ref.head_revision_id))
        // A permission revoked since doesn't come back with the old revision.
        let doc = withoutGrantedAgentEdits(ref.kind, head, JSON.parse(earlier.doc_json) as Doc)
        // An old revision's scripts, an import's say, don't come back approved.
        if ((ref.kind === "preset" || ref.kind === "card") && doc.regex_approved === true) {
          if (!keepsRegexApproval(head, doc)) doc = { ...doc, regex_approved: false }
        }
        const saved = new Date(earlier.created_at).toISOString().replace("T", " ").slice(0, 16)
        const message = `Restored the revision of ${saved} UTC`
        const origin = JSON.stringify({ restored: revisionId })
        if (ref.kind === "note") {
          const conflict = yield* replacementConflict(sql, userId, ref.entity_id, doc, chatNote, head)
          if (conflict) return yield* refused(ref, conflict)
        }
        const change =
          resolved && chatNote
            ? yield* chatNoteEdit(userId, ref, doc, message, chatNote, "user", origin, resolved)
            : yield* userEdit(ref, doc, message, origin)
        // Live text is what's shown and sent: the fields changed since their last revision take
        // the restored text too, as a new state of their edit history, so nothing typed is lost.
        const restored = editedDoc(ref.kind, doc)
        for (const row of yield* liveDrafts(userId, entityDraftTarget(refId, resolved?.scope))) {
          const content = fieldContent(restored, row.field)
          if (content !== null) yield* drafts.settleOn(row, content, change.ref.headRevisionId)
        }
        return change
      }).pipe(transaction(sql, "RestoreRevision")),

    RevertEditorDrafts: ({ userId, refId, chatNote }) =>
      Effect.gen(function* () {
        const owned = yield* lib.ownedRef(userId, refId)
        const resolved = chatNote ? yield* noteHere(sql, lib, userId, owned, chatNote) : null
        const ref = resolved?.ref ?? owned
        const head = editedDoc(ref.kind, resolved?.doc ?? (yield* lib.loadDoc(ref.head_revision_id)))
        let reverted = 0
        for (const row of yield* liveDrafts(userId, entityDraftTarget(refId, resolved?.scope))) {
          const content = fieldContent(head, row.field)
          if (content === null) continue
          yield* drafts.settleOn(row, content, ref.head_revision_id)
          reverted++
        }
        return { reverted }
      }).pipe(transaction(sql, "RevertEditorDrafts")),

    CheckpointLiveText: ({ userId, chatId, forkId, slotId, versionId, summary, leafSlotId, message, used }) =>
      Effect.gen(function* () {
        const usedBy = JSON.stringify({
          usedBy: { chatId, forkId, slotId, versionId, message, ...(summary ? { summary } : {}) }
        })
        const seen = new Set<string>()
        let cut = 0
        for (const entry of used) {
          const refId = entry.ref ?? (yield* upstreamRef(userId, entry.entity))
          if (refId === null || seen.has(refId)) continue
          seen.add(refId)
          // Nothing typed (on any branch): nothing to cut, without reading the entry.
          const [typed] = yield* sql<{ one: number }>`SELECT 1 AS one FROM drafts WHERE user_id = ${userId}
            AND target_kind = 'entity_field' AND status = 'active'
            AND (target_id = ${refId} OR (target_id > ${refId} || '/' AND target_id < ${refId} || '0')) LIMIT 1`
          if (!typed) continue
          const owned = yield* lib.ownedRef(userId, refId).pipe(Effect.catchTag("NotFound", () => Effect.succeed(null)))
          if (owned === null) continue
          const ownedHead = yield* lib.loadDoc(owned.head_revision_id)
          const position: ChatNotePosition = { chatId, forkId, slotId: leafSlotId }
          const chatNote =
            owned.kind === "note" && Predicate.isObject(ownedHead.owner) && ownedHead.owner.chat === chatId
          const resolved = chatNote
            ? yield* noteHere(sql, lib, userId, owned, position).pipe(
                Effect.catchTag("NotFound", () => Effect.succeed(null))
              )
            : null
          const ref = resolved?.ref ?? owned
          // A chat's own note's live text is its branch's (typed at its latest message; what's
          // typed at an earlier message is saved there by its Save).
          const target = entityDraftTarget(refId, resolved?.fork)
          const drafted = yield* liveDrafts(userId, target)
          // A prompt added behind a preset's unsaved bar waits for its Save, definition and all
          // (presetHeld.ts): it isn't sent, and Revert takes it away.
          const heldRow =
            owned.kind === "preset"
              ? yield* drafts.find(
                  userId,
                  new DraftKey({ targetKind: "entity_field", targetId: target, field: HELD_FIELD })
                )
              : null
          const held = heldPromptPaths(parseHeld(heldRow?.status === "active" ? heldRow.content : null))
          const rows = drafted.filter((row) => {
            const path = parseField(row.field)?.path
            return !held.some((at) => path !== undefined && at.every((part, i) => path[i] === part))
          })
          if (rows.length === 0) continue
          // It read the entry as it is now: one a chat pinned to an earlier revision isn't live.
          if (ref.head_revision_id !== entry.revision) continue
          const head = editedDoc(ref.kind, resolved?.doc ?? ownedHead)
          // What's in something gone (a deleted prompt's text) waits for the editor's Save to set it aside.
          const orphans = new Set(
            applyDrafts(ref.kind, head, rows)
              .problems.filter((problem) => problem.orphan)
              .map((problem) => problem.field)
          )
          const kept = rows.filter((row) => !orphans.has(row.field))
          const applied = applyDrafts(ref.kind, head, kept)
          if (applied.problems.length > 0) continue
          const valid = validateDoc(ref.kind, applied.doc)
          // A draft that wouldn't make a valid document leaves the entry as saved: Save says why.
          if (!valid.ok || droppedDrafts(ref.kind, applied.doc, valid.doc, kept).length > 0) continue
          if (ref.kind === "note") {
            const checked = yield* steps.checkReferences(userId, valid.doc).pipe(
              Effect.as(true),
              Effect.catchTag("NotFound", () => Effect.succeed(false))
            )
            if (!checked) continue
            if (
              yield* replacementConflict(sql, userId, ref.entity_id, valid.doc, resolved ? position : undefined, head)
            )
              continue
          }
          const change = resolved
            ? yield* chatNoteEdit(userId, ref, valid.doc, null, position, "generation", usedBy)
            : yield* userEdit(ref, valid.doc, null, usedBy, "generation")
          if (change.ref.headRevisionId !== ref.head_revision_id) cut++
          for (const row of kept) yield* drafts.end(row, "committed", change.ref.headRevisionId)
        }
        return { cut }
      }).pipe(transaction(sql, "CheckpointLiveText")),

    SetRevisionMessage: ({ userId, refId, revisionId, message }) =>
      Effect.gen(function* () {
        const ref = yield* lib.ownedRef(userId, refId)
        const [row] = yield* sql<{ id: string }>`SELECT id FROM entity_revisions
          WHERE id = ${revisionId} AND entity_id IN (${ref.entity_id}, coalesce((SELECT forked_from_entity_id FROM entities WHERE id = ${ref.entity_id}), ''))`
        if (!row) return yield* new NotFound({ entity: "revision", id: revisionId })
        const label = message?.trim() ?? ""
        yield* sql`UPDATE entity_revisions SET message = ${label === "" ? null : label} WHERE id = ${revisionId}`
      }).pipe(transaction(sql, "SetRevisionMessage")),

    ForkWithDrafts: ({ userId, refId, label, subtitle, moveDrafts }) =>
      Effect.gen(function* () {
        const ref = yield* lib.ownedRef(userId, refId)
        if (ref.kind === "card") return yield* refused(ref, "Cards fork with their names (ForkCard).")
        const fork = yield* steps.forkEntity({ userId, ref, label, subtitle })
        if (moveDrafts) {
          yield* drafts.moveFields(userId, refId, fork.id)
          // Typed on the revision copied: the fork's first revision is the same content, and its own.
          yield* sql`UPDATE drafts SET base_revision = ${fork.head_revision_id}
            WHERE user_id = ${userId} AND target_kind = 'entity_field' AND target_id = ${fork.id}
              AND status = 'active' AND base_revision = ${ref.head_revision_id}`
        }
        return toLibraryRef(yield* steps.reload(fork.id))
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

    // The cutout goes with its image (ARCHITECTURE.md §14.5c): a new image takes the one chosen
    // for it, or none (the default), never the old image's.
    AddCardAsset: ({ userId, refId, expectedRowVersion, media, name }) =>
      Effect.gen(function* () {
        const ref = yield* lib.ownedRef(userId, refId)
        if (ref.kind !== "card") return yield* refused(ref, "Only cards have galleries.")
        yield* steps.checkRowVersion(ref, expectedRowVersion)
        const head = Schema.decodeUnknownSync(CardDoc)(yield* lib.loadDoc(ref.head_revision_id))
        const mediaId = yield* steps.recordMedia(userId, media)
        const ext =
          (
            {
              "image/png": "png",
              "image/jpeg": "jpg",
              "image/webp": "webp",
              "image/gif": "gif",
              "image/avif": "avif",
              "image/bmp": "bmp"
            } as Record<string, string>
          )[media.mime] ?? "png"
        const uri = `embeded://assets/other/images/${uuidv7()}.${ext}`
        return yield* userEdit(
          ref,
          {
            ...head,
            assets: [...(head.assets ?? []), { type: "other", uri, name, ext }],
            asset_media_ids: { ...head.asset_media_ids, [uri]: mediaId }
          },
          "Added a gallery image",
          null
        )
      }).pipe(transaction(sql, "AddCardAsset")),

    ChangeCardAsset: ({ userId, refId, expectedRowVersion, uri, change }) =>
      Effect.gen(function* () {
        const ref = yield* lib.ownedRef(userId, refId)
        if (ref.kind !== "card") return yield* refused(ref, "Only cards have galleries.")
        yield* steps.checkRowVersion(ref, expectedRowVersion)
        const head = Schema.decodeUnknownSync(CardDoc)(yield* lib.loadDoc(ref.head_revision_id))
        const assets = [...(head.assets ?? [])]
        const index = assets.findIndex(
          (a) => a.uri === uri && !(a.type.toLowerCase() === "icon" && a.name.toLowerCase() === "main")
        )
        const asset = assets[index]
        const mediaId = head.asset_media_ids?.[uri]
        if (!asset || !mediaId) return yield* new NotFound({ entity: "gallery image", id: uri })
        const ids = { ...head.asset_media_ids }
        let doc = { ...head, assets, asset_media_ids: ids }
        if (change.action === "rename") {
          if (asset.type.toLowerCase() === "icon" && change.name.toLowerCase() === "main")
            return yield* refused(ref, "Main is reserved for the current portrait.")
          assets[index] = { ...asset, name: change.name }
        } else if (change.action === "kind") {
          if (change.kind === "icon" && asset.name.toLowerCase() === "main")
            return yield* refused(ref, "Rename this image before making it an alternative portrait.")
          assets[index] = { ...asset, type: change.kind }
        } else if (change.action === "portrait") {
          if (asset.type.toLowerCase() !== "icon") return yield* refused(ref, "Choose an alternative portrait.")
          // The old portrait takes the alternative's slot and name; the new one is main.
          assets.splice(index, 1)
          const main = assets.findIndex((a) => a.type.toLowerCase() === "icon" && a.name.toLowerCase() === "main")
          const replacementIndex = main >= 0 && main < index ? index - 1 : index
          if (main >= 0) {
            delete ids[assets[main]!.uri]
            assets.splice(main, 1)
          }
          delete ids[uri]
          if (head.avatar_media_id) {
            const oldUri = `embeded://assets/icon/images/${uuidv7()}.${asset.ext}`
            const [old] = yield* sql<{ mime: string }>`SELECT mime FROM media_assets WHERE id = ${head.avatar_media_id}`
            const ext =
              (
                { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" } as Record<
                  string,
                  string
                >
              )[old?.mime ?? ""] ?? "png"
            const oldAsset = { ...asset, uri: oldUri.replace(/\.[^.]*$/, `.${ext}`), ext }
            assets.splice(Math.min(replacementIndex, assets.length), 0, oldAsset)
            ids[oldAsset.uri] = head.avatar_media_id
          }
          assets.push({ ...asset, name: "main" })
          ids[uri] = mediaId
          const { avatar_crop: _crop, ...withoutCrop } = doc
          doc = { ...withoutCrop, avatar_media_id: mediaId }
        } else {
          const item = yield* bin.insertItem({
            userId,
            kind: "card_asset",
            targetId: uuidv7(),
            chatId: null,
            title: asset.name || "Gallery image",
            excerpt: head.name,
            origin: { refId, entityId: ref.entity_id, asset, index, mediaId },
            byteSize: JSON.stringify(asset).length
          })
          assets.splice(index, 1)
          delete ids[uri]
          yield* bin.evictDeleted(userId, item)
        }
        return yield* userEdit(
          ref,
          doc,
          change.action === "portrait" ? "Changed the portrait" : "Changed a gallery image",
          null
        )
      }).pipe(transaction(sql, "ChangeCardAsset")),

    SetCardAvatar: ({ userId, refId, expectedRowVersion, media, crop }) =>
      Effect.gen(function* () {
        const ref = yield* lib.ownedRef(userId, refId)
        if (ref.kind !== "card") return yield* refused(ref, "Only cards have avatars.")
        yield* steps.checkRowVersion(ref, expectedRowVersion)
        const { avatar_crop: _replaced, ...head } = yield* lib.loadDoc(ref.head_revision_id)
        const mediaId = yield* steps.recordMedia(userId, media)
        const doc = {
          ...head,
          avatar_media_id: mediaId,
          ...(crop === undefined ? {} : { avatar_crop: { media_id: mediaId, ...snapCrop(crop) } })
        }
        return yield* userEdit(ref, doc, "Changed the avatar", null)
      }).pipe(transaction(sql, "SetCardAvatar")),

    SetCardAvatarCrop: ({ userId, refId, expectedRowVersion, crop }) =>
      Effect.gen(function* () {
        const ref = yield* lib.ownedRef(userId, refId)
        if (ref.kind !== "card") return yield* refused(ref, "Only cards have avatars.")
        yield* steps.checkRowVersion(ref, expectedRowVersion)
        const { avatar_crop: _replaced, ...head } = yield* lib.loadDoc(ref.head_revision_id)
        const mediaId = head.avatar_media_id
        if (typeof mediaId !== "string") return yield* refused(ref, "This card has no avatar to cut out.")
        const doc = crop === null ? head : { ...head, avatar_crop: { media_id: mediaId, ...snapCrop(crop) } }
        const message = crop === null ? "Reset the avatar's cutout" : "Changed the avatar's cutout"
        return yield* userEdit(ref, doc, message, null)
      }).pipe(transaction(sql, "SetCardAvatarCrop")),

    CreateCardNote: ({ userId, cardRefId, title, link, chatNote }) =>
      Effect.gen(function* () {
        const card = yield* lib.ownedRef(userId, cardRefId)
        if (card.kind !== "card") return yield* new NotFound({ entity: "card", id: cardRefId })
        if (chatNote) yield* chatFork(sql, userId, chatNote.chatId, chatNote.forkId ?? null)
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

    CreateChatNote: ({ userId, chatId, title, link, forkId, replaces, content }) =>
      Effect.gen(function* () {
        const [chat] = yield* sql<{ id: ChatId }>`
          SELECT id FROM chats WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL`
        if (!chat) return yield* new NotFound({ entity: "chat", id: chatId })
        const label = (yield* linkTitle(userId, link)) ?? (title.trim().slice(0, 200) || "Note")
        const doc = {
          ...newChatNote(chat.id, label, link),
          ...(content === undefined ? {} : { content }),
          ...(replaces === undefined ? {} : { replaces })
        }
        yield* steps.checkReferences(userId, doc)
        // A new note's initial head is visible in every fork (until bound differently).
        const conflict = yield* replacementConflict(sql, userId, null, doc)
        if (conflict) return yield* new InvalidDocument({ problems: [conflict] })
        const note = yield* steps.createUpstream({
          userId,
          kind: "note",
          label,
          subtitle: "",
          doc: steps.encode(doc),
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

// The editors' RPC handlers (@dreamspan/shared/editorApi.ts). Every handler acts as the
// authenticated user, and storage enforces ownership, so another user's ids are NotFound.
// Documents from the client are validated against their kind's schema here or in the writer.
import { type AppApi, CurrentUser } from "@dreamspan/shared/api.ts"
import { PRESET_SCHEMA_VERSION, type PresetDoc, promptPreset } from "@dreamspan/shared/docs/preset.ts"
import { convertToWorkshop, goneReplacements } from "@dreamspan/shared/workshopPreset.ts"
import { builtinPreset } from "../db/assemblySources.ts"
import { CARD_SCHEMA_VERSION } from "@dreamspan/shared/docs/card.ts"
import { LOREBOOK_SCHEMA_VERSION, type LorebookDoc } from "@dreamspan/shared/docs/lorebook.ts"
import { type Draft, DraftKey, entityDraftTarget } from "@dreamspan/shared/drafts.ts"
import { newCardDoc, parseField, validateDoc } from "@dreamspan/shared/editing.ts"
import { EditRefused, type ForkMergeApi, InvalidDocument, SavedRef } from "@dreamspan/shared/editorApi.ts"
import { NotFound, ServerError } from "@dreamspan/shared/errors.ts"
import type { RefId } from "@dreamspan/shared/library.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { Effect } from "effect"
import { RpcClientError } from "effect/rpc"
import { Notices } from "../chat/Notices.ts"
import { ChatHub } from "../chat/ChatHub.ts"
import { CacheWarmth } from "../chat/CacheWarmth.ts"
import { Reader, Writer } from "../db/Database.ts"
import { DraftTooLarge, type RefChange, RefOperationRefused, StorageError } from "../db/ops.ts"
import { remoteEntityId, remoteOf, SourceFailed } from "@dreamspan/shared/cardSources.ts"
import { cardNames } from "@dreamspan/shared/cardNames.ts"
import { EditorSnapshot } from "@dreamspan/shared/editorApi.ts"
import { type Doc, LibraryRef, type RevisionId } from "@dreamspan/shared/library.ts"
import { editedDoc } from "@dreamspan/shared/presetConditions.ts"
import type { User } from "@dreamspan/shared/domain.ts"
import { Option } from "effect"
import { CardSources } from "../sources/CardSources.ts"
import { draftBaseKey } from "../sources/cache.ts"

type Internal = StorageError | RpcClientError.RpcClientError

const isInternal = <E>(error: E): error is Extract<E, Internal> =>
  error instanceof StorageError || error instanceof RpcClientError.RpcClientError

/**
 * Storage and worker failures become ServerError, logged here; a refusal from storage
 * becomes EditRefused with its reason. Every other error keeps its tag.
 */
const settle =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.catchIf(effect, isInternal, (error) =>
      Effect.logError(`${operation} failed`, error).pipe(
        Effect.andThen(Effect.fail(new ServerError({ message: `${operation} failed` })))
      )
    ).pipe(
      Effect.catchIf(
        (error): error is Extract<typeof error, RefOperationRefused | DraftTooLarge> =>
          error instanceof RefOperationRefused || error instanceof DraftTooLarge,
        (error) =>
          Effect.fail(
            new EditRefused({
              message:
                error instanceof DraftTooLarge
                  ? `This text is too long to keep: at most ${error.max} characters.`
                  : error.reason
            })
          )
      )
    ) as Effect.Effect<A, Settled<E>, R>

type Refusal = RefOperationRefused | DraftTooLarge
type Settled<E> =
  Exclude<E, Internal | Refusal> | ServerError | ([Extract<E, Refusal>] extends [never] ? never : EditRefused)

const saved = (change: RefChange) =>
  new SavedRef({
    ref: change.ref,
    followers: change.followers.map(({ refId, outcome }) => ({ refId, outcome })),
    setAside: change.setAside ?? [],
    recovered: change.recovered ?? 0,
    recoveredFields: change.recoveredFields ?? []
  })

/** A field's draft; a chat's own note's are its branch's (`scope`, from `OpenEditor`). */
const draftKey = (refId: RefId, field: string, scope?: string) =>
  new DraftKey({ targetKind: "entity_field", targetId: entityDraftTarget(refId, scope), field })

/** Only fields that name a place in a document get drafts. */
const checkField = (field: string) =>
  parseField(field) === null
    ? Effect.fail(new EditRefused({ message: "That isn't a field of a document." }))
    : Effect.void

export const makeSharedNoteRefsHandlers = Effect.map(Reader, (reader) => ({
  ListSharedNoteRefs: () =>
    Effect.flatMap(CurrentUser, (user) => reader.ListSharedNoteRefs({ userId: user.id })).pipe(
      settle("ListSharedNoteRefs")
    )
}))

export const makeEditorHandlers = Effect.gen(function* () {
  const notices = yield* Notices
  const hub = yield* ChatHub
  const reader = yield* Reader
  const writer = yield* Writer
  const warmth = yield* CacheWarmth
  const userId = Effect.map(CurrentUser, (user) => user.id)
  /** What a chat sends may have changed: its cache estimate is worked out again. */
  const changed =
    (id: UserId) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.tap(effect, () => warmth.refreshUser(id))

  const userKey = (targetId: string, field: string) => new DraftKey({ targetKind: "user_field", targetId, field })
  const draftOwner = (ownerId: UserId) =>
    Effect.flatMap(userId, (id) =>
      id === ownerId ? Effect.succeed(id) : Effect.fail(new NotFound({ entity: "draft owner", id: ownerId }))
    )
  const draftChanged =
    (id: UserId) =>
    <E, R>(effect: Effect.Effect<Draft, E, R>) =>
      Effect.tap(effect, (draft) => Effect.sync(() => notices.publish(id, { _tag: "UserDraftChanged", draft })))
  // A card on a card source before it's added (spec/CARD-SOURCES.md §4.3): its editor opens
  // under the placeholder id (`src:<source>:<remote>`) on the cached document, and its edits are
  // `remote_card` drafts until Save adds the card with them as its revision 2. Once the user has
  // the card, the placeholder stands for theirs, so an editor still open on it carries on.
  const sources = yield* Effect.serviceOption(CardSources)
  const remoteKey = (from: { sourceId: string; remoteId: string }, field: string) =>
    new DraftKey({ targetKind: "remote_card", targetId: `${from.sourceId}:${from.remoteId}`, field })
  const saveRemoteDraft = <E, R>(
    user: User,
    from: { sourceId: string; remoteId: string },
    write: Effect.Effect<Draft, E, R>
  ) =>
    Option.isSome(sources)
      ? sources.value.cache.withDraftBases([draftBaseKey(user.id, from)], write, (draft) => draft.status === "active")
      : write
  const fromSource = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.catchIf(
      effect,
      (error): error is Extract<E, SourceFailed> => error instanceof SourceFailed,
      (error) => Effect.fail(new ServerError({ message: error.message }))
    )
  const cardSources = (refId: string) =>
    Option.isSome(sources) ? Effect.succeed(sources.value) : Effect.fail(new NotFound({ entity: "ref", id: refId }))
  /** The cached document and the source's summary of a remote card, as its editor shows it. */
  const remoteDoc = (user: User, from: { sourceId: string; remoteId: string }, refId: string) =>
    Effect.gen(function* () {
      const service = yield* cardSources(refId)
      const { summary, docJson, problems } = yield* fromSource(service.card(user, from.sourceId, from.remoteId))
      if (docJson === null) return yield* new ServerError({ message: problems[0] ?? "This card couldn't be read." })
      return { summary, doc: editedDoc("card", JSON.parse(docJson) as Doc) }
    })
  const remoteHandlers: Record<
    string,
    (payload: never, from: { sourceId: string; remoteId: string }, user: User) => Effect.Effect<unknown, unknown>
  > = {
    OpenEditor: ({ refId }: { refId: RefId }, from, user) =>
      Effect.gen(function* () {
        const { summary, doc } = yield* remoteDoc(user, from, refId)
        const names = cardNames(doc)
        return new EditorSnapshot({
          ref: new LibraryRef({
            id: refId,
            entityId: remoteEntityId(from.sourceId, from.remoteId),
            kind: "card",
            parentEntityId: null,
            label: names.displayName || summary.name,
            subtitle: names.version,
            modelName: names.modelName,
            headRevisionId: refId as unknown as RevisionId,
            updateAvailable: false,
            rowVersion: 0,
            updatedAt: Date.now()
          }),
          doc,
          usedByChats: 0,
          drafts: yield* reader.RemoteCardDrafts({ userId: user.id, targetId: `${from.sourceId}:${from.remoteId}` }),
          revisionNumber: 0,
          variants: []
        })
      }),
    SaveEditorDraft: (
      { field, draftId, content, expectedRowVersion, expectedSession }: Parameters<typeof handlers.SaveEditorDraft>[0],
      from,
      user
    ) =>
      Effect.gen(function* () {
        yield* checkField(field)
        return yield* saveRemoteDraft(
          user,
          from,
          writer.SaveDraft({
            userId: user.id,
            key: remoteKey(from, field),
            draftId,
            content,
            expectedRowVersion,
            expectedSession,
            baseRevision: null
          })
        )
      }),
    EditorDraftHistory: ({ field, limit, before }: Parameters<typeof handlers.EditorDraftHistory>[0], from, user) =>
      reader.DraftHistory({
        userId: user.id,
        key: remoteKey(from, field),
        limit,
        ...(before === undefined ? {} : { before })
      }),
    EditorDraftState: ({ field, seq }: Parameters<typeof handlers.EditorDraftState>[0], from, user) =>
      Effect.map(reader.GetDraftState({ userId: user.id, key: remoteKey(from, field), seq }), (state) => state.content),
    RestoreEditorDraft: (
      { refId: _, field, scope: __, ...restore }: Parameters<typeof handlers.RestoreEditorDraft>[0],
      from,
      user
    ) =>
      saveRemoteDraft(
        user,
        from,
        writer.RestoreDraftState({ userId: user.id, key: remoteKey(from, field), ...restore })
      ),
    DiscardEditorDraft: (
      { field, draftId, expectedRowVersion }: Parameters<typeof handlers.DiscardEditorDraft>[0],
      from,
      user
    ) =>
      writer.ClearDraft({
        userId: user.id,
        key: remoteKey(from, field),
        draftId,
        outcome: "discarded",
        expectedRowVersion
      }),
    RevertEditorDrafts: (_payload: unknown, from, user) =>
      writer.RevertRemoteDrafts({ userId: user.id, targetId: `${from.sourceId}:${from.remoteId}` }),
    // Save adds the card, its edits as revision 2 (§4.5, trigger 2).
    CommitEditorDrafts: ({ refId, fields, message }: Parameters<typeof handlers.CommitEditorDrafts>[0], from, user) =>
      Effect.gen(function* () {
        const service = yield* cardSources(refId)
        const prepared = yield* fromSource(service.prepareAdoption(user, from.sourceId, from.remoteId))
        const { change } = yield* service.storingAdoptions(
          [prepared],
          writer.AdoptAndCommitDrafts({ adopt: prepared.payload, fields, message }),
          (result) => [!result.adopted.existing]
        )
        yield* warmth.refreshUser(user.id)
        return saved(change)
      }),
    // A card not added yet has no revisions but the source's, which is what its fields started from.
    ListRevisions: () => Effect.succeed([]),
    GetRevision: ({ refId, revisionId }: Parameters<typeof handlers.GetRevision>[0], from, user) =>
      revisionId === (refId as string)
        ? Effect.map(remoteDoc(user, from, refId), ({ doc }) => doc)
        : Effect.fail(new NotFound({ entity: "revision", id: revisionId })),
    ListCardNotes: () => Effect.succeed([])
  }
  /**
   * The handlers as a remote card's editor reaches them: a placeholder id is the user's card
   * once they have it, else its remote handler, else not found (what needs a saved card).
   */
  const remoteAware = <H extends Record<string, unknown>>(table: H): H =>
    Object.fromEntries(
      Object.entries(table).map(([name, handler]) => [
        name,
        (payload: Record<string, unknown> | undefined, options: unknown) => {
          const refId = payload?.refId ?? payload?.cardRefId
          const from = typeof refId === "string" ? remoteOf(refId) : null
          if (from === null) return (handler as (p: unknown, o: unknown) => unknown)(payload, options)
          const key = payload?.refId !== undefined ? "refId" : "cardRefId"
          return Effect.gen(function* () {
            const user = yield* CurrentUser
            const [held] = yield* reader.HeldRemoteCards({
              userId: user.id,
              sourceId: from.sourceId,
              items: [{ remoteId: from.remoteId, sha256: null }]
            })
            if (held)
              return yield* (handler as (p: unknown, o: unknown) => Effect.Effect<unknown, unknown>)(
                { ...payload, [key]: held.refId },
                options
              )
            const remote = remoteHandlers[name]
            if (remote === undefined) return yield* new NotFound({ entity: "ref", id: refId as string })
            return yield* remote(payload as never, from, user)
          }).pipe(settle(name))
        }
      ])
    ) as H
  const handlers = {
    ListSnippets: (args) =>
      Effect.flatMap(userId, (id) => reader.ListSnippets({ userId: id, ...args })).pipe(settle("ListSnippets")),
    CreateSnippet: (args) =>
      Effect.flatMap(userId, (id) => writer.CreateSnippet({ userId: id, ...args }).pipe(changed(id))).pipe(
        settle("CreateSnippet")
      ),
    SetSnippetScope: (args) =>
      Effect.flatMap(userId, (id) => writer.SetSnippetScope({ userId: id, ...args }).pipe(changed(id))).pipe(
        settle("SetSnippetScope")
      ),
    GetUserDraft: ({ ownerId, targetId, field }) =>
      Effect.flatMap(draftOwner(ownerId), (id) => reader.GetDraft({ userId: id, key: userKey(targetId, field) })).pipe(
        settle("GetUserDraft")
      ),
    SaveUserDraft: ({ ownerId, targetId, field, ...save }) =>
      Effect.flatMap(draftOwner(ownerId), (id) =>
        writer
          .SaveDraft({ userId: id, key: userKey(targetId, field), ...save, baseRevision: null })
          .pipe(draftChanged(id))
      ).pipe(settle("SaveUserDraft")),
    UserDraftHistory: ({ ownerId, targetId, field }) =>
      Effect.flatMap(draftOwner(ownerId), (id) =>
        reader.DraftHistory({ userId: id, key: userKey(targetId, field), limit: 1000 })
      ).pipe(settle("UserDraftHistory")),
    RestoreUserDraft: ({ ownerId, targetId, field, ...restore }) =>
      Effect.flatMap(draftOwner(ownerId), (id) =>
        writer.RestoreDraftState({ userId: id, key: userKey(targetId, field), ...restore }).pipe(draftChanged(id))
      ).pipe(settle("RestoreUserDraft")),
    EndUserDraft: ({ ownerId, targetId, field, ...end }) =>
      Effect.flatMap(draftOwner(ownerId), (id) =>
        writer.ClearDraft({ userId: id, key: userKey(targetId, field), ...end }).pipe(draftChanged(id))
      ).pipe(settle("EndUserDraft")),
    OpenEditor: ({ refId, chatNote }) =>
      Effect.flatMap(userId, (id) => reader.OpenEditor({ userId: id, refId, ...(chatNote ? { chatNote } : {}) })).pipe(
        settle("OpenEditor")
      ),

    CreatePreset: ({ label }) =>
      Effect.gen(function* () {
        const { ref } = yield* writer.CreateEntity({
          userId: yield* userId,
          kind: "preset",
          label,
          subtitle: "",
          doc: promptPreset(builtinPreset),
          schemaVersion: PRESET_SCHEMA_VERSION,
          origin: "user",
          sourcePath: null
        })
        return ref
      }).pipe(settle("CreatePreset")),

    CreateLorebook: ({ label }) =>
      Effect.gen(function* () {
        const doc: LorebookDoc = {
          schema_version: LOREBOOK_SCHEMA_VERSION,
          name: label,
          description: "",
          scan_depth: null,
          token_budget: null,
          recursive_scanning: null,
          extensions: {},
          entries: []
        }
        const { ref } = yield* writer.CreateEntity({
          userId: yield* userId,
          kind: "lorebook",
          label,
          subtitle: "",
          doc,
          schemaVersion: LOREBOOK_SCHEMA_VERSION,
          origin: "user",
          sourcePath: null
        })
        return ref
      }).pipe(settle("CreateLorebook")),

    CreateCard: ({ label, name, nickname, version, description, persona }) =>
      Effect.gen(function* () {
        const valid = validateDoc("card", {
          ...newCardDoc(name),
          nickname: nickname ?? "",
          character_version: version ?? "",
          description: description ?? ""
        })
        if (!valid.ok) return yield* new InvalidDocument({ problems: valid.problems })
        const { ref } = yield* writer.CreateEntity({
          userId: yield* userId,
          kind: "card",
          label,
          subtitle: "",
          doc: valid.doc,
          schemaVersion: CARD_SCHEMA_VERSION,
          origin: "user",
          sourcePath: null,
          tags: persona ? ["persona"] : []
        })
        return ref
      }).pipe(settle("CreateCard")),

    SaveEditorDraft: ({ refId, field, scope, draftId, content, expectedRowVersion, expectedSession, baseRevisionId }) =>
      Effect.gen(function* () {
        yield* checkField(field)
        return yield* writer.SaveDraft({
          userId: yield* userId,
          key: draftKey(refId, field, scope),
          draftId,
          content,
          expectedRowVersion,
          expectedSession,
          baseRevision: baseRevisionId
        })
      }).pipe(settle("SaveEditorDraft")),

    EditorDraftHistory: ({ refId, field, scope, limit, before }) =>
      Effect.flatMap(userId, (id) =>
        reader.DraftHistory({
          userId: id,
          key: draftKey(refId, field, scope),
          limit,
          ...(before === undefined ? {} : { before })
        })
      ).pipe(settle("EditorDraftHistory")),

    EditorDraftState: ({ refId, field, scope, seq }) =>
      Effect.flatMap(userId, (id) =>
        reader.GetDraftState({ userId: id, key: draftKey(refId, field, scope), seq })
      ).pipe(
        Effect.map((state) => state.content),
        settle("EditorDraftState")
      ),

    RevertEditorDrafts: ({ refId, chatNote }) =>
      Effect.flatMap(userId, (id) =>
        writer.RevertEditorDrafts({ userId: id, refId, ...(chatNote ? { chatNote } : {}) })
      ).pipe(settle("RevertEditorDrafts")),

    SetRevisionMessage: ({ refId, revisionId, message }) =>
      Effect.flatMap(userId, (id) => writer.SetRevisionMessage({ userId: id, refId, revisionId, message })).pipe(
        settle("SetRevisionMessage")
      ),

    RestoreEditorDraft: ({ refId, field, scope, ...restore }) =>
      Effect.flatMap(userId, (id) =>
        writer.RestoreDraftState({ userId: id, key: draftKey(refId, field, scope), ...restore })
      ).pipe(settle("RestoreEditorDraft")),

    DiscardEditorDraft: ({ refId, field, scope, draftId, expectedRowVersion }) =>
      Effect.flatMap(userId, (id) =>
        writer.ClearDraft({
          userId: id,
          key: draftKey(refId, field, scope),
          draftId,
          outcome: "discarded",
          expectedRowVersion
        })
      ).pipe(settle("DiscardEditorDraft")),

    CommitEditorDrafts: ({ refId, expectedRowVersion, fields, message, chatNote }) =>
      Effect.flatMap(userId, (id) =>
        writer
          .CommitEditorDrafts({
            userId: id,
            refId,
            expectedRowVersion,
            fields,
            message,
            ...(chatNote ? { chatNote } : {})
          })
          .pipe(changed(id))
      ).pipe(
        // A chat's note changed.
        Effect.tap(() =>
          Effect.sync(() => {
            if (chatNote) hub.publish(chatNote.chatId, { _tag: "State" })
          })
        ),
        Effect.map(saved),
        settle("CommitEditorDrafts")
      ),

    ListRevisions: ({ refId, limit, before, chatNote }) =>
      Effect.flatMap(userId, (id) =>
        reader.RefHistory({
          userId: id,
          refId,
          limit,
          ...(before ? { before } : {}),
          ...(chatNote ? { chatNote } : {})
        })
      ).pipe(settle("ListRevisions")),

    GetRevision: ({ refId, revisionId }) =>
      Effect.flatMap(userId, (id) => reader.GetRevisionDoc({ userId: id, refId, revisionId })).pipe(
        settle("GetRevision")
      ),

    RestoreRevision: ({ refId, revisionId, expectedRowVersion, chatNote }) =>
      Effect.flatMap(userId, (id) =>
        writer
          .RestoreRevision({ userId: id, refId, revisionId, expectedRowVersion, ...(chatNote ? { chatNote } : {}) })
          .pipe(changed(id))
      ).pipe(
        Effect.tap(() => Effect.sync(() => chatNote && hub.publish(chatNote.chatId, { _tag: "State" }))),
        Effect.map(saved),
        settle("RestoreRevision")
      ),

    ForkVariant: ({ refId, label, subtitle, moveDrafts }) =>
      Effect.flatMap(userId, (id) => writer.ForkWithDrafts({ userId: id, refId, label, subtitle, moveDrafts })).pipe(
        settle("ForkVariant")
      ),

    ForkCard: ({ refId, name, nickname, characterVersion }) =>
      Effect.flatMap(userId, (id) => writer.ForkCard({ userId: id, refId, name, nickname, characterVersion })).pipe(
        settle("ForkCard")
      ),

    CardFamilyIndex: () =>
      Effect.flatMap(userId, (id) => reader.CardFamilyIndex({ userId: id })).pipe(settle("CardFamilyIndex")),

    CardFamily: ({ entityId }) =>
      Effect.flatMap(userId, (id) => reader.CardFamily({ userId: id, entityId })).pipe(settle("CardFamily")),

    SetCardParent: ({ entityId, parentEntityId }) =>
      Effect.flatMap(userId, (id) => writer.SetCardParent({ userId: id, entityId, parentEntityId })).pipe(
        settle("SetCardParent")
      ),

    RenameRef: ({ refId, label, subtitle, expectedRowVersion }) =>
      Effect.flatMap(userId, (id) => writer.RenameRef({ userId: id, refId, label, subtitle, expectedRowVersion })).pipe(
        settle("RenameRef")
      ),

    SetRefArchived: ({ refId, archived }) =>
      Effect.flatMap(userId, (id) => writer.SetRefArchived({ userId: id, refId, archived })).pipe(
        settle("SetRefArchived")
      ),

    SetRegexApproval: ({ refId, approved, expectedRowVersion }) =>
      Effect.flatMap(userId, (id) =>
        writer.SetRegexApproval({ userId: id, refId, approved, expectedRowVersion }).pipe(changed(id))
      ).pipe(Effect.map(saved), settle("SetRegexApproval")),

    SetCardAvatarCrop: ({ refId, crop, expectedRowVersion }) =>
      Effect.flatMap(userId, (id) =>
        writer.SetCardAvatarCrop({ userId: id, refId, crop, expectedRowVersion }).pipe(changed(id))
      ).pipe(Effect.map(saved), settle("SetCardAvatarCrop")),

    PreviewUpdate: ({ refId }) =>
      Effect.flatMap(userId, (id) => reader.PreviewMerge({ userId: id, refId })).pipe(settle("PreviewUpdate")),

    ApplyUpdate: ({ refId }) =>
      Effect.flatMap(userId, (id) => writer.MergeFollowed({ userId: id, refId }).pipe(changed(id))).pipe(
        Effect.map(({ outcome, change }) => ({ outcome, saved: saved(change) })),
        settle("ApplyUpdate")
      ),

    // The writer checks the document: valid, protected fields from one side, references owned.
    ResolveUpdate: ({ refId, doc, theirsRevisionId, expectedRowVersion }) =>
      Effect.flatMap(userId, (id) =>
        writer.ResolveMerge({ userId: id, refId, doc, theirsRevisionId, expectedRowVersion }).pipe(changed(id))
      ).pipe(Effect.map(saved), settle("ResolveUpdate")),

    ListCardNotes: ({ cardRefId }) =>
      Effect.flatMap(userId, (id) => reader.ListCardNotes({ userId: id, cardRefId })).pipe(settle("ListCardNotes")),

    CreateCardNote: ({ cardRefId, title, link, chatNote }) =>
      Effect.flatMap(userId, (id) =>
        writer
          .CreateCardNote({
            userId: id,
            cardRefId,
            title,
            ...(chatNote ? { chatNote } : {}),
            ...(link === undefined ? {} : { link })
          })
          .pipe(changed(id))
      ).pipe(settle("CreateCardNote")),

    ListSharedNotes: ({ query, refId, entityId, chatNote }) =>
      Effect.flatMap(userId, (id) =>
        reader.ListSharedNotes({
          userId: id,
          ...(chatNote === undefined ? {} : { chatNote }),
          ...(query === undefined ? {} : { query }),
          ...(refId === undefined ? {} : { refId }),
          ...(entityId === undefined ? {} : { entityId })
        })
      ).pipe(settle("ListSharedNotes")),

    CreateSharedNote: ({ title, content, fromNoteRefId, chatNote }) =>
      Effect.flatMap(userId, (id) =>
        writer
          .CreateSharedNote({
            userId: id,
            title,
            content,
            ...(fromNoteRefId === undefined ? {} : { fromNoteRefId }),
            ...(chatNote === undefined ? {} : { chatNote })
          })
          .pipe(changed(id))
      ).pipe(
        Effect.tap(() => Effect.sync(() => chatNote && hub.publish(chatNote.chatId, { _tag: "State" }))),
        settle("CreateSharedNote")
      ),

    UnlinkNote: ({ noteRefId, chatNote }) =>
      Effect.flatMap(userId, (id) =>
        writer.UnlinkNote({ userId: id, noteRefId, ...(chatNote === undefined ? {} : { chatNote }) }).pipe(changed(id))
      ).pipe(
        Effect.tap(() => Effect.sync(() => chatNote && hub.publish(chatNote.chatId, { _tag: "State" }))),
        settle("UnlinkNote")
      ),

    DeleteNote: ({ noteRefId }) =>
      Effect.gen(function* () {
        const id = yield* userId
        const note = yield* reader.GetLibraryRef({ userId: id, refId: noteRefId })
        if (note.kind !== "note") return yield* new NotFound({ entity: "note", id: noteRefId })
        const item = yield* writer.DeleteEntity({ userId: id, entityId: note.entityId })
        // Notes that showed it send nothing now: open chats read their notes again.
        yield* warmth.refreshUser(id, true)
        return item
      }).pipe(settle("DeleteNote"))
  } satisfies Partial<Parameters<typeof AppApi.of>[0]>
  return remoteAware(handlers)
})

/** Workshop conversion is separate from the core handler group (its type-size bound). */
export const makeWorkshopPresetHandlers = Effect.gen(function* () {
  const reader = yield* Reader
  const writer = yield* Writer
  return {
    ConvertPresetToWorkshop: ({ refId, label, choices, instructions }) =>
      Effect.gen(function* () {
        const owner = (yield* CurrentUser).id
        const source = yield* reader.OpenEditor({ userId: owner, refId })
        if (source.ref.kind !== "preset") return yield* new NotFound({ entity: "preset", id: refId })
        // New text for a prompt the preset no longer has would be dropped: refuse, so it stays.
        const gone = goneReplacements(source.doc as PresetDoc, choices)
        if (gone.length > 0)
          return yield* new InvalidDocument({
            problems: gone.map(
              (choice) =>
                `“${choice.identifier}” was deleted from the preset since you opened this, so the new text you wrote for it can’t go in. Copy it if you want it, then close and reopen this to go on.`
            )
          })
        const { ref } = yield* writer.CreateEntity({
          userId: owner,
          kind: "preset",
          label,
          subtitle: "",
          doc: convertToWorkshop(source.doc as PresetDoc, choices, instructions),
          schemaVersion: PRESET_SCHEMA_VERSION,
          origin: "user",
          sourcePath: null
        })
        return ref
      }).pipe(settle("ConvertPresetToWorkshop"))
  } satisfies Parameters<typeof import("@dreamspan/shared/editorApi.ts").WorkshopPresetApi.of>[0]
})

/** ForkMergeApi's handlers, served by their own layer (AppCoreApi's note). */
export const makeForkMergeHandlers = Effect.gen(function* () {
  const reader = yield* Reader
  const writer = yield* Writer
  const warmth = yield* CacheWarmth
  const userId = Effect.map(CurrentUser, (user) => user.id)
  const changed =
    (id: UserId) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.tap(effect, () => warmth.refreshUser(id))
  return {
    ForkMergeStatus: (input) =>
      Effect.flatMap(userId, (id) => reader.ForkMergeStatus({ userId: id, ...input })).pipe(settle("ForkMergeStatus")),
    PreviewForkMerge: (input) =>
      Effect.flatMap(userId, (id) => reader.PreviewForkMerge({ userId: id, ...input })).pipe(
        settle("PreviewForkMerge")
      ),
    LibraryGenealogy: (input) =>
      Effect.flatMap(userId, (id) => reader.LibraryGenealogy({ userId: id, ...input })).pipe(
        settle("LibraryGenealogy")
      ),
    CommitForkMerge: (input) =>
      Effect.flatMap(userId, (id) => writer.CommitForkMerge({ userId: id, ...input }).pipe(changed(id))).pipe(
        Effect.map(saved),
        settle("CommitForkMerge")
      ),
    UndoForkMerge: (input) =>
      Effect.flatMap(userId, (id) => writer.UndoForkMerge({ userId: id, ...input }).pipe(changed(id))).pipe(
        Effect.map(saved),
        settle("UndoForkMerge")
      )
  } satisfies Parameters<typeof ForkMergeApi.of>[0]
})

export const makeGalleryHandlers = Effect.gen(function* () {
  const reader = yield* Reader
  const writer = yield* Writer
  const warmth = yield* CacheWarmth
  const userId = Effect.map(CurrentUser, (user) => user.id)
  const changed =
    (id: UserId) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.tap(effect, () => warmth.refreshUser(id))
  return {
    GetCardGallery: ({ refId }) =>
      Effect.flatMap(userId, (id) => reader.GetCardGallery({ userId: id, refId })).pipe(settle("GetCardGallery")),
    ChangeCardAsset: (payload) =>
      Effect.flatMap(userId, (id) => writer.ChangeCardAsset({ userId: id, ...payload }).pipe(changed(id))).pipe(
        Effect.map(saved),
        settle("ChangeCardAsset")
      )
  } satisfies Parameters<typeof import("@dreamspan/shared/editorApi.ts").GalleryApi.of>[0]
})

export const makePanelApprovalHandlers = Effect.gen(function* () {
  const writer = yield* Writer
  const warmth = yield* CacheWarmth
  const userId = Effect.map(CurrentUser, (user) => user.id)
  return {
    SetHtmlApproval: ({ refId, scripts, network, expectedRowVersion }) =>
      Effect.flatMap(userId, (id) =>
        writer
          .SetHtmlApproval({
            userId: id,
            refId,
            scripts,
            network,
            ...(expectedRowVersion === undefined ? {} : { expectedRowVersion })
          })
          .pipe(Effect.tap(() => warmth.refreshUser(id)))
      ).pipe(Effect.map(saved), settle("SetHtmlApproval"))
  } satisfies Parameters<typeof import("@dreamspan/shared/editorApi.ts").PanelApprovalApi.of>[0]
})

export const makeCardArchiveHandlers = Effect.gen(function* () {
  const reader = yield* Reader
  const writer = yield* Writer
  const userId = Effect.map(CurrentUser, (user) => user.id)
  return {
    ListArchiveCandidates: ({ criteria }) =>
      Effect.flatMap(userId, (id) => reader.ListArchiveCandidates({ userId: id, criteria })).pipe(
        settle("ListArchiveCandidates")
      ),
    ArchiveUnusedCards: ({ criteria, entityIds }) =>
      Effect.flatMap(userId, (id) => writer.ArchiveUnusedCards({ userId: id, criteria, entityIds })).pipe(
        settle("ArchiveUnusedCards")
      ),
    UndoCardArchive: ({ entityIds, archivedAt }) =>
      Effect.flatMap(userId, (id) => writer.UndoCardArchive({ userId: id, entityIds, archivedAt })).pipe(
        settle("UndoCardArchive")
      )
  } satisfies Parameters<typeof import("@dreamspan/shared/editorApi.ts").CardArchiveApi.of>[0]
})

/** The move has its own small handler group, as the gallery and workshop conversion do. */
export const makeOwnTurnNoteHandlers = Effect.gen(function* () {
  const writer = yield* Writer
  const warmth = yield* CacheWarmth
  return {
    MoveToOwnTurnNote: (args) =>
      Effect.flatMap(CurrentUser, (user) =>
        writer.MoveToOwnTurnNote({ userId: user.id, ...args }).pipe(Effect.tap(() => warmth.refreshUser(user.id)))
      ).pipe(settle("MoveToOwnTurnNote"))
  } satisfies Parameters<typeof import("@dreamspan/shared/editorApi.ts").OwnTurnNoteApi.of>[0]
})

// The editors' RPC handlers (@rp/shared/editorApi.ts). Every handler acts as the
// authenticated user, and storage enforces ownership, so another user's ids are NotFound.
// Documents from the client are validated against their kind's schema here or in the writer.
import { type AppApi, CurrentUser } from "@rp/shared/api.ts"
import { PRESET_SCHEMA_VERSION, promptPreset } from "@rp/shared/docs/preset.ts"
import { builtinPreset } from "../db/assemblySources.ts"
import { CARD_SCHEMA_VERSION } from "@rp/shared/docs/card.ts"
import { DraftKey, entityDraftTarget } from "@rp/shared/drafts.ts"
import { newCardDoc, parseField, validateDoc } from "@rp/shared/editing.ts"
import { EditRefused, InvalidDocument, SavedRef } from "@rp/shared/editorApi.ts"
import { NotFound, ServerError } from "@rp/shared/errors.ts"
import type { RefId } from "@rp/shared/library.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { Effect } from "effect"
import { RpcClientError } from "effect/rpc"
import { Notices } from "../chat/Notices.ts"
import { ChatHub } from "../chat/ChatHub.ts"
import { CacheWarmth } from "../chat/CacheWarmth.ts"
import { Reader, Writer } from "../db/Database.ts"
import { DraftTooLarge, type RefChange, RefOperationRefused, StorageError } from "../db/ops.ts"

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
    <E, R>(effect: Effect.Effect<import("@rp/shared/drafts.ts").Draft, E, R>) =>
      Effect.tap(effect, (draft) => Effect.sync(() => notices.publish(id, { _tag: "UserDraftChanged", draft })))
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

    CreateCard: ({ label, name, nickname, version }) =>
      Effect.gen(function* () {
        const valid = validateDoc("card", {
          ...newCardDoc(name),
          nickname: nickname ?? "",
          character_version: version ?? ""
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
          sourcePath: null
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
        // A chat's note or a non-card chat override changed.
        Effect.tap((change) =>
          Effect.sync(() => {
            const chatId = chatNote?.chatId ?? change.ref.chatId
            if (chatId) hub.publish(chatId, { _tag: "State" })
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
      ),

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
        return yield* writer.DeleteEntity({ userId: id, entityId: note.entityId }).pipe(changed(id))
      }).pipe(settle("DeleteNote"))
  } satisfies Partial<Parameters<typeof AppApi.of>[0]>
  return handlers
})

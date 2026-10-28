// The editors' RPC handlers (@rp/shared/editorApi.ts). Every handler acts as the
// authenticated user, and storage enforces ownership, so another user's ids are NotFound.
// Documents from the client are validated against their kind's schema here or in the writer.
import { type AppApi, CurrentUser } from "@rp/shared/api.ts"
import { CARD_SCHEMA_VERSION } from "@rp/shared/docs/card.ts"
import { DraftKey } from "@rp/shared/drafts.ts"
import { newCardDoc, parseField, validateDoc } from "@rp/shared/editing.ts"
import { EditRefused, InvalidDocument, SavedRef } from "@rp/shared/editorApi.ts"
import { NotFound, ServerError } from "@rp/shared/errors.ts"
import type { RefId } from "@rp/shared/library.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { Effect } from "effect"
import { RpcClientError } from "effect/rpc"
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
    recovered: change.recovered ?? 0
  })

const draftKey = (refId: RefId, field: string) => new DraftKey({ targetKind: "entity_field", targetId: refId, field })

/** Only fields that name a place in a document get drafts. */
const checkField = (field: string) =>
  parseField(field) === null
    ? Effect.fail(new EditRefused({ message: "That isn't a field of a document." }))
    : Effect.void

export const makeEditorHandlers = Effect.gen(function* () {
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

  const handlers = {
    ListSnippets: (args) =>
      Effect.flatMap(userId, (id) => reader.ListSnippets({ userId: id, ...args })).pipe(settle("ListSnippets")),
    CreateSnippet: (args) =>
      Effect.flatMap(userId, (id) => writer.CreateSnippet({ userId: id, ...args }).pipe(changed(id))).pipe(
        settle("CreateSnippet")
      ),
    SaveSnippet: (args) =>
      Effect.flatMap(userId, (id) => writer.SaveSnippet({ userId: id, ...args }).pipe(changed(id))).pipe(
        settle("SaveSnippet")
      ),
    MakeSnippetGlobal: (args) =>
      Effect.flatMap(userId, (id) => writer.MakeSnippetGlobal({ userId: id, ...args }).pipe(changed(id))).pipe(
        settle("MakeSnippetGlobal")
      ),
    OpenEditor: ({ refId, chatNote }) =>
      Effect.flatMap(userId, (id) => reader.OpenEditor({ userId: id, refId, ...(chatNote ? { chatNote } : {}) })).pipe(
        settle("OpenEditor")
      ),

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

    SaveEditorDraft: ({ refId, field, draftId, content, expectedRowVersion, expectedSession, baseRevisionId }) =>
      Effect.gen(function* () {
        yield* checkField(field)
        return yield* writer.SaveDraft({
          userId: yield* userId,
          key: draftKey(refId, field),
          draftId,
          content,
          expectedRowVersion,
          expectedSession,
          baseRevision: baseRevisionId
        })
      }).pipe(settle("SaveEditorDraft")),

    EditorDraftHistory: ({ refId, field, limit }) =>
      Effect.flatMap(userId, (id) => reader.DraftHistory({ userId: id, key: draftKey(refId, field), limit })).pipe(
        settle("EditorDraftHistory")
      ),

    RestoreEditorDraft: ({ refId, field, ...restore }) =>
      Effect.flatMap(userId, (id) =>
        writer.RestoreDraftState({ userId: id, key: draftKey(refId, field), ...restore })
      ).pipe(settle("RestoreEditorDraft")),

    DiscardEditorDraft: ({ refId, field, draftId, expectedRowVersion }) =>
      Effect.flatMap(userId, (id) =>
        writer.ClearDraft({
          userId: id,
          key: draftKey(refId, field),
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

    ListRevisions: ({ refId, limit, before }) =>
      Effect.flatMap(userId, (id) =>
        reader.RefHistory({ userId: id, refId, limit, ...(before ? { before } : {}) })
      ).pipe(settle("ListRevisions")),

    GetRevision: ({ refId, revisionId }) =>
      Effect.flatMap(userId, (id) => reader.GetRevisionDoc({ userId: id, refId, revisionId })).pipe(
        settle("GetRevision")
      ),

    RestoreRevision: ({ refId, revisionId, expectedRowVersion }) =>
      Effect.flatMap(userId, (id) =>
        writer.RestoreRevision({ userId: id, refId, revisionId, expectedRowVersion }).pipe(changed(id))
      ).pipe(Effect.map(saved), settle("RestoreRevision")),

    ForkVariant: ({ refId, label, subtitle, moveDrafts }) =>
      Effect.flatMap(userId, (id) => writer.ForkWithDrafts({ userId: id, refId, label, subtitle, moveDrafts })).pipe(
        settle("ForkVariant")
      ),

    ForkCard: ({ refId, name, nickname, characterVersion, moveDrafts }) =>
      Effect.flatMap(userId, (id) =>
        writer.ForkCard({ userId: id, refId, name, nickname, characterVersion, moveDrafts })
      ).pipe(settle("ForkCard")),

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

    SetRegexApproval: ({ refId, approved, expectedRowVersion }) =>
      Effect.flatMap(userId, (id) =>
        writer.SetRegexApproval({ userId: id, refId, approved, expectedRowVersion }).pipe(changed(id))
      ).pipe(Effect.map(saved), settle("SetRegexApproval")),

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

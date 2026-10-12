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
import { Effect } from "effect"
import { RpcClientError } from "effect/rpc"
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
  const reader = yield* Reader
  const writer = yield* Writer
  const userId = Effect.map(CurrentUser, (user) => user.id)

  const handlers = {
    OpenEditor: ({ refId }) =>
      Effect.flatMap(userId, (id) => reader.OpenEditor({ userId: id, refId })).pipe(settle("OpenEditor")),

    CreateCard: ({ label, name }) =>
      Effect.gen(function* () {
        const valid = validateDoc("card", newCardDoc(name))
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
          draftId: draftId ?? null,
          content,
          expectedRowVersion,
          ...(expectedSession === undefined ? {} : { expectedSession }),
          baseRevision: baseRevisionId
        })
      }).pipe(settle("SaveEditorDraft")),

    EditorDraftHistory: ({ refId, field, limit }) =>
      Effect.flatMap(userId, (id) => reader.DraftHistory({ userId: id, key: draftKey(refId, field), limit })).pipe(
        settle("EditorDraftHistory")
      ),

    RestoreEditorDraft: ({ refId, field, draftId, seq, expectedRowVersion }) =>
      Effect.flatMap(userId, (id) =>
        writer.RestoreDraftState({ userId: id, key: draftKey(refId, field), draftId, seq, expectedRowVersion })
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

    CommitEditorDrafts: ({ refId, expectedRowVersion, fields, message }) =>
      Effect.flatMap(userId, (id) =>
        writer.CommitEditorDrafts({ userId: id, refId, expectedRowVersion, fields, message })
      ).pipe(Effect.map(saved), settle("CommitEditorDrafts")),

    ListRevisions: ({ refId, limit }) =>
      Effect.flatMap(userId, (id) => reader.RefHistory({ userId: id, refId, limit })).pipe(settle("ListRevisions")),

    GetRevision: ({ refId, revisionId }) =>
      Effect.flatMap(userId, (id) => reader.GetRevisionDoc({ userId: id, refId, revisionId })).pipe(
        settle("GetRevision")
      ),

    RestoreRevision: ({ refId, revisionId, expectedRowVersion }) =>
      Effect.flatMap(userId, (id) =>
        writer.RestoreRevision({ userId: id, refId, revisionId, expectedRowVersion })
      ).pipe(Effect.map(saved), settle("RestoreRevision")),

    ForkVariant: ({ refId, label, subtitle, moveDrafts }) =>
      Effect.flatMap(userId, (id) => writer.ForkWithDrafts({ userId: id, refId, label, subtitle, moveDrafts })).pipe(
        settle("ForkVariant")
      ),

    RenameRef: ({ refId, label, subtitle, expectedRowVersion }) =>
      Effect.flatMap(userId, (id) => writer.RenameRef({ userId: id, refId, label, subtitle, expectedRowVersion })).pipe(
        settle("RenameRef")
      ),

    SetRegexApproval: ({ refId, approved, expectedRowVersion }) =>
      Effect.flatMap(userId, (id) => writer.SetRegexApproval({ userId: id, refId, approved, expectedRowVersion })).pipe(
        Effect.map(saved),
        settle("SetRegexApproval")
      ),

    PreviewUpdate: ({ refId }) =>
      Effect.flatMap(userId, (id) => reader.PreviewMerge({ userId: id, refId })).pipe(settle("PreviewUpdate")),

    ApplyUpdate: ({ refId }) =>
      Effect.flatMap(userId, (id) => writer.MergeFollowed({ userId: id, refId })).pipe(
        Effect.map(({ outcome, change }) => ({ outcome, saved: saved(change) })),
        settle("ApplyUpdate")
      ),

    // The writer checks the document: valid, protected fields from one side, references owned.
    ResolveUpdate: ({ refId, doc, theirsRevisionId, expectedRowVersion }) =>
      Effect.flatMap(userId, (id) =>
        writer.ResolveMerge({ userId: id, refId, doc, theirsRevisionId, expectedRowVersion })
      ).pipe(Effect.map(saved), settle("ResolveUpdate")),

    ListCardNotes: ({ cardRefId }) =>
      Effect.flatMap(userId, (id) => reader.ListCardNotes({ userId: id, cardRefId })).pipe(settle("ListCardNotes")),

    CreateCardNote: ({ cardRefId, title }) =>
      Effect.flatMap(userId, (id) => writer.CreateCardNote({ userId: id, cardRefId, title })).pipe(
        settle("CreateCardNote")
      ),

    DeleteCardNote: ({ noteRefId }) =>
      Effect.gen(function* () {
        const id = yield* userId
        const note = yield* reader.GetLibraryRef({ userId: id, refId: noteRefId })
        if (note.kind !== "note") return yield* new NotFound({ entity: "note", id: noteRefId })
        return yield* writer.DeleteEntity({ userId: id, entityId: note.entityId })
      }).pipe(settle("DeleteCardNote"))
  } satisfies Partial<Parameters<typeof AppApi.of>[0]>
  return handlers
})

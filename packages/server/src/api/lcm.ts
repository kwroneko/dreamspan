import { type AppApi, CurrentUser } from "@rp/shared/api.ts"
import { TextTooLong } from "@rp/shared/composerApi.ts"
import { DraftKey } from "@rp/shared/drafts.ts"
import { foldState } from "@rp/shared/state.ts"
import { Effect } from "effect"
import { ChatHub } from "../chat/ChatHub.ts"
import { CacheWarmth } from "../chat/CacheWarmth.ts"
import { Reader, Writer } from "../db/Database.ts"
import { DraftTooLarge } from "../db/ops.ts"
import { internal } from "./internal.ts"

const summaryDraftKey = (summaryId: string) =>
  new DraftKey({ targetKind: "summary_edit", targetId: summaryId, field: "" })

export const makeLcmHandlers = Effect.gen(function* () {
  const reader = yield* Reader
  const writer = yield* Writer
  const warmth = yield* CacheWarmth
  const hub = yield* ChatHub
  const userId = Effect.map(CurrentUser, (user) => user.id)
  /** Summaries or the setting changed: open chats read the layer again, and the estimate is made again. */
  const changed = (chatId: string, id: Parameters<typeof warmth.refreshUser>[0]) =>
    Effect.andThen(
      Effect.sync(() => hub.publish(chatId as never, { _tag: "Lcm" })),
      warmth.refreshUser(id)
    )
  return {
    GetSummary: (params) =>
      Effect.flatMap(CurrentUser, (user) => reader.GetSummary({ userId: user.id, ...params })).pipe(
        internal("GetSummary")
      ),
    EditSummary: (params) =>
      Effect.gen(function* () {
        const user = yield* CurrentUser
        const result = yield* writer.EditSummary({ userId: user.id, ...params })
        yield* changed(result.summary.chatId, user.id)
        return result
      }).pipe(internal("EditSummary")),
    SelectSummaryRevision: (params) =>
      Effect.gen(function* () {
        const user = yield* CurrentUser
        const result = yield* writer.SelectSummaryRevision({ userId: user.id, ...params })
        yield* changed(result.chatId, user.id)
        return result
      }).pipe(internal("SelectSummaryRevision")),
    GetLcmState: (params) =>
      Effect.flatMap(userId, (id) => reader.GetLcmState({ userId: id, ...params })).pipe(internal("GetLcmState")),
    GetLcmCoverage: (params) =>
      Effect.flatMap(userId, (id) => reader.GetLcmCoverage({ userId: id, ...params })).pipe(internal("GetLcmCoverage")),
    ListSummaryRevisions: (params) =>
      Effect.flatMap(userId, (id) => reader.ListSummaryRevisions({ userId: id, ...params })).pipe(
        internal("ListSummaryRevisions")
      ),
    SetSummaryRerun: (params) =>
      Effect.gen(function* () {
        const id = yield* userId
        yield* writer.SetSummaryRerun({ userId: id, ...params })
        yield* changed(params.chatId, id)
      }).pipe(internal("SetSummaryRerun")),
    SetLcmEnabled: ({ chatId, enabled }) =>
      Effect.gen(function* () {
        const id = yield* userId
        const state = foldState(yield* reader.StateEventsAt({ userId: id, chatId, slotId: null }))
        // The other settings stay as they are; only the switch moves.
        yield* writer.AddStateEvent({
          userId: id,
          chatId,
          slotId: null,
          versionId: null,
          scope: null,
          data: { key: "lcm.settings", value: { ...state.lcm, enabled } }
        })
        hub.publish(chatId, { _tag: "State" })
        yield* changed(chatId, id)
      }).pipe(internal("SetLcmEnabled")),
    GetSummaryDraft: ({ summaryId }) =>
      Effect.gen(function* () {
        const id = yield* userId
        // Drafts are the user's own already; the summary must be too, as for every other read.
        yield* reader.GetSummary({ userId: id, summaryId })
        return yield* reader.GetDraft({ userId: id, key: summaryDraftKey(summaryId) })
      }).pipe(internal("GetSummaryDraft")),
    SaveSummaryDraft: ({ summaryId, draftId, content, expectedRowVersion, expectedSession, baseRevisionId }) =>
      Effect.flatMap(userId, (id) =>
        writer.SaveDraft({
          userId: id,
          key: summaryDraftKey(summaryId),
          draftId,
          content,
          expectedRowVersion,
          expectedSession,
          baseRevision: baseRevisionId
        })
      ).pipe(
        Effect.catchIf(
          (error): error is DraftTooLarge => error instanceof DraftTooLarge,
          ({ length, max }) => Effect.fail(new TextTooLong({ length, max }))
        ),
        internal("SaveSummaryDraft")
      ),
    SummaryDraftHistory: ({ summaryId, limit }) =>
      Effect.flatMap(userId, (id) => reader.DraftHistory({ userId: id, key: summaryDraftKey(summaryId), limit })).pipe(
        internal("SummaryDraftHistory")
      ),
    RestoreSummaryDraft: ({ summaryId, ...restore }) =>
      Effect.flatMap(userId, (id) =>
        writer.RestoreDraftState({ userId: id, key: summaryDraftKey(summaryId), ...restore })
      ).pipe(internal("RestoreSummaryDraft")),
    DiscardSummaryDraft: ({ summaryId, draftId, expectedRowVersion }) =>
      Effect.flatMap(userId, (id) =>
        writer.ClearDraft({
          userId: id,
          key: summaryDraftKey(summaryId),
          draftId,
          outcome: "discarded",
          expectedRowVersion
        })
      ).pipe(internal("DiscardSummaryDraft")),
    RetrySummary: (params) =>
      Effect.flatMap(CurrentUser, (user) => writer.RetrySummary({ userId: user.id, ...params })).pipe(
        internal("RetrySummary")
      )
  } satisfies Partial<Parameters<typeof AppApi.of>[0]>
})

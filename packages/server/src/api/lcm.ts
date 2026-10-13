import { type AppApi, CurrentUser } from "@rp/shared/api.ts"
import { TextTooLong } from "@rp/shared/composerApi.ts"
import { DraftKey } from "@rp/shared/drafts.ts"
import { type BackfillCounts, type BackfillEstimate, LcmBackfill, LcmEnableOffer } from "@rp/shared/lcm.ts"
import type { ChatId, SlotId } from "@rp/shared/chat.ts"
import { NotFound } from "@rp/shared/errors.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { foldState } from "@rp/shared/state.ts"
import { Effect } from "effect"
import { ChatHub } from "../chat/ChatHub.ts"
import { CacheWarmth } from "../chat/CacheWarmth.ts"
import { Reader, Writer } from "../db/Database.ts"
import { DraftTooLarge } from "../db/ops.ts"
import { Summarizer } from "../lcm/Summarizer.ts"
import * as Providers from "../providers/Providers.ts"
import { internal } from "./internal.ts"

/** Tokens billed for an estimate's work: what is sent, read from cache or written to it, and returned. */
const billed = (e: BackfillCounts) => e.uncachedInput + e.cachedInput + e.cacheWrite + e.output

const summaryDraftKey = (summaryId: string) =>
  new DraftKey({ targetKind: "summary_edit", targetId: summaryId, field: "" })

export const makeLcmHandlers = Effect.gen(function* () {
  const reader = yield* Reader
  const writer = yield* Writer
  const warmth = yield* CacheWarmth
  const hub = yield* ChatHub
  const providers = yield* Providers.Providers
  const summarizer = yield* Summarizer
  const userId = Effect.map(CurrentUser, (user) => user.id)
  /** The counts through the summarizer's cost formulas; unpriced when none applies. */
  const priced = (id: UserId, counts: BackfillCounts): Effect.Effect<BackfillEstimate> =>
    counts.model === null || counts.blocked !== null
      ? Effect.succeed({ ...counts, cost: null })
      : providers
          .estimateCost(id, counts.model.connection, counts.model.model, {
            inputUncached: counts.uncachedInput,
            cacheRead: counts.cachedInput,
            cacheWrite: counts.cacheWrite,
            cacheWriteLong: 0,
            output: counts.output,
            reasoning: null
          })
          .pipe(
            Effect.catch(() => Effect.succeed(null)),
            Effect.map((cost) => ({ ...counts, cost: cost && { amount: cost.amount, currency: cost.currency } }))
          )
  const approval = (e: BackfillEstimate) => ({
    jobs: e.l1Jobs + e.condensations,
    tokens: billed(e),
    cost: e.cost?.amount ?? null,
    currency: e.cost?.currency ?? null
  })
  /** The chat's backfill as the UI shows it, with what is left priced; null when it never had one. */
  const backfillOf = (id: UserId, chatId: ChatId, leafSlotId: SlotId) =>
    Effect.gen(function* () {
      const status = yield* reader.GetBackfill({ userId: id, chatId })
      if (status === null) return null
      const remaining =
        status.state === "done"
          ? yield* priced(id, {
              messages: 0,
              tokens: 0,
              l1Jobs: 0,
              condensations: 0,
              uncachedInput: 0,
              cachedInput: 0,
              cacheWrite: 0,
              output: 0,
              cached: false,
              model: null,
              blocked: null,
              seconds: null
            })
          : yield* priced(id, (yield* reader.EstimateBackfill({ userId: id, chatId, leafSlotId })).fromScratch)
      return new LcmBackfill({
        chatId,
        state: status.state,
        choice: status.choice,
        startedAt: status.startedAt,
        spentTokens: status.spentTokens,
        spentCost: status.spentCost,
        capTokens: status.capTokens,
        capCost: status.capCost,
        currency: status.currency,
        remaining
      })
    })
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
    GetLcmEnableOffer: ({ chatId, leafSlotId }) =>
      Effect.gen(function* () {
        const id = yield* userId
        const basis = yield* reader.EstimateBackfill({ userId: id, chatId, leafSlotId })
        return new LcmEnableOffer({
          chatId,
          leafSlotId,
          enabled: basis.enabled,
          imported: basis.imported,
          fromScratch: yield* priced(id, basis.fromScratch),
          adopted: basis.adopted ? yield* priced(id, basis.adopted) : null
        })
      }).pipe(internal("GetLcmEnableOffer")),
    EnableLcm: ({ chatId, leafSlotId, choice }) =>
      Effect.gen(function* () {
        const id = yield* userId
        // The estimate the user saw is measured again here: the client sends only its choice.
        const basis = yield* reader.EstimateBackfill({ userId: id, chatId, leafSlotId })
        const counts = choice === "adopt" ? basis.adopted : basis.fromScratch
        if (counts === null) return yield* new NotFound({ entity: "imported summary", id: chatId })
        const done = yield* writer.EnableLcm({
          userId: id,
          chatId,
          leafSlotId,
          choice,
          approved: approval(yield* priced(id, counts))
        })
        // The run is shown again: open tabs read the chat anew.
        hub.publish(chatId, done.unhidden > 0 ? { _tag: "Reload" } : { _tag: "State" })
        yield* changed(chatId, id)
        return yield* backfillOf(id, chatId, leafSlotId)
      }).pipe(internal("EnableLcm")),
    GetLcmBackfill: ({ chatId, leafSlotId }) =>
      Effect.flatMap(userId, (id) => backfillOf(id, chatId, leafSlotId)).pipe(internal("GetLcmBackfill")),
    SetLcmBackfill: ({ chatId, leafSlotId, action }) =>
      Effect.gen(function* () {
        const id = yield* userId
        if (action === "continue") {
          const basis = yield* reader.EstimateBackfill({ userId: id, chatId, leafSlotId })
          yield* writer.SetBackfill({
            userId: id,
            chatId,
            action,
            approved: approval(yield* priced(id, basis.fromScratch))
          })
        } else yield* writer.SetBackfill({ userId: id, chatId, action: action === "pause" ? "pause" : "drive" })
        // "Summarize now" and Continue are the clicks that plan; the pool runs what they make.
        if (action !== "pause") yield* summarizer.planNow({ userId: id, chatId, leafSlotId }, "completion")
        yield* changed(chatId, id)
        return yield* backfillOf(id, chatId, leafSlotId)
      }).pipe(internal("SetLcmBackfill")),
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
      ).pipe(internal("DiscardSummaryDraft"))
  } satisfies Partial<Parameters<typeof AppApi.of>[0]>
})

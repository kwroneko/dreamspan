import type { ForkId } from "@rp/shared/chat.ts"
import { type AppApi, CurrentUser } from "@rp/shared/api.ts"
import { TextTooLong } from "@rp/shared/composerApi.ts"
import { DraftKey } from "@rp/shared/drafts.ts"
import {
  type BackfillCounts,
  type BackfillEstimate,
  LcmEstimateChanged,
  LcmBackfill,
  LcmEnableOffer
} from "@rp/shared/lcm.ts"
import type { ChatId, SlotId } from "@rp/shared/chat.ts"
import { NotFound } from "@rp/shared/errors.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { Effect } from "effect"
import { ChatHub } from "../chat/ChatHub.ts"
import { CacheWarmth } from "../chat/CacheWarmth.ts"
import { Reader, Writer } from "../db/Database.ts"
import { DraftTooLarge } from "../db/ops.ts"
import { judgeInputTokens } from "../decision/RefusalJudge.ts"
import { Summarizer } from "../lcm/Summarizer.ts"
import * as Providers from "../providers/Providers.ts"
import { internal } from "./internal.ts"

/** Tokens billed for an estimate's work: what is sent, read from cache or written to it, and returned. */
const billed = (e: BackfillCounts) => e.uncachedInput + e.cachedInput + e.cacheWrite + e.output

const summaryDraftKey = (summaryId: string, forkId?: ForkId | null) =>
  new DraftKey({ targetKind: "summary_edit", targetId: summaryId, field: forkId ?? "" })

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
    Effect.gen(function* () {
      if (counts.model === null || counts.blocked !== null) return { ...counts, cost: null }
      const costs = yield* Effect.forEach(counts.plannedRequests ?? [], (request) =>
        providers
          .estimateCost(id, counts.model!.connection, counts.model!.model, {
            inputUncached: request.uncachedInput,
            cacheRead: request.cachedInput,
            cacheWrite: request.cacheWrite,
            cacheWriteLong: 0,
            output: request.output,
            reasoning: null
          })
          .pipe(Effect.catch(() => Effect.succeed(null)))
      )
      const defaults = yield* reader
        .GetGenerationDefaults({ userId: id })
        .pipe(Effect.catch(() => Effect.succeed(null)))
      const judge = defaults?.judge
      const requests = counts.plannedRequests ?? []
      const judged = judge
        ? yield* Effect.forEach(requests, (request) =>
            providers
              .estimateCost(id, judge.connection, judge.model, {
                inputUncached: judgeInputTokens(request.output),
                cacheRead: 0,
                cacheWrite: 0,
                cacheWriteLong: 0,
                output: 2,
                reasoning: null
              })
              .pipe(Effect.catch(() => Effect.succeed(null)))
          )
        : []
      costs.push(...judged)
      const judgeInput = judge ? requests.reduce((n, r) => n + judgeInputTokens(r.output), 0) : 0
      const measured = {
        ...counts,
        uncachedInput: counts.uncachedInput + judgeInput,
        output: counts.output + judged.length * 2
      }
      const currency = costs[0]?.currency
      const cost =
        costs.length && currency && costs.every((c) => c !== null && c.currency === currency)
          ? { amount: costs.reduce((n, c) => n + c!.amount, 0), currency }
          : null
      return { ...measured, cost }
    })
  const validateApproval = (seen: BackfillEstimate | undefined, current: BackfillEstimate) =>
    !seen ||
    billed(current) > billed(seen) ||
    (current.cost !== null &&
      (seen.cost === null || current.cost.currency !== seen.cost.currency || current.cost.amount > seen.cost.amount))
      ? Effect.fail(
          new LcmEstimateChanged({
            message: "The estimate changed. Review the new figures and confirm again.",
            estimate: current
          })
        )
      : Effect.void
  const approval = (e: BackfillEstimate) => ({
    jobs: e.l1Jobs + e.condensations,
    tokens: billed(e),
    cost: e.cost?.amount ?? null,
    currency: e.cost?.currency ?? null
  })
  /** The chat's backfill as the UI shows it, with what is left priced; null when it never had one. */
  const backfillOf = (id: UserId, chatId: ChatId, leafSlotId: SlotId, forkId?: ForkId | null) =>
    Effect.gen(function* () {
      const status = yield* reader.GetBackfill({ userId: id, chatId, forkId: forkId ?? null })
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
          : yield* priced(
              id,
              (yield* reader.EstimateBackfill({ userId: id, chatId, leafSlotId, forkId: forkId ?? null })).fromScratch
            )
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
    GetSummaryDetails: (params) =>
      Effect.flatMap(CurrentUser, (user) => reader.GetSummaryDetails({ userId: user.id, ...params })).pipe(
        internal("GetSummaryDetails")
      ),
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
    GetLcmEnableOffer: ({ chatId, leafSlotId, forkId }) =>
      Effect.gen(function* () {
        const id = yield* userId
        const basis = yield* reader.EstimateBackfill({
          userId: id,
          chatId,
          leafSlotId,
          ...(forkId != null ? { forkId } : {})
        })
        return new LcmEnableOffer({
          chatId,
          leafSlotId,
          enabled: basis.enabled,
          imported: basis.imported,
          fromScratch: yield* priced(id, basis.fromScratch),
          adopted: basis.adopted ? yield* priced(id, basis.adopted) : null,
          ...(basis.summaryNotesOn?.length ? { summaryNoteOn: true } : {})
        })
      }).pipe(internal("GetLcmEnableOffer")),
    EnableLcm: ({ chatId, leafSlotId, forkId, choice, approved }) =>
      Effect.gen(function* () {
        const id = yield* userId
        // Revalidation never grants a higher allowance than the figures the caller saw.
        const basis = yield* reader.EstimateBackfill({
          userId: id,
          chatId,
          leafSlotId,
          ...(forkId != null ? { forkId } : {})
        })
        const counts = choice === "adopt" ? basis.adopted : basis.fromScratch
        if (counts === null) return yield* new NotFound({ entity: "imported summary", id: chatId })
        const current = yield* priced(id, counts)
        yield* validateApproval(approved, current)
        const imported = yield* reader.ReadLcmImported({
          userId: id,
          chatId,
          leafSlotId,
          ...(forkId != null ? { forkId } : {})
        })
        let staged = yield* writer.StageLcmEnable({
          userId: id,
          chatId,
          leafSlotId,
          ...(forkId != null ? { forkId } : {}),
          choice,
          approved: approval(approved!),
          imported
        })
        while (!staged.ready)
          staged = yield* writer.StageLcmEnable({
            userId: id,
            chatId,
            leafSlotId,
            ...(forkId != null ? { forkId } : {}),
            choice,
            approved: approval(approved!),
            imported,
            runId: staged.runId
          })
        // Pricing/settings may also change while a very long range is being staged.
        const refreshed = yield* reader.EstimateBackfill({
          userId: id,
          chatId,
          leafSlotId,
          ...(forkId != null ? { forkId } : {})
        })
        const finalCounts = choice === "adopt" ? refreshed.adopted : refreshed.fromScratch
        if (!finalCounts) return yield* new NotFound({ entity: "imported summary", id: chatId })
        yield* validateApproval(approved, yield* priced(id, finalCounts))
        const done = yield* writer.EnableLcm({
          forkId: forkId ?? null,
          runId: staged.runId,
          userId: id,
          chatId,
          leafSlotId,
          choice,
          approved: approval(approved!),
          ...(refreshed.summaryNotesOn?.length ? { switchOff: refreshed.summaryNotesOn } : {})
        })
        // The run is shown again: open tabs read the chat anew.
        hub.publish(chatId, done.unhidden > 0 ? { _tag: "Reload" } : { _tag: "State" })
        yield* changed(chatId, id)
        return yield* backfillOf(id, chatId, leafSlotId, forkId)
      }).pipe(internal("EnableLcm")),
    GetLcmBackfill: ({ chatId, leafSlotId, forkId }) =>
      Effect.flatMap(userId, (id) => backfillOf(id, chatId, leafSlotId, forkId)).pipe(internal("GetLcmBackfill")),
    SetLcmBackfill: ({ chatId, leafSlotId, forkId, action, approved }) =>
      Effect.gen(function* () {
        const id = yield* userId
        if (action === "continue") {
          const basis = yield* reader.EstimateBackfill({ userId: id, chatId, leafSlotId, forkId: forkId ?? null })
          const current = yield* priced(id, basis.fromScratch)
          yield* validateApproval(approved, current)
          yield* writer.SetBackfill({
            userId: id,
            chatId,
            forkId: forkId ?? null,
            action,
            approved: approval(approved!)
          })
        } else
          yield* writer.SetBackfill({
            userId: id,
            chatId,
            forkId: forkId ?? null,
            action: action === "pause" ? "pause" : "drive"
          })
        // "Summarize now" and Continue are the clicks that plan; the pool runs what they make.
        if (action !== "pause")
          yield* summarizer.planNow({ userId: id, chatId, leafSlotId, ...(forkId ? { forkId } : {}) }, "completion")
        yield* changed(chatId, id)
        return yield* backfillOf(id, chatId, leafSlotId, forkId)
      }).pipe(internal("SetLcmBackfill")),
    // One write of the chat's settings, the others kept (DESIGN §8); nothing is planned by it.
    ChangeLcmSettings: ({ chatId, change, forkId }) =>
      Effect.gen(function* () {
        const id = yield* userId
        yield* writer.ChangeLcmSettings({ userId: id, chatId, change, forkId: forkId ?? null })
        hub.publish(chatId, { _tag: "State" })
        yield* changed(chatId, id)
      }).pipe(internal("ChangeLcmSettings")),
    GetLcmSettings: ({ chatId, leafSlotId, forkId }) =>
      Effect.flatMap(userId, (id) =>
        reader.LcmSettingsAt({ userId: id, chatId, leafSlotId, forkId: forkId ?? null })
      ).pipe(internal("GetLcmSettings")),
    SetLcmEnabled: ({ chatId, enabled, forkId }) =>
      Effect.gen(function* () {
        const id = yield* userId
        // The other settings stay as they are; only the switch moves.
        // The switch alone can't put a target above its maximum.
        yield* writer
          .ChangeLcmSettings({ userId: id, chatId, forkId: forkId ?? null, change: { enabled } })
          .pipe(Effect.catchTag("LcmSettingsInvalid", (error) => Effect.die(error)))
        hub.publish(chatId, { _tag: "State" })
        yield* changed(chatId, id)
      }).pipe(internal("SetLcmEnabled")),
    GetSummaryDraft: ({ summaryId, forkId }) =>
      Effect.gen(function* () {
        const id = yield* userId
        // Drafts are the user's own already; the summary must be too, as for every other read.
        yield* reader.GetSummary({ userId: id, summaryId, forkId: forkId ?? null })
        return yield* reader.GetDraft({ userId: id, key: summaryDraftKey(summaryId, forkId) })
      }).pipe(internal("GetSummaryDraft")),
    SaveSummaryDraft: ({
      summaryId,
      forkId,
      draftId,
      content,
      expectedRowVersion,
      expectedSession,
      baseRevisionId,
      observedDeletion
    }) =>
      Effect.flatMap(userId, (id) =>
        writer.SaveDraft({
          userId: id,
          key: summaryDraftKey(summaryId, forkId),
          draftId,
          ...(observedDeletion === undefined ? {} : { observedDeletion }),
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
    SummaryDraftHistory: ({ summaryId, forkId, limit, before }) =>
      Effect.flatMap(userId, (id) =>
        reader.DraftHistory({
          userId: id,
          key: summaryDraftKey(summaryId, forkId),
          limit,
          ...(before === undefined ? {} : { before })
        })
      ).pipe(internal("SummaryDraftHistory")),
    RestoreSummaryDraft: ({ summaryId, forkId, ...restore }) =>
      Effect.flatMap(userId, (id) =>
        writer.RestoreDraftState({ userId: id, key: summaryDraftKey(summaryId, forkId), ...restore })
      ).pipe(internal("RestoreSummaryDraft")),
    DiscardSummaryDraft: ({ summaryId, forkId, draftId, expectedRowVersion }) =>
      Effect.flatMap(userId, (id) =>
        writer.ClearDraft({
          userId: id,
          key: summaryDraftKey(summaryId, forkId),
          draftId,
          outcome: "discarded",
          expectedRowVersion
        })
      ).pipe(internal("DiscardSummaryDraft"))
  } satisfies Partial<Parameters<typeof AppApi.of>[0]>
})

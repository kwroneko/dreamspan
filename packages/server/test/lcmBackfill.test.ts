// Enabling LCM on imported chats and backfilling them (spec/LCM.md §2.7, §2.11) at the real
// boundary: a synthetic ST folder uploaded over HTTP as the client does, the enable dialog's
// reads and writes through the RPCs, summaries planned and written by the real summarizer
// against a fake provider that caches prefixes as a provider would, and the estimate checked
// against the usage ledger. Cross-user probes are in isolation.test.ts.
import type { ServerResponse } from "node:http"
import { assert } from "@effect/vitest"
import type { ChatId, SlotId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import type { LlmRequest } from "@rp/shared/usage.ts"
import { Effect } from "effect"
import { Reader, Writer } from "../src/db/Database.ts"
import { importStPreset } from "../src/formats/preset.ts"
import { client, outcome, posted } from "./support/config.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { lcmServer, lcmTest } from "./support/lcmHarness.ts"
import { completionChunks, type Recorded, sse, startMockProvider } from "./support/mockProvider.ts"
import { BACKFILL_SUMMARY, backfillFolder } from "./support/stBackfill.ts"
import { importStFolder } from "./support/stUpload.ts"

const tokens = (text: string) => Math.ceil(text.length / 4) + 3
const flat = (content: unknown) =>
  typeof content === "string" ? content : (content as Array<{ text?: string }>).map((p) => p.text ?? "").join("")

const L1_TOKENS = 100
const CONDENSED_TOKENS = 150

/**
 * A provider that answers every request with a summary of the size asked for, and reports the
 * usage a provider with prefix caching would: the text it shares with the request before, from
 * the start, in tokens.
 */
const cachingProvider = () => {
  let previous = ""
  let n = 0
  return (request: Recorded, res: ServerResponse) => {
    const messages = (request.body?.messages ?? []) as Array<{ role: string; content: unknown }>
    const wire = messages.map((m) => `${m.role}\u0000${flat(m.content)}`).join("\u0001")
    let shared = 0
    while (shared < wire.length && wire[shared] === previous[shared]) shared++
    previous = wire
    const condense = flat(messages.at(-1)?.content).includes("Condense the last")
    const size = condense ? CONDENSED_TOKENS : L1_TOKENS
    const text = `Summary ${++n}. `.padEnd(size * 4, "x")
    sse(
      res,
      completionChunks([text], {
        prompt_tokens: messages.reduce((sum, m) => sum + tokens(flat(m.content)), 0),
        completion_tokens: Math.ceil(text.length / 4),
        prompt_tokens_details: { cached_tokens: Math.floor(shared / 4) }
      })
    )
  }
}

/** Dollars per million tokens for the test model, through the built-in formula. */
// Accuracy is measured to completion under a deliberately generous, explicitly approved
// allowance. Hard admission uses a byte bound, so the normal forecast can hold sooner.
const testAllowance = (e: import("@rp/shared/lcm.ts").BackfillEstimate) => ({
  ...e,
  uncachedInput: e.uncachedInput * 10,
  cost: e.cost ? { ...e.cost, amount: e.cost.amount * 10 } : null
})

const PRICE = { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 0 }

const within = (actual: number, expected: number, share: number, what: string) =>
  assert.isAtMost(Math.abs(actual - expected), Math.max(1, expected * share), `${what}: ${actual} against ${expected}`)

/** A server's worth of setup: the fake provider, a priced model, the folder imported, and helpers to drive the work. */
const environment = (server: ReturnType<typeof lcmServer>, names: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const mock = yield* Effect.acquireRelease(
      Effect.promise(() => startMockProvider(cachingProvider())),
      (m) => Effect.promise(() => m.close())
    )
    const baseApi = yield* client()
    const api = {
      ...baseApi,
      EnableLcm: (params: Parameters<typeof baseApi.EnableLcm>[0]) =>
        Effect.gen(function* () {
          const offer = yield* baseApi.GetLcmEnableOffer(params)
          return yield* baseApi.EnableLcm({
            ...params,
            approved:
              params.approved ??
              testAllowance(params.choice === "adopt" ? (offer.adopted ?? offer.fromScratch) : offer.fromScratch)
          })
        }),
      SetLcmBackfill: (params: Parameters<typeof baseApi.SetLcmBackfill>[0]) =>
        Effect.gen(function* () {
          const current = params.action === "continue" ? yield* baseApi.GetLcmBackfill(params) : null
          return yield* baseApi.SetLcmBackfill({
            ...params,
            ...(params.action === "continue" && current
              ? { approved: params.approved ?? testAllowance(current.remaining) }
              : {})
          })
        })
    }
    const writer = yield* Writer,
      reader = yield* Reader,
      summarizer = server.summarizer(),
      user = yield* api.Whoami(),
      userId = user.id as UserId
    const connection = yield* api.CreateConnection({
      kind: "openai-chat",
      settings: {
        name: "Synthetic",
        baseUrl: `${mock.url}/v1`,
        compat: {},
        cacheTtlS: 300,
        maxConcurrent: null,
        presetOverrideRefId: null
      }
    })
    const model = yield* api.AddUserModel({
      connectionId: connection.id,
      key: "primary-model",
      overrides: { context: 8192 }
    })
    yield* fixtureSql(server.config.dataDir, [
      {
        sql: "UPDATE models SET upstream_json = ? WHERE id = ?",
        params: [JSON.stringify({ price: PRICE }), model.id]
      }
    ])
    const preset = yield* writer.CreateEntity({
      userId,
      kind: "preset",
      label: "Synthetic",
      subtitle: "",
      schemaVersion: 1,
      origin: "user",
      sourcePath: null,
      doc: importStPreset(JSON.stringify({ frequency_penalty: 0, openai_max_context: 8192, openai_max_tokens: 512 }))
        .document!
    })
    yield* api.SetGenerationDefaults({
      defaults: { model: { connection: connection.id, model: model.id }, preset: preset.ref.id, judge: null, lcm: {} }
    })

    // --- Import: three chats, each with a hidden run of 20 and a summary covering it.
    const { report } = yield* importStFolder(backfillFolder("ST/data/default-user/", names))
    assert.strictEqual(report.hiddenRuns.length, names.length)
    const chats = yield* api.ListChats({ limit: 50, before: null })
    const chatNamed = (name: string) => chats.find((c) => c.title === name)!

    const knobs = { enabled: false, leafInput: 600, leafTarget: L1_TOKENS, fanout: 3, condenseTarget: CONDENSED_TOKENS }
    const prepare = (name: string) =>
      Effect.gen(function* () {
        const chat = chatNamed(name)
        const leaf = (yield* api.GetChat({ chatId: chat.id })).activeLeafSlotId as SlotId
        yield* writer.AddStateEvent({
          userId,
          chatId: chat.id,
          slotId: null,
          versionId: null,
          scope: null,
          data: { key: "lcm.settings", value: knobs }
        })
        return { chatId: chat.id as ChatId, leaf }
      })
    const ledger = (chatId: ChatId) =>
      Effect.map(api.ListLlmRequests({ limit: 1000, before: null }), (list) =>
        list.filter((r: LlmRequest) => r.chatId === chatId && (r.purpose === "summarize" || r.purpose === "condense"))
      )
    /** A reply's planning and the cascade it starts, run to the end (the pool is off in this test). */
    const settle = (chatId: ChatId, leafSlotId: SlotId, first: "reply" | "completion" = "reply") =>
      Effect.gen(function* () {
        let reason: "reply" | "completion" = first
        let ran = 0
        for (let pass = 0; pass < 80; pass++) {
          const made = yield* summarizer.planNow({ userId, chatId, leafSlotId }, reason)
          let done = 0
          for (;;) {
            const job = yield* writer.ClaimSummaryJob({ userId })
            if (!job) break
            yield* summarizer.runJob(job)
            done++
          }
          ran += done
          if (!made.length && !done) break
          reason = "completion"
        }
        return ran
      })
    const totals = (requests: ReadonlyArray<LlmRequest>) => ({
      uncached: requests.reduce((n, r) => n + (r.counts.inputUncached ?? 0), 0),
      cached: requests.reduce((n, r) => n + (r.counts.cacheRead ?? 0), 0),
      output: requests.reduce((n, r) => n + (r.counts.output ?? 0), 0),
      cost: requests.reduce((n, r) => n + (r.cost?.amount ?? 0), 0)
    })

    return { mock, api, writer, reader, summarizer, userId, prepare, ledger, settle, totals, config: server.config }
  })

lcmTest(
  "an imported chat adopts its summary or starts over, and backfills within the estimate and the cap",
  (server) =>
    Effect.gen(function* () {
      const names = ["Bob - adopt", "Bob - scratch", "Bob - capped"]
      const { mock, api, writer, reader, userId, prepare, ledger, settle, totals } = yield* environment(server, names)
      // --- Before anything is enabled: LCM is off, the offer shows both ways, and nothing is spent.
      const adopt = yield* prepare(names[0]!)
      const offer = yield* api.GetLcmEnableOffer({ chatId: adopt.chatId, leafSlotId: adopt.leaf })
      assert.isFalse(offer.enabled)
      assert.deepStrictEqual([offer.imported?.to, offer.imported?.hidden], [20, 20])
      assert.isAbove(offer.imported!.tokens, 0)
      assert.include(offer.imported!.preview, BACKFILL_SUMMARY)
      assert.isNotNull(offer.adopted)
      assert.isAbove(offer.fromScratch.l1Jobs, offer.adopted!.l1Jobs)
      assert.isAbove(offer.adopted!.l1Jobs, 2)
      assert.isAbove(offer.adopted!.condensations, 0)
      assert.isTrue(offer.adopted!.cached)
      assert.isNotNull(offer.adopted!.cost)
      assert.strictEqual(offer.adopted!.model?.name, "primary-model")
      assert.isNull(yield* api.GetLcmBackfill({ chatId: adopt.chatId, leafSlotId: adopt.leaf }))
      assert.strictEqual(mock.requests().length, 0)
      const noteBefore = (yield* api.ListChatNotes({ chatId: adopt.chatId, slotId: null })).find(
        (n) => n.doc["kind"] === "imported_summary"
      )!

      // --- Adopt: one write; the run is shown, the summary is the first level over it, the note stays.
      const started = yield* api.EnableLcm({ chatId: adopt.chatId, leafSlotId: adopt.leaf, choice: "adopt" })
      assert.strictEqual(started?.state, "waiting")
      assert.strictEqual(started?.choice, "adopt")
      assert.isAbove(started!.capTokens, 0)
      const state = yield* api.GetLcmState({ chatId: adopt.chatId, leafSlotId: adopt.leaf })
      assert.isTrue(state.enabled)
      assert.deepStrictEqual(
        state.layer.map((s) => [s.level, s.from, s.to, s.origin, s.fresh, s.content]),
        [[1, 1, 20, "imported", true, BACKFILL_SUMMARY]]
      )
      assert.strictEqual(state.cursorDepth, 19)
      const path = yield* api.ReadPath({
        chatId: adopt.chatId,
        leafSlotId: null,
        range: { _tag: "Bottom" },
        limit: 100
      })
      assert.isTrue(path.entries.every((e) => !e.contextExcluded))
      const noteAfter = (yield* api.ListChatNotes({ chatId: adopt.chatId, slotId: null })).find(
        (n) => n.doc["kind"] === "imported_summary"
      )!
      assert.strictEqual(noteAfter.doc["content"], noteBefore.doc["content"])
      assert.strictEqual(noteAfter.ref.id, noteBefore.ref.id)
      // Enabling spent nothing, and a plan that is not a reply's does not begin the backfill.
      assert.strictEqual(mock.requests().length, 0)
      const quiet = yield* reader.PlanSummaries({ userId, chatId: adopt.chatId, leafSlotId: adopt.leaf })
      assert.strictEqual(quiet.chunks.length, 0)
      assert.isTrue(quiet.backfill?.armed)

      // --- The reply begins it; the estimate was made before, and holds within 25%.
      yield* settle(adopt.chatId, adopt.leaf)
      const adoptedRequests = yield* ledger(adopt.chatId)
      const adoptedTotals = totals(adoptedRequests)
      const est = offer.adopted!
      within(adoptedRequests.length, est.l1Jobs + est.condensations, 0.25, "requests")
      within(adoptedTotals.uncached, est.uncachedInput, 0.25, "uncached input")
      within(adoptedTotals.cached, est.cachedInput, 0.25, "cached input")
      within(adoptedTotals.output, est.output, 0.25, "output")
      within(adoptedTotals.cost, est.cost!.amount, 0.25, "cost")
      const done = yield* api.GetLcmBackfill({ chatId: adopt.chatId, leafSlotId: adopt.leaf })
      assert.strictEqual(done?.state, "done")
      assert.strictEqual(done?.remaining.l1Jobs, 0)
      // The imported summary is still the first level (or inside the condensations over it).
      const after = yield* api.GetLcmState({ chatId: adopt.chatId, leafSlotId: adopt.leaf })
      assert.isAbove(after.cursorDepth, 19)
      assert.strictEqual(after.failed.length, 0)

      // --- Start over: the run is shown and summarized with the rest; no summary stands in for it.
      const scratch = yield* prepare(names[1]!)
      const scratchOffer = yield* api.GetLcmEnableOffer({ chatId: scratch.chatId, leafSlotId: scratch.leaf })
      yield* api.EnableLcm({ chatId: scratch.chatId, leafSlotId: scratch.leaf, choice: "scratch" })
      const fresh = yield* api.GetLcmState({ chatId: scratch.chatId, leafSlotId: scratch.leaf })
      assert.strictEqual(fresh.layer.length, 0)
      const scratchPath = yield* api.ReadPath({
        chatId: scratch.chatId,
        leafSlotId: null,
        range: { _tag: "Bottom" },
        limit: 100
      })
      assert.isTrue(scratchPath.entries.every((e) => !e.contextExcluded))
      yield* settle(scratch.chatId, scratch.leaf)
      const scratchRequests = yield* ledger(scratch.chatId)
      const scratchTotals = totals(scratchRequests)
      const sest = scratchOffer.fromScratch
      within(scratchRequests.length, sest.l1Jobs + sest.condensations, 0.25, "requests")
      within(scratchTotals.uncached, sest.uncachedInput, 0.25, "uncached input")
      within(scratchTotals.cached, sest.cachedInput, 0.25, "cached input")
      within(scratchTotals.output, sest.output, 0.25, "output")
      within(scratchTotals.cost, sest.cost!.amount, 0.25, "cost")
      assert.strictEqual(
        (yield* api.GetLcmBackfill({ chatId: scratch.chatId, leafSlotId: scratch.leaf }))?.state,
        "done"
      )
      // Starting over costs more than adopting.
      assert.isAbove(scratchTotals.cost, adoptedTotals.cost)

      // --- The cap: spending stops at 150% of the estimate until the user continues.
      const capped = yield* prepare(names[2]!)
      yield* api.EnableLcm({ chatId: capped.chatId, leafSlotId: capped.leaf, choice: "scratch" })
      // Lower the cap so a few summaries reach it.
      yield* fixtureSql(server.config.dataDir, [
        {
          sql: "UPDATE jobs SET payload_json = json_set(payload_json, '$.capTokens', 11000, '$.capCost', NULL) WHERE kind = 'lcm-backfill' AND json_extract(payload_json, '$.chatId') = ?",
          params: [capped.chatId]
        }
      ])
      // "Summarize now" plans without a reply, and the work goes on without waiting for each one.
      const requestsBefore = mock.requests().length
      const driven = yield* api.SetLcmBackfill({
        chatId: capped.chatId,
        leafSlotId: capped.leaf,
        action: "summarizeNow"
      })
      assert.notStrictEqual(driven?.state, "waiting")
      yield* settle(capped.chatId, capped.leaf, "completion")
      const stopped = yield* api.GetLcmBackfill({ chatId: capped.chatId, leafSlotId: capped.leaf })
      assert.strictEqual(stopped?.state, "capped")
      assert.isAtMost(stopped!.spentTokens, 11000)
      // A request that cannot fit is held before dispatch, including its output allowance.
      const spentAtCap = mock.requests().length - requestsBefore
      assert.isAbove(spentAtCap, 0)
      assert.isAbove(stopped!.remaining.l1Jobs, 0)
      // Nothing more starts, however it is asked for.
      assert.isNull(yield* writer.ClaimSummaryJob({ userId }))
      yield* settle(capped.chatId, capped.leaf)
      assert.strictEqual(mock.requests().length - requestsBefore, spentAtCap)
      // Continue: a new cap of 150% of what is left, and the work finishes.
      const resumed = yield* api.SetLcmBackfill({ chatId: capped.chatId, leafSlotId: capped.leaf, action: "continue" })
      assert.notStrictEqual(resumed?.state, "capped")
      assert.isAbove(resumed!.capTokens, stopped!.capTokens)
      yield* settle(capped.chatId, capped.leaf, "completion")
      assert.strictEqual((yield* api.GetLcmBackfill({ chatId: capped.chatId, leafSlotId: capped.leaf }))?.state, "done")
      assert.strictEqual((yield* ledger(capped.chatId)).length > spentAtCap, true)
    }).pipe(Effect.scoped),
  { timeout: 280_000 }
)

lcmTest(
  "a paused backfill starts nothing, Summarize now goes on without a reply or spending ahead, and adopting needs a summary",
  (server) =>
    Effect.gen(function* () {
      const { mock, api, writer, userId, prepare, ledger, settle } = yield* environment(server, [
        "Bob - paused",
        "Bob - twice"
      ])
      // Spending ahead is off: replies plan nothing, but "Summarize now" is the user's own call.
      const defaults = yield* api.GetGenerationDefaults()
      yield* api.SetGenerationDefaults({ defaults: { ...defaults, lcm: { spendAhead: false } } })
      const paused = yield* prepare("Bob - paused")
      yield* api.EnableLcm({ chatId: paused.chatId, leafSlotId: paused.leaf, choice: "scratch" })
      assert.strictEqual(yield* settle(paused.chatId, paused.leaf), 0)
      assert.strictEqual(mock.requests().length, 0)

      const first = yield* api.SetLcmBackfill({
        chatId: paused.chatId,
        leafSlotId: paused.leaf,
        action: "summarizeNow"
      })
      assert.strictEqual(first?.state, "running")
      const pending = (yield* fixtureSql(server.config.dataDir, [
        {
          sql: "SELECT count(*) AS n FROM summarization_jobs WHERE chat_id = ? AND status = 'pending'",
          params: [paused.chatId]
        }
      ]))[0]![0]!["n"] as number
      assert.isAbove(pending, 0)

      // Paused: nothing is claimed, and a reply plans nothing more.
      const stopped = yield* api.SetLcmBackfill({ chatId: paused.chatId, leafSlotId: paused.leaf, action: "pause" })
      assert.strictEqual(stopped?.state, "paused")
      assert.isNull(yield* writer.ClaimSummaryJob({ userId }))
      assert.strictEqual(mock.requests().length, 0)

      // Continue, and the work runs to its end.
      const resumed = yield* api.SetLcmBackfill({ chatId: paused.chatId, leafSlotId: paused.leaf, action: "continue" })
      assert.strictEqual(resumed?.state, "running")
      assert.isAbove(yield* settle(paused.chatId, paused.leaf, "completion"), 0)
      assert.strictEqual((yield* api.GetLcmBackfill({ chatId: paused.chatId, leafSlotId: paused.leaf }))?.state, "done")
      assert.isAbove((yield* ledger(paused.chatId)).length, 0)

      // The summary is adopted once, and a chat without one has none to adopt.
      const twice = yield* prepare("Bob - twice")
      yield* api.EnableLcm({ chatId: twice.chatId, leafSlotId: twice.leaf, choice: "adopt" })
      assert.strictEqual(
        yield* outcome(api.EnableLcm({ chatId: twice.chatId, leafSlotId: twice.leaf, choice: "adopt" })),
        "NotFound"
      )
      const state = yield* api.GetLcmState({ chatId: twice.chatId, leafSlotId: twice.leaf })
      assert.strictEqual(state.layer.length, 1)
      const native = yield* api.CreateChat({ title: "Native" })
      const sent = yield* posted(
        api.SendMessage({ chatId: native.id, parentSlotId: null, branch: false, content: "Hello." })
      )
      assert.strictEqual(
        yield* outcome(api.EnableLcm({ chatId: native.id, leafSlotId: sent.entry.slotId, choice: "adopt" })),
        "NotFound"
      )
      const offer = yield* api.GetLcmEnableOffer({ chatId: native.id, leafSlotId: sent.entry.slotId })
      assert.isNull(offer.imported)
      assert.isNull(offer.adopted)
      assert.strictEqual(offer.fromScratch.l1Jobs, 0)
      // Nothing to summarize: enabling again writes the switch and no backfill.
      assert.isNull(yield* api.EnableLcm({ chatId: native.id, leafSlotId: sent.entry.slotId, choice: "scratch" }))
    }).pipe(Effect.scoped),
  { timeout: 280_000 }
)

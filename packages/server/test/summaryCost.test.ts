import { assert } from "@effect/vitest"
import type { ChatId } from "@rp/shared/chat.ts"
import type { Summary, SummaryDetails } from "@rp/shared/lcm.ts"
import { Effect } from "effect"
import { environment } from "./support/backfillReview.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { lcmHarness, lcmTest, PLANTED } from "./support/lcmHarness.ts"

type Harness = Effect.Success<ReturnType<typeof lcmHarness>>
const price = (h: { api: Pick<Harness["api"], "GetCostSettings" | "SetCostSettings"> }) =>
  Effect.gen(function* () {
    const saved = yield* h.api.GetCostSettings()
    yield* h.api.SetCostSettings({
      expectedRevision: saved.revision,
      rules: ["primary-model", "judge-model"].map((model) => ({
        id: model === "judge-model" ? "judge" : "summary",
        name: "Summary pricing",
        kind: "openai-chat",
        connectionId: null,
        model,
        upstream: null,
        currency: "credits",
        rates: { input: 10, read: 2, write: 15, writeLong: 20, output: 40 },
        tiers: []
      }))
    })
  })
const summaries = (h: { config: { dataDir: string } }, chatId: ChatId) =>
  fixtureSql(h.config.dataDir, [
    {
      sql: "SELECT id,selected_revision_id AS revision FROM summaries WHERE chat_id=? ORDER BY created_at,id",
      params: [chatId]
    }
  ]).pipe(Effect.map(([rows]) => rows! as Array<{ id: Summary["id"]; revision: Summary["revisionId"] }>))
const priced = (details: SummaryDetails) => {
  assert.isNotNull(details.request)
  assert.isNotEmpty(details.generations!)
  for (const request of details.requests) {
    assert.equal(request.usageSource, "reported")
    assert.equal(request.cost!.currency, "credits")
    assert.include(request.cost!.formula, "user:summary:")
    const c = request.counts
    assert.approximately(
      request.cost!.amount,
      ((c.inputUncached ?? 0) * 10 + (c.cacheRead ?? 0) * 2 + (c.cacheWrite ?? 0) * 15 + (c.output ?? 0) * 40) / 1e6,
      1e-10
    )
  }
  const generation = details.generations!.at(-1)!
  assert.equal(generation.responses.length, details.requests.length)
  assert.isNotEmpty(generation.responses[0]!.response)
}

lcmTest("leaf, condensation and repaired revisions retain model, usage, user prices and captured requests", (server) =>
  Effect.gen(function* () {
    const h = yield* lcmHarness(server, {
      messages: 12,
      settings: { fanout: 3 },
      summarizer: () => ({
        text: "A summary.",
        usage: { prompt_tokens: 100, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 30 } }
      })
    })
    yield* price(h)
    for (let n = 0; n < 3; n++) {
      yield* h.enqueue(n * 2, n * 2 + 1)
      yield* h.drain
    }
    yield* h.plan("completion")
    yield* h.drain
    const before = yield* summaries(server, h.chat.id)
    assert.lengthOf(before, 4)
    for (const row of before) {
      const details = yield* h.api.GetSummaryRevisionRequest({ revisionId: row.revision })
      priced(details)
      assert.equal(details.model, "primary-model")
      assert.equal(details.requests[0]!.connectionId, h.connection.id)
      assert.equal(details.requests[0]!.counts.inputUncached, 70)
      assert.equal(details.requests[0]!.counts.cacheRead, 30)
      assert.equal(details.requests[0]!.counts.output, 12)
      const read = yield* h.api.GetSummary({ summaryId: row.id })
      assert.equal(read.rolloutId, details.generations!.at(-1)!.rolloutId)
      const revisions = yield* h.api.ListSummaryRevisions({ summaryId: row.id })
      assert.deepStrictEqual(revisions[0]!.requests, details.requests)
    }
    const source = h.rows[2]!
    yield* h.api.EditVersion({
      slotId: source.slotId,
      sourceVersionId: source.version.id,
      content: "The road changed.",
      expectedRowVersion: 1
    })
    assert.lengthOf(yield* h.plan("reply"), 1)
    yield* h.drain
    yield* h.plan("completion")
    yield* h.drain
    const repaired = (yield* summaries(server, h.chat.id)).filter((r) => !before.some((b) => b.id === r.id))
    assert.lengthOf(repaired, 2)
    for (const row of repaired) priced(yield* h.api.GetSummaryRevisionRequest({ revisionId: row.revision }))
    const original = before[0]!
    const read = yield* h.api.GetSummary({ summaryId: original.id })
    const edited = yield* h.api.EditSummary({
      summaryId: read.id,
      content: "Edited summary.",
      expectedRowVersion: read.rowVersion,
      commitDraft: null
    })
    const editedDetails = yield* h.api.GetSummaryRevisionRequest({ revisionId: edited.summary.revisionId })
    assert.isNull(editedDetails.request)
    assert.deepStrictEqual(editedDetails.requests, [])
    assert.deepStrictEqual(editedDetails.generations, [])
    const calls = h.mock.requests().length
    priced(yield* h.api.GetSummaryRevisionRequest({ revisionId: original.revision }))
    assert.equal(h.mock.requests().length, calls, "historical reads never call a provider")
    const ledgerIds = (yield* h.api.ListLlmRequests({ limit: 1000, before: null })).map((r) => r.id)
    const item = yield* h.writer.DeleteChat({ userId: h.userId, chatId: h.chat.id })
    yield* h.writer.PurgeBinItem({ userId: h.userId, itemId: item.id })
    const [captures] = yield* fixtureSql(h.dataDir, [{ sql: "SELECT count(*) AS n FROM summary_responses" }])
    assert.equal(captures![0]!.n, 0)
    assert.deepStrictEqual(
      (yield* h.api.ListLlmRequests({ limit: 1000, before: null })).map((r) => r.id),
      ledgerIds
    )
  })
)

for (const mode of ["soft refusal", "hard refusal", "failure", "retry"] as const)
  lcmTest(`${mode} retains every attempt's usage and captured response against its resulting revision`, (server) =>
    Effect.gen(function* () {
      let calls = 0
      const h = yield* lcmHarness(server, {
        summarizer: () => {
          calls++
          if (mode === "failure") return { status: 400 }
          if (mode === "hard refusal") return { refusal: true, usage: { prompt_tokens: 100, completion_tokens: 12 } }
          return { text: mode === "retry" && calls > 1 ? "Recovered summary." : PLANTED }
        }
      })
      yield* h.defaults({ judge: h.judge })
      yield* price(h)
      yield* h.enqueue(0, 5)
      yield* h.drain
      const [row] = yield* summaries(server, h.chat.id)
      assert.isDefined(row)
      const details = yield* h.api.GetSummaryRevisionRequest({ revisionId: row!.revision })
      assert.lengthOf(details.generations!, mode === "retry" ? 2 : 3)
      const requests = details.generations!.flatMap((g) => g.requests)
      assert.equal(requests.filter((r) => r.purpose === "summarize").length, calls)
      for (const generation of details.generations!) {
        assert.isNotNull(generation.request)
        assert.equal(generation.responses.length, generation.requests.filter((r) => r.purpose === "summarize").length)
        for (const request of generation.requests) {
          assert.equal(request.connectionId, h.connection.id)
          if (mode !== "failure") {
            assert.equal(request.usageSource, "reported")
            assert.equal(request.counts.inputUncached, 100)
            assert.equal(request.counts.output, 12)
            assert.include(request.cost!.formula, `user:${request.purpose === "decision" ? "judge" : "summary"}:`)
          } else assert.isNull(request.counts.inputUncached, "unreported usage remains unknown")
        }
      }
      const all = yield* h.api.ListLlmRequests({ limit: 1000, before: null })
      assert.equal(requests.length, all.filter((r) => r.chatId === h.chat.id).length)
    })
  )

lcmTest("backfill revisions expose reported cache tokens, user pricing and their stored request", (server) =>
  Effect.gen(function* () {
    const h = yield* environment(server, ["Synthetic summary cost"])
    yield* price(h)
    const p = yield* h.prepare("Synthetic summary cost")
    const at = { chatId: p.chatId, leafSlotId: p.leaf }
    const offer = yield* h.api.GetLcmEnableOffer(at)
    yield* h.api.EnableLcm({
      ...at,
      choice: "scratch",
      approved: {
        ...offer.fromScratch,
        uncachedInput: offer.fromScratch.uncachedInput * 100,
        cost: offer.fromScratch.cost ? { ...offer.fromScratch.cost, amount: offer.fromScratch.cost.amount * 100 } : null
      }
    })
    yield* h.settle(p.chatId, p.leaf)
    const rows = yield* summaries(server, p.chatId)
    assert.isNotEmpty(rows)
    let cached = false
    for (const row of rows) {
      const details = yield* h.api.GetSummaryRevisionRequest({ revisionId: row.revision })
      priced(details)
      cached ||= details.requests.some((r) => (r.counts.cacheRead ?? 0) > 0)
    }
    assert.isTrue(cached)
  }).pipe(Effect.scoped)
)

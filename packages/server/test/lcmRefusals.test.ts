import { assert } from "@effect/vitest"
import type { SlotId, Version } from "@dreamspan/shared/chat.ts"
import { Effect } from "effect"
import type { ContextSnapshot } from "../src/assembler/types.ts"
import { eventually } from "./support/generation.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { lcmHarness, lcmTest, PLANTED, requestsTo } from "./support/lcmHarness.ts"

// The only refusals are the provider's own signal and a judge model's verdict (spec/LCM.md §2.4).
const sorry = "I'm sorry, but I can't help with that. As an AI, I cannot continue this story."

const summaries = (dataDir: string, chatId: string) =>
  fixtureSql(dataDir, [
    {
      sql: `SELECT s.id,s.status,s.error_json,s.level,r.content,r.origin FROM summaries s
        JOIN summary_revisions r ON r.id=s.selected_revision_id WHERE s.chat_id=? ORDER BY s.created_at,s.id`,
      params: [chatId]
    }
  ]).pipe(Effect.map(([rows]) => rows!))

lcmTest(
  "without a judge model only a provider's refusal is detected: a summary that reads like a refusal is saved",
  (server) =>
    Effect.gen(function* () {
      const h = yield* lcmHarness(server, { summarizer: () => ({ text: sorry }) })
      yield* h.enqueue(0, 5)
      yield* h.drain
      const rows = yield* summaries(h.dataDir, h.chat.id)
      assert.lengthOf(rows, 1)
      assert.strictEqual(rows[0]!.status, "complete")
      assert.strictEqual(rows[0]!.content, sorry, "no phrase list or length rule looks at the text")
      assert.lengthOf(requestsTo(h.mock, "judge-model"), 0)
    })
)

lcmTest(
  "the judge decides soft refusals: it clears refusal-sounding text and rejects the planted one, which is never saved",
  (server) =>
    Effect.gen(function* () {
      const h = yield* lcmHarness(server, {
        messages: 14,
        summarizer: (r) => ({
          text: JSON.stringify(r.body!.messages).includes("Message 1.") ? sorry : `${PLANTED} nope`
        })
      })
      yield* h.defaults({ judge: h.judge })
      // The first chunk is answered with refusal-sounding words the judge clears; the second with the planted refusal.
      yield* h.enqueue(0, 3)
      yield* h.runNext
      const [first] = yield* summaries(h.dataDir, h.chat.id)
      assert.strictEqual(first!.content, sorry)
      assert.strictEqual(first!.status, "complete")
      yield* h.enqueue(8, 11)
      yield* h.drain
      const rows = yield* summaries(h.dataDir, h.chat.id)
      assert.isFalse(
        rows.some((r) => String(r.content).includes(PLANTED)),
        "invariant 5: no refusal saved"
      )
      assert.isAbove(requestsTo(h.mock, "judge-model").length, 3, "every attempt's output was judged")
      const failed = rows.find((r) => r.status === "failed")!
      assert.deepInclude(JSON.parse(failed.error_json as string), { class: "refused", kind: "soft" })
      assert.strictEqual(failed.content, "")
      // The judge's requests are in the ledger as decisions, attributed to the chat.
      const [ledger] = yield* fixtureSql(h.dataDir, [
        { sql: "SELECT count(*) AS n FROM llm_requests WHERE chat_id=? AND purpose='decision'", params: [h.chat.id] }
      ])
      assert.isAtLeast(Number(ledger![0]!.n), 4)
    })
)

lcmTest(
  "a summary retries, then tries the fallback model once, then fails and leaves the originals in the context",
  (server) =>
    Effect.gen(function* () {
      const h = yield* lcmHarness(server, {
        summarizer: () => ({ refusal: true }),
        fallback: () => ({ refusal: true })
      })
      yield* h.defaults({ fallback: h.fallback })
      const job = yield* h.enqueue(0, 5)
      const ran = yield* h.drain
      assert.strictEqual(ran.length, 4, "max_retries 2 on the summarizer's model, then one attempt on the fallback")
      assert.lengthOf(requestsTo(h.mock, "primary-model"), 3)
      assert.lengthOf(requestsTo(h.mock, "fallback-model"), 1)
      const [row] = (yield* fixtureSql(h.dataDir, [
        {
          sql: "SELECT status,fallback_used,model_json,result_summary_id FROM summarization_jobs WHERE id=?",
          params: [job.id]
        }
      ]))[0]!
      assert.strictEqual(row!.status, "failed")
      assert.strictEqual(row!.fallback_used, 1)
      const failed = yield* summaries(h.dataDir, h.chat.id)
      assert.lengthOf(failed, 1)
      assert.strictEqual(failed[0]!.id, row!.result_summary_id)
      assert.deepInclude(JSON.parse(failed[0]!.error_json as string), { class: "refused", kind: "hard" })
      // Failed summaries never replace messages that fit.
      const leaf = h.rows.at(-1)!
      const assembled = yield* h.reader.AssembleContext({
        userId: h.userId,
        chatId: h.chat.id,
        slotId: leaf.slotId,
        versionId: leaf.version.id,
        now: 1,
        timeZone: "UTC",
        frozen: null
      })
      const snapshot = JSON.parse(assembled.snapshot) as ContextSnapshot
      assert.lengthOf(snapshot.lcm!.selected, 0)
      assert.isTrue(snapshot.request.messages.some((m) => m.content.includes("Message 0.")))
    })
)

lcmTest("a refused summary falls back to the fallback model, whose answer is the summary", (server) =>
  Effect.gen(function* () {
    const h = yield* lcmHarness(server, { summarizer: () => ({ text: `${PLANTED} cannot` }) })
    yield* h.defaults({ judge: h.judge, fallback: h.fallback })
    const account = yield* h.api.AddUserModel({
      connectionId: h.connection.id,
      key: "account-summary",
      overrides: { context: 8192, settings: { samplers: { openai_max_tokens: 512 } } }
    })
    yield* h.api.ChangeGenerationDefaults({
      change: { summarizer: { connection: h.connection.id, model: account.id } }
    })
    const job = yield* h.enqueue(0, 5)
    yield* h.drain
    const [row] = (yield* fixtureSql(h.dataDir, [
      { sql: "SELECT status,model_json,result_summary_id FROM summarization_jobs WHERE id=?", params: [job.id] }
    ]))[0]!
    assert.strictEqual(row!.status, "complete")
    assert.deepStrictEqual(JSON.parse(row!.model_json as string), {
      connection: h.fallback.connection,
      model: h.fallback.model
    })
    const rows = yield* summaries(h.dataDir, h.chat.id)
    assert.lengthOf(rows, 1)
    assert.strictEqual(rows[0]!.content, "A fallback summary.")
    assert.strictEqual(rows[0]!.status, "complete")
  })
)

lcmTest("a judge that fails or gives no verdict fails the attempt: nothing unchecked is saved", (server) =>
  Effect.gen(function* () {
    for (const judge of [{ status: 500 }, { text: "I am not sure." }] as const) {
      const h = yield* lcmHarness(server, { judge: () => judge })
      yield* h.defaults({ judge: h.judge })
      yield* h.enqueue(0, 5)
      yield* h.drain
      const rows = yield* summaries(h.dataDir, h.chat.id)
      assert.deepStrictEqual(
        rows.map((r) => r.status),
        ["failed"]
      )
      assert.strictEqual(JSON.parse(rows[0]!.error_json as string).class, "judge")
    }
  })
)

lcmTest(
  "Retry with… another model is a request the next reply answers: the click starts nothing, the failure stays",
  (server) =>
    Effect.gen(function* () {
      const h = yield* lcmHarness(server, { summarizer: () => ({ status: 400 }) })
      yield* h.api.ChangeGenerationDefaults({ change: { summarizer: h.primary } })
      const first = yield* h.enqueue(0, 5)
      yield* h.drain
      const [failed] = yield* summaries(h.dataDir, h.chat.id)
      assert.strictEqual(failed!.status, "failed")
      const calls = () => requestsTo(h.mock, "fallback-model").length
      const asked = (target: { _tag: "Summary"; summaryId: never } | { _tag: "Job"; jobId: string }) =>
        h.api.SetSummaryRerun({ chatId: h.chat.id, target, requested: true, model: h.fallback })
      yield* asked({ _tag: "Summary", summaryId: failed!.id as never })
      const jobs = () =>
        fixtureSql(h.dataDir, [
          { sql: "SELECT count(*) AS n FROM summarization_jobs WHERE chat_id=?", params: [h.chat.id] }
        ]).pipe(Effect.map(([rows]) => Number(rows![0]!.n)))
      assert.strictEqual(yield* jobs(), 1, "the click made no job")
      assert.lengthOf(yield* h.plan("completion"), 0, "a finished job does not answer it")
      // The reply's pass does: one interactive-free job on the chosen model, and the row is withdrawn.
      const made = yield* h.plan("reply")
      assert.lengthOf(made, 1)
      const job = yield* h.runNext
      assert.strictEqual(job!.id, made[0]!.id)
      const rows = yield* summaries(h.dataDir, h.chat.id)
      assert.deepStrictEqual(
        rows.map((r) => r.status),
        ["failed", "complete"]
      )
      assert.strictEqual(rows[1]!.content, "A fallback summary.")
      assert.strictEqual(calls(), 1)
      const [left] = yield* fixtureSql(h.dataDir, [
        {
          sql: "SELECT count(*) AS n FROM fork_overrides WHERE chat_id=? AND kind='summary_rerun' AND flag=1",
          params: [h.chat.id]
        }
      ])
      assert.strictEqual(Number(left![0]!.n), 0)
      // A job that gave up is retried the same way (the first job's row, which ended in the failed summary).
      yield* asked({ _tag: "Job", jobId: first.id })
      assert.lengthOf(yield* h.plan("reply"), 1)
    })
)

lcmTest(
  "a judge marks a refused reply and leaves its text; a provider's refusal is a failed version; Retry with… uses another model",
  (server) =>
    Effect.gen(function* () {
      const h = yield* lcmHarness(server, {
        summarizer: (r) =>
          JSON.stringify(r.body).includes("hard refusal please")
            ? { refusal: true }
            : { text: `${PLANTED} I will not.` }
      })
      yield* h.defaults({ judge: h.judge })
      const generate = (text: string) =>
        Effect.gen(function* () {
          const active = (yield* h.reader.GetChat({ userId: h.userId, chatId: h.chat.id })).activeLeafSlotId
          const leaf = (yield* h.append(text, active)).slotId
          const sent = yield* h.api.Generate({ chatId: h.chat.id, parentSlotId: leaf, branch: false })
          assert.strictEqual(sent._tag, "Posted")
          return sent._tag === "Posted" ? sent.entry : undefined!
        })
      /** The versions of a slot once `done` holds for one of them. */
      const settle = (slotId: SlotId, done: (v: Version) => boolean) =>
        Effect.gen(function* () {
          for (let n = 0; n < 300; n++) {
            const versions = yield* h.api.ListVersions({ slotId })
            const found = versions.find(done)
            if (found) return found
            yield* Effect.sleep(20)
          }
          return yield* Effect.die(new Error("timed out waiting for a version"))
        })
      const refused = yield* generate("Go on.")
      const marked = yield* settle(refused.slotId, (v) => v.status === "complete" && v.mark === "refused")
      assert.include(marked.content, PLANTED, "the text stays")
      // The path the client reads carries the mark too.
      const path = yield* h.api.ReadPath({ chatId: h.chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 5 })
      assert.strictEqual(path.entries.find((e) => e.slotId === refused.slotId)?.version.mark, "refused")
      // Retry with… the fallback model: its reply is clear, so it is not marked.
      yield* h.api.Regenerate({ slotId: refused.slotId, expectedRowVersion: refused.rowVersion, model: h.fallback })
      const retried = yield* settle(refused.slotId, (v) => v.id !== marked.id && v.status === "complete")
      assert.strictEqual(retried.content, "A fallback summary.")
      assert.lengthOf(requestsTo(h.mock, "fallback-model"), 1)
      yield* Effect.sleep(200)
      assert.isNull((yield* h.api.ListVersions({ slotId: refused.slotId })).find((v) => v.id === retried.id)!.mark)
      // A provider's own refusal stays a failed version, with its class; the judge is not asked.
      const judged = requestsTo(h.mock, "judge-model").length
      const hard = yield* generate("hard refusal please")
      const failed = yield* settle(hard.slotId, (v) => v.status === "failed")
      assert.strictEqual(failed.error?.class, "refused")
      assert.isNull(failed.mark)
      assert.strictEqual(requestsTo(h.mock, "judge-model").length, judged)
    })
)

lcmTest("a reply is not judged, and so not marked, without a judge model", (server) =>
  Effect.gen(function* () {
    const h = yield* lcmHarness(server, { summarizer: () => ({ text: `${PLANTED} I will not.` }) })
    const leaf = (yield* h.append("Go on.")).slotId
    yield* h.api.Generate({ chatId: h.chat.id, parentSlotId: leaf, branch: false })
    yield* eventually(() => requestsTo(h.mock, "primary-model").length > 0)
    yield* Effect.sleep(300)
    assert.lengthOf(requestsTo(h.mock, "judge-model"), 0)
  })
)

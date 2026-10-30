// Real summary requests over inserted messages (spec/MESSAGE-INSERT.md §3.2, §3.4), through the
// summarizer and the mock provider: a chunk holding an inserted message renders whole and
// completes, and the next reply's request sends the summary, then the raw history after it in
// display order. Inside a range, at a seam, above the first message, and with the layer's cursor
// on an inserted message.
import { assert } from "@effect/vitest"
import type { SlotId } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import type { ContextSnapshot } from "../src/assembler/types.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { lcmHarness, lcmTest, requestsTo } from "./support/lcmHarness.ts"
import type { Recorded } from "./support/mockProvider.ts"

const texts = (request: Recorded) =>
  ((request.body?.messages ?? []) as Array<{ content: string | Array<{ text?: string }> }>)
    .map((m) => (typeof m.content === "string" ? m.content : m.content.map((p) => p.text ?? "").join("")))
    .join("\n")

/** The order `needles` appear in `haystack` (each must appear). */
const order = (haystack: string, needles: ReadonlyArray<string>) =>
  needles.map((n) => {
    const at = haystack.indexOf(n)
    assert.isAtLeast(at, 0, `missing ${n}`)
    return at
  })
const ascending = (positions: ReadonlyArray<number>) =>
  assert.deepStrictEqual(
    [...positions],
    [...positions].sort((a, b) => a - b)
  )

const harness = (server: Parameters<typeof lcmHarness>[0]) =>
  Effect.gen(function* () {
    const h = yield* lcmHarness(server, {
      messages: 6,
      // Names the raw messages it was sent ("Message 2. …"), not those in summaries it was sent.
      // A condensation names what its parts named.
      summarizer: (request) => {
        const sent = [...texts(request).matchAll(/(Message \d|Inserted \w+)\. /g)].map((m) => m[1])
        const parts = [...texts(request).matchAll(/SUMMARY\(([^)]*)\)/g)].map((m) => m[1])
        return { text: `SUMMARY(${(sent.length ? sent : parts).join(",")})` }
      }
    })
    const forkId = h.chat.currentForkId!
    const insert = (anchor: SlotId | null, content: string) =>
      Effect.gen(function* () {
        const expected =
          anchor === null ? 0 : (yield* h.reader.GetSlot({ userId: h.userId, slotId: anchor, forkId })).entry.rowVersion
        return (yield* h.writer.InsertMessage({
          userId: h.userId,
          chatId: h.chat.id,
          forkId,
          anchorSlotId: anchor,
          expectedRowVersion: expected,
          body: { _tag: "Write", speaker: null, content: `${content}. ` + "A lantern swung. ".repeat(10) }
        })).slotId
      })
    /** One L1 job over these slots, in the order given, run through the summarizer. */
    const summarize = (slots: ReadonlyArray<SlotId>) =>
      Effect.gen(function* () {
        const path = yield* h.reader.GetPath({ userId: h.userId, chatId: h.chat.id, leafSlotId: null, limit: 500 })
        const inputs = slots.map((slotId) => {
          const entry = path.entries.find((e) => e.slotId === slotId)!
          return { slotId, versionId: entry.version.id, amendCount: entry.version.rowVersion - 1 }
        })
        const [job] = yield* h.writer.EnqueueSummaries({
          userId: h.userId,
          chatId: h.chat.id,
          forkId,
          leafSlotId: h.rows.at(-1)!.slotId,
          chunks: [{ inputs, target: 100 }],
          requestClass: "interactive"
        })
        assert.isDefined(job, "enqueued")
        const ran = yield* h.runNext
        assert.strictEqual(ran?.id, job!.id)
        return job!
      })
    const layer = Effect.gen(function* () {
      return yield* h.reader.GetLcmState({
        userId: h.userId,
        chatId: h.chat.id,
        forkId,
        leafSlotId: h.rows.at(-1)!.slotId
      })
    })
    /** The next reply's request, as sent: append a reply and assemble it. */
    const reply = Effect.gen(function* () {
      const row = yield* h.append("Message 9. The reply.")
      const built = JSON.parse(
        (yield* h.reader.AssembleContext({
          userId: h.userId,
          chatId: h.chat.id,
          forkId,
          slotId: row.slotId,
          versionId: row.version.id,
          now: 1,
          timeZone: "UTC",
          frozen: null
        })).snapshot
      ) as ContextSnapshot
      return built.request.messages
        .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
        .join("\n")
    })
    const summaryRequests = () => requestsTo(h.mock, "primary-model")
    return { ...h, forkId, insert, summarize, layer, reply, summaryRequests }
  })

const raw = (n: number | string) => (typeof n === "number" ? `Message ${n}. The road` : `${n}. A lantern`)

lcmTest("a summary request over a range holding an inserted message renders it and completes", (server) =>
  Effect.gen(function* () {
    const h = yield* harness(server)
    const [m0, m1, m2] = h.rows.map((r) => r.slotId)
    const x = yield* h.insert(m1!, "Inserted X")
    const job = yield* h.summarize([m0!, m1!, x, m2!])
    const sent = h.summaryRequests()
    assert.lengthOf(sent, 1)
    ascending(order(texts(sent[0]!), [raw(0), raw(1), raw("Inserted X"), raw(2)]))
    const state = yield* h.layer
    assert.deepStrictEqual(
      state.layer.map((s) => [s.from, s.to, s.fresh, s.lastSlotId]),
      [[1, 4, true, m2]]
    )
    assert.strictEqual(state.cursorPosition, 3)
    assert.notInclude(
      state.jobs.map((j) => j.id),
      job.id
    )
    const request = yield* h.reply
    ascending(order(request, ["SUMMARY(Message 0,Message 1,Inserted X,Message 2)", raw(3), raw(4), raw(5)]))
    for (const gone of [raw(0), raw(1), raw("Inserted X"), raw(2)]) assert.notInclude(request, gone)
  })
)

lcmTest("the layer's cursor on an inserted message: the reply's history starts right after it", (server) =>
  Effect.gen(function* () {
    const h = yield* harness(server)
    const [m0, m1] = h.rows.map((r) => r.slotId)
    const x = yield* h.insert(m1!, "Inserted X")
    yield* h.summarize([m0!, m1!, x])
    ascending(order(texts(h.summaryRequests()[0]!), [raw(0), raw(1), raw("Inserted X")]))
    assert.notInclude(texts(h.summaryRequests()[0]!), raw(2))
    const state = yield* h.layer
    assert.strictEqual(state.cursorSlotId, x)
    assert.strictEqual(state.cursorPosition, 2)
    // Inserted below the cursor (in its gap): raw, directly after the summary, before m2.
    yield* h.insert(x, "Inserted Y")
    const request = yield* h.reply
    ascending(
      order(request, ["SUMMARY(Message 0,Message 1,Inserted X)", raw("Inserted Y"), raw(2), raw(3), raw(4), raw(5)])
    )
    for (const gone of [raw(0), raw(1), raw("Inserted X")]) assert.notInclude(request, gone)
  })
)

lcmTest("at a seam the earlier summary is written again over the gap through a real request", (server) =>
  Effect.gen(function* () {
    const h = yield* harness(server)
    const [m0, m1, m2, m3] = h.rows.map((r) => r.slotId)
    yield* h.summarize([m0!, m1!])
    yield* h.summarize([m2!, m3!])
    yield* h.insert(m1!, "Inserted X")
    const seam = yield* h.layer
    assert.deepStrictEqual(
      seam.layer.map((s) => [s.from, s.to, s.fresh]),
      [
        [1, 3, false],
        [4, 5, true]
      ]
    )
    const ran = yield* h.settle
    assert.lengthOf(ran, 1)
    const sent = h.summaryRequests().at(-1)!
    ascending(order(texts(sent), [raw(0), raw(1), raw("Inserted X")]))
    assert.notInclude(texts(sent), raw(2))
    const after = yield* h.layer
    assert.deepStrictEqual(
      after.layer.map((s) => [s.from, s.to, s.fresh]),
      [
        [1, 3, true],
        [4, 5, true]
      ]
    )
    const request = yield* h.reply
    ascending(
      order(request, ["SUMMARY(Message 0,Message 1,Inserted X)", "SUMMARY(Message 2,Message 3)", raw(4), raw(5)])
    )
    for (const gone of [raw(0), raw(1), raw("Inserted X"), raw(2), raw(3)]) assert.notInclude(request, gone)
  })
)

lcmTest("above the first message the first summary is written again from the inserted message", (server) =>
  Effect.gen(function* () {
    const h = yield* harness(server)
    const [m0, m1] = h.rows.map((r) => r.slotId)
    yield* h.summarize([m0!, m1!])
    const x = yield* h.insert(null, "Inserted X")
    assert.deepStrictEqual(
      (yield* h.layer).layer.map((s) => [s.from, s.to, s.fresh, s.firstSlotId]),
      [[1, 3, false, x]]
    )
    const ran = yield* h.settle
    assert.lengthOf(ran, 1)
    ascending(order(texts(h.summaryRequests().at(-1)!), [raw("Inserted X"), raw(0), raw(1)]))
    assert.deepStrictEqual(
      (yield* h.layer).layer.map((s) => [s.from, s.to, s.fresh, s.firstSlotId]),
      [[1, 3, true, x]]
    )
    const request = yield* h.reply
    ascending(order(request, ["SUMMARY(Inserted X,Message 0,Message 1)", raw(2), raw(3), raw(4), raw(5)]))
    for (const gone of [raw(0), raw(1), raw("Inserted X")]) assert.notInclude(request, gone)
  })
)

lcmTest("condensations over parts with an inserted message in them or between them", (server) =>
  Effect.gen(function* () {
    const h = yield* harness(server)
    const [m0, m1, m2, m3] = h.rows.map((r) => r.slotId)
    const x = yield* h.insert(m1!, "Inserted X")
    yield* h.summarize([m0!, m1!, x])
    yield* h.summarize([m2!, m3!])
    const parts = (yield* h.layer).layer
    assert.deepStrictEqual(
      parts.map((s) => [s.from, s.to]),
      [
        [1, 3],
        [4, 5]
      ]
    )
    const [made] = yield* h.writer.EnqueueCondensations({
      userId: h.userId,
      chatId: h.chat.id,
      forkId: h.forkId,
      leafSlotId: h.rows.at(-1)!.slotId,
      requestClass: "interactive",
      jobs: [{ level: 2, children: parts.map((s) => s.id), target: 100, eager: false }]
    })
    assert.isDefined(made)
    // Inserted between the parts after the job was queued: it still condenses them.
    yield* h.insert(x, "Inserted Y")
    const ran = yield* h.runNext
    assert.strictEqual(ran?.id, made!.id)
    const sent = texts(h.summaryRequests().at(-1)!)
    ascending(order(sent, ["SUMMARY(Message 0,Message 1,Inserted X)", "SUMMARY(Message 2,Message 3)"]))
    for (const gone of [raw(0), raw("Inserted X"), raw("Inserted Y"), raw(2)]) assert.notInclude(sent, gone)
    const [done] = yield* fixtureSql(
      h.dataDir,
      [{ sql: "SELECT status FROM summarization_jobs WHERE id = ?", params: [made!.id] }],
      { readOnly: true }
    )
    assert.deepStrictEqual(done, [{ status: "complete" }])
    // Y is a seam in the fork now: the next reply's planning writes the first part again over
    // it, then condenses the new part with the second.
    const settled = yield* h.settle
    assert.deepStrictEqual(
      settled.map((j) => j.level),
      [1, 2]
    )
    const sentAgain = h.summaryRequests().map(texts)
    ascending(order(sentAgain.at(-2)!, [raw(0), raw(1), raw("Inserted X"), raw("Inserted Y")]))
    assert.notInclude(sentAgain.at(-2)!, raw(2))
    ascending(
      order(sentAgain.at(-1)!, ["SUMMARY(Message 0,Message 1,Inserted X,Inserted Y)", "SUMMARY(Message 2,Message 3)"])
    )
    assert.deepStrictEqual(
      (yield* h.layer).layer.map((s) => [s.level, s.from, s.to, s.fresh]),
      [[2, 1, 6, true]]
    )
    const request = yield* h.reply
    ascending(
      order(request, ["SUMMARY(Message 0,Message 1,Inserted X,Inserted Y,Message 2,Message 3)", raw(4), raw(5)])
    )
    for (const gone of [raw(0), raw("Inserted X"), raw("Inserted Y"), raw(2), raw(3)]) assert.notInclude(request, gone)
  })
)

lcmTest("a failed range holding an inserted message is one marker over its display positions", (server) =>
  Effect.gen(function* () {
    const h = yield* lcmHarness(server, { messages: 0, summarizer: () => ({ refusal: true }) })
    for (let n = 0; n < 16; n++) yield* h.append(`Failed original ${n}. ` + "x".repeat(1000))
    yield* h.writer.InsertMessage({
      userId: h.userId,
      chatId: h.chat.id,
      forkId: h.chat.currentForkId!,
      anchorSlotId: h.rows[7]!.slotId,
      expectedRowVersion: 1,
      body: { _tag: "Write", speaker: null, content: "Failed inserted. " + "z".repeat(1000) }
    })
    yield* h.append("target")
    yield* h.enqueue(0, 16)
    yield* h.drain
    for (let n = 0; n < 20; n++) yield* h.append(`Recent ${n}. ` + "y".repeat(1000))
    yield* h.append("target")
    const snapshot = JSON.parse(
      (yield* h.reader.AssembleContext({
        userId: h.userId,
        chatId: h.chat.id,
        slotId: h.rows.at(-1)!.slotId,
        versionId: h.rows.at(-1)!.version.id,
        now: 1,
        timeZone: "UTC",
        frozen: null
      })).snapshot
    ) as ContextSnapshot
    const text = snapshot.request.messages.map((m) => m.content).join("\n")
    assert.include(text, "[Messages 1–17 could not be summarized.]")
    assert.notInclude(text, "Failed original")
    assert.notInclude(text, "Failed inserted")
    assert.isAtLeast(snapshot.historyStart!.depth, 17)
    assert.deepStrictEqual(snapshot.lcm!.failures, [{ from: 1, to: 17 }])
  })
)

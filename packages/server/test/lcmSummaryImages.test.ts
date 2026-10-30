// The images a summary was written with are part of its freshness (ARCHITECTURE §16 "Images").
// A summary written in a fork that sends an image is stale in a fork that took the image out,
// and the reverse, so an image taken out of one fork never reaches it through a summary written
// in another; each fork gets its own summary over the same inputs, by the existing rewrite rule.
import { assert } from "@effect/vitest"
import type { ForkId, SlotId } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import type { SummaryId } from "@rp/shared/lcm.ts"
import type { ContextSnapshot } from "../src/assembler/types.ts"
import { serverPort } from "./support/config.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { lcmHarness, lcmTest, requestsTo } from "./support/lcmHarness.ts"
import { png, textChunk } from "./formats/support.ts"

const base64 = (tag: string) => Buffer.from(png(textChunk("fixture", tag))).toString("base64")

/** The summarizer says which of the drawings it saw, so each summary's text shows its images. */
const seen = (body: string) =>
  `Saw ${["first", "second"].filter((tag) => body.includes(base64(tag))).join(" and ") || "no drawing"}.`

const setup = (server: Parameters<typeof lcmHarness>[0], maxImages: number) =>
  Effect.gen(function* () {
    const h = yield* lcmHarness(server, {
      messages: 6,
      summarizer: (request) => ({ text: seen(JSON.stringify(request.body)) })
    })
    const model = (yield* h.api.ListModels({ connectionId: h.connection.id, includeHidden: true })).find(
      (m) => m.id === h.primary.model
    )!
    yield* h.api.EditModel({
      modelId: model.id,
      expectedRowVersion: model.rowVersion,
      overrides: { ...model.overrides, vision: true, maxImages }
    })
    const port = yield* serverPort
    const upload = (tag: string) =>
      Effect.promise(async () => {
        const response = await fetch(`http://127.0.0.1:${port}/chat/image`, {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: png(textChunk("fixture", tag))
        })
        assert.strictEqual(response.status, 200)
        return (await response.json()) as { mediaId: string }
      })
    const first = yield* upload("first"),
      second = yield* upload("second")
    const row = h.rows[1]!
    const edited = yield* h.api.EditVersion({
      slotId: row.slotId,
      sourceVersionId: row.version.id,
      expectedRowVersion: 1,
      content: "Two drawings.",
      images: [first, second]
    })
    const f = h.chat.currentForkId! as ForkId
    const g = (yield* h.writer.CreateFork({
      userId: h.userId,
      chatId: h.chat.id,
      fromForkId: f,
      atSlotId: h.rows.at(-1)!.slotId
    })).fork.id as ForkId
    const exclude = (forkId: ForkId, media: { mediaId: string }, excluded = true) =>
      h.api.SetImageExcluded({ versionId: edited.version.id, mediaId: media.mediaId, forkId, excluded })
    /** Enqueues the first two messages as a summary in `forkId` and runs it; the job, or undefined when skipped. */
    const summarize = (forkId: ForkId) =>
      Effect.gen(function* () {
        const path = yield* h.reader.GetPath({
          userId: h.userId,
          chatId: h.chat.id,
          forkId,
          leafSlotId: null,
          limit: 10
        })
        const [job] = yield* h.writer.EnqueueSummaries({
          userId: h.userId,
          chatId: h.chat.id,
          forkId,
          leafSlotId: h.rows.at(-1)!.slotId,
          requestClass: "interactive",
          chunks: [
            {
              target: 100,
              inputs: path.entries
                .slice(0, 2)
                .map((e) => ({ slotId: e.slotId, versionId: e.version.id, amendCount: e.version.rowVersion - 1 }))
            }
          ]
        })
        if (job) assert.strictEqual((yield* h.runNext)?.id, job.id)
        return job
      })
    const lastBody = () => JSON.stringify(requestsTo(h.mock, "primary-model").at(-1)!.body)
    /** The summaries over the first two messages, oldest first. */
    const summaries = Effect.map(
      fixtureSql(
        h.dataDir,
        [
          {
            sql: "SELECT id, images_json FROM summaries WHERE chat_id = ? AND first_slot_id = ? ORDER BY created_at, id",
            params: [h.chat.id, h.rows[0]!.slotId]
          }
        ],
        { readOnly: true }
      ),
      ([rows]) => rows as Array<{ id: string; images_json: string | null }>
    )
    const fresh = (summaryId: string, forkId: ForkId) =>
      Effect.map(h.api.GetSummary({ summaryId: summaryId as typeof SummaryId.Type, forkId }), (s) => s.fresh)
    /** The next reply's request in `forkId`, as assembly builds it. */
    const reply = (forkId: ForkId) =>
      Effect.map(
        h.reader.AssembleContext({
          userId: h.userId,
          chatId: h.chat.id,
          slotId: h.rows.at(-1)!.slotId,
          versionId: h.rows.at(-1)!.version.id,
          forkId,
          now: 1,
          timeZone: "UTC",
          frozen: null
        }),
        (built) => JSON.stringify((JSON.parse(built.snapshot) as ContextSnapshot).request)
      )
    const plan = (forkId: ForkId) =>
      h.summarizer.planNow({ userId: h.userId, chatId: h.chat.id, leafSlotId: h.rows.at(-1)!.slotId, forkId }, "reply")
    return { h, f, g, first, second, exclude, summarize, lastBody, summaries, fresh, reply, plan }
  })

lcmTest("forks sharing inputs with an image taken out in one each get their own fresh summary", (server) =>
  Effect.gen(function* () {
    const t = yield* setup(server, 4)
    yield* t.exclude(t.f, t.second)

    // G's summary sends both drawings and is fresh there only.
    assert.isDefined(yield* t.summarize(t.g))
    assert.include(t.lastBody(), base64("second"))
    const [inG] = yield* t.summaries
    assert.deepStrictEqual(JSON.parse(inG!.images_json!), {
      limit: 4,
      sent: [t.first.mediaId, t.second.mediaId]
    })
    assert.isTrue(yield* t.fresh(inG!.id, t.g))
    assert.isFalse(yield* t.fresh(inG!.id, t.f))

    // F's enqueue over the same inputs isn't "already summarized"; its request leaves the drawing out.
    assert.isDefined(yield* t.summarize(t.f))
    const body = t.lastBody()
    assert.include(body, base64("first"))
    assert.notInclude(body, base64("second"))
    const [, inF] = yield* t.summaries
    assert.deepStrictEqual(JSON.parse(inF!.images_json!).sent, [t.first.mediaId])
    assert.isTrue(yield* t.fresh(inF!.id, t.f))
    assert.isFalse(yield* t.fresh(inF!.id, t.g))
    assert.isTrue(yield* t.fresh(inG!.id, t.g))

    // Each fork's next reply sends its own summary, and F's never the drawing.
    const fReply = yield* t.reply(t.f)
    assert.include(fReply, "Saw first.")
    assert.notInclude(fReply, "Saw first and second.")
    assert.notInclude(fReply, base64("second"))
    assert.include(yield* t.reply(t.g), "Saw first and second.")

    // Putting the drawing back makes F's own summary stale there and G's fresh again.
    yield* t.exclude(t.f, t.second, false)
    assert.isFalse(yield* t.fresh(inF!.id, t.f))
    assert.isTrue(yield* t.fresh(inG!.id, t.f))
    const back = yield* t.reply(t.f)
    assert.include(back, "Saw first and second.")
    assert.notInclude(back, "Saw first.")
    // ... and the planner has nothing to rewrite, since a fresh summary covers the range.
    assert.lengthOf(yield* t.plan(t.f), 0)
  }).pipe(Effect.scoped)
)

lcmTest("a summary written where an image is sent is rewritten on F's next reply", (server) =>
  Effect.gen(function* () {
    const t = yield* setup(server, 4)
    assert.isDefined(yield* t.summarize(t.g))
    const [inG] = yield* t.summaries
    assert.isTrue(yield* t.fresh(inG!.id, t.f))

    // Taking the drawing out in F makes G's summary stale there, as an edit does; F's next reply rewrites it.
    yield* t.exclude(t.f, t.second)
    assert.isFalse(yield* t.fresh(inG!.id, t.f))
    const jobs = yield* t.plan(t.f)
    assert.lengthOf(jobs, 1)
    assert.strictEqual(jobs[0]!.forkId, t.f)
    yield* t.h.drain
    assert.notInclude(t.lastBody(), base64("second"))
    const [, inF] = yield* t.summaries
    assert.isTrue(yield* t.fresh(inF!.id, t.f))
    const fReply = yield* t.reply(t.f)
    assert.include(fReply, "Saw first.")
    assert.notInclude(fReply, base64("second"))
    assert.lengthOf(yield* t.plan(t.f), 0)
    // G never planned anything over it: its own summary is still fresh there.
    assert.isTrue(yield* t.fresh(inG!.id, t.g))
    assert.lengthOf(yield* t.plan(t.g), 0)
  }).pipe(Effect.scoped)
)

lcmTest("an image the limit leaves out counts as not sent, like one taken out", (server) =>
  Effect.gen(function* () {
    // One image per request: the limit leaves the first drawing out of every summary request.
    const t = yield* setup(server, 1)
    assert.isDefined(yield* t.summarize(t.g))
    const body = t.lastBody()
    assert.include(body, base64("second"))
    assert.notInclude(body, base64("first"))
    const [inG] = yield* t.summaries
    assert.deepStrictEqual(JSON.parse(inG!.images_json!), { limit: 1, sent: [t.second.mediaId] })

    // Taking out the drawing the limit already left out changes nothing F would send: still fresh.
    yield* t.exclude(t.f, t.first)
    assert.isTrue(yield* t.fresh(inG!.id, t.f))
    assert.isDefined(yield* t.summarize(t.f).pipe(Effect.map((job) => job ?? "skipped")))
    assert.lengthOf(yield* t.summaries, 1, "F's enqueue was covered by G's summary")

    // Taking out the one it sent brings the first in under the limit: stale, and F's summary sends only that.
    yield* t.exclude(t.f, t.first, false)
    yield* t.exclude(t.f, t.second)
    assert.isFalse(yield* t.fresh(inG!.id, t.f))
    assert.isDefined(yield* t.summarize(t.f))
    const fBody = t.lastBody()
    assert.include(fBody, base64("first"))
    assert.notInclude(fBody, base64("second"))
    const [, inF] = yield* t.summaries
    assert.deepStrictEqual(JSON.parse(inF!.images_json!), { limit: 1, sent: [t.first.mediaId] })
    assert.isTrue(yield* t.fresh(inF!.id, t.f))
    assert.isFalse(yield* t.fresh(inF!.id, t.g))
  }).pipe(Effect.scoped)
)

lcmTest("a chat without images records nothing and keeps sharing summaries across forks", (server) =>
  Effect.gen(function* () {
    const h = yield* lcmHarness(server, { messages: 6 })
    const f = h.chat.currentForkId! as ForkId
    const g = (yield* h.writer.CreateFork({
      userId: h.userId,
      chatId: h.chat.id,
      fromForkId: f,
      atSlotId: h.rows.at(-1)!.slotId as SlotId
    })).fork.id as ForkId
    const job = yield* h.enqueue(0, 1)
    assert.strictEqual((yield* h.runNext)?.id, job.id)
    const [rowRows] = yield* fixtureSql(
      h.dataDir,
      [{ sql: "SELECT id, images_json FROM summaries WHERE chat_id = ?", params: [h.chat.id] }],
      { readOnly: true }
    )
    const row = rowRows![0]
    assert.isNull(row!.images_json)
    for (const forkId of [f, g])
      assert.isTrue((yield* h.api.GetSummary({ summaryId: row!.id as typeof SummaryId.Type, forkId })).fresh)
  }).pipe(Effect.scoped)
)

lcmTest("a summary over an image-only message is fresh where it was written", (server) =>
  Effect.gen(function* () {
    const t = yield* setup(server, 4)
    const row = t.h.rows[2]!
    yield* t.h.api.EditVersion({
      slotId: row.slotId,
      sourceVersionId: row.version.id,
      expectedRowVersion: 1,
      content: "",
      images: [t.first]
    })
    const path = yield* t.h.reader.GetPath({
      userId: t.h.userId,
      chatId: t.h.chat.id,
      forkId: t.f,
      leafSlotId: null,
      limit: 10
    })
    const [job] = yield* t.h.writer.EnqueueSummaries({
      userId: t.h.userId,
      chatId: t.h.chat.id,
      forkId: t.f,
      leafSlotId: t.h.rows.at(-1)!.slotId,
      requestClass: "interactive",
      chunks: [
        {
          target: 100,
          inputs: path.entries
            .slice(2, 4)
            .map((e) => ({ slotId: e.slotId, versionId: e.version.id, amendCount: e.version.rowVersion - 1 }))
        }
      ]
    })
    assert.strictEqual((yield* t.h.runNext)?.id, job!.id)
    const [summaryRows] = yield* fixtureSql(
      t.h.dataDir,
      [{ sql: "SELECT id FROM summaries WHERE first_slot_id = ?", params: [row.slotId] }],
      { readOnly: true }
    )
    const summary = summaryRows![0]
    assert.isTrue(yield* t.fresh(summary!.id as typeof SummaryId.Type, t.f))
    assert.lengthOf(yield* t.plan(t.f), 0)
  }).pipe(Effect.scoped)
)

// Summaries across splits and joins (spec/THREADS.md §8.4, §9, TH7) through the real planner,
// worker and reader: in a chat with one shared context, threads started at S share the summaries
// before S; after a separate join each character that missed something in the join's parallel
// stretch keeps its own summaries from there (a stretch view), written from what it knew: Wren's
// never hold the Lantern, Mira's never the docks, and their replies read their own. A together
// join keeps one shared chain. Synthetic data only.
import { assert, describe } from "@effect/vitest"
import { type EntityId, type ForkId, NewVersion, type SlotId } from "@rp/shared/chat.ts"
import type { MergeTimelines } from "@rp/shared/mergeApi.ts"
import { STRETCH_VIEW } from "@rp/shared/knowledge.ts"
import { Effect } from "effect"
import type { ContextSnapshot } from "../src/assembler/types.ts"
import { cardDoc } from "./support/docs.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { lcmHarness, lcmTest } from "./support/lcmHarness.ts"
import type { Recorded } from "./support/mockProvider.ts"
import { sentText } from "./support/threadStory.ts"

const filler = "The night ran on. ".repeat(20)

/** A summary says which lines its request carried. */
const summarize = (request: Recorded) => {
  const body = JSON.stringify(request.body)
  return { text: `Seen:${body.includes("LANTERN") ? " lantern" : ""}${body.includes("DOCKS") ? " docks" : ""}.` }
}

const story = (
  server: Parameters<typeof lcmHarness>[0],
  timelines: MergeTimelines,
  inserted: false | "span" | "join" = false,
  intermittent = false
) =>
  Effect.gen(function* () {
    const h = yield* lcmHarness(server, {
      messages: 30,
      message: (n) => `Shared ${n}. ${filler}`,
      summarizer: summarize
    })
    const { api, reader, writer, userId } = h
    const chatId = h.chat.id
    const card = (name: string) =>
      Effect.map(
        writer.CreateEntity({
          userId,
          kind: "card",
          label: name,
          subtitle: "",
          doc: cardDoc(name),
          schemaVersion: 1,
          origin: "user",
          sourcePath: null
        }),
        (c) => c.entityId as EntityId
      )
    const mira = yield* card("Mira")
    const wren = yield* card("Wren")
    for (const entity of [mira, wren])
      yield* writer.AddStateEvent({
        userId,
        chatId,
        slotId: null,
        versionId: null,
        scope: null,
        data: { key: "participant.join", value: { entity } }
      })
    const F = (yield* api.GetChat({ chatId })).currentForkId! as ForkId
    const S = h.rows.at(-1)!.slotId as SlotId
    const started = yield* api.StartThreads({
      chatId,
      forkId: F,
      slotId: S,
      expectedRowVersion: (yield* reader.GetSlot({ userId, slotId: S, forkId: F })).entry.rowVersion,
      threads: [
        { name: "At the Lantern", cast: [mira], writesAs: null },
        { name: "At the docks", cast: [wren], writesAs: null }
      ]
    })
    const D = started.forkIds[1]! as ForkId
    const tipOf = (fork: ForkId) =>
      Effect.map(
        reader.ReadPath({ userId, chatId, forkId: fork, leafSlotId: null, range: { _tag: "Bottom" }, limit: 1 }),
        (path) => path.entries.at(-1)!.slotId as SlotId
      )
    const say = (fork: ForkId, speaker: EntityId, content: string) =>
      Effect.gen(function* () {
        const row = yield* writer.AppendMessage({
          userId,
          chatId,
          forkId: fork,
          parentSlotId: yield* tipOf(fork),
          branch: false,
          commitDraft: null,
          version: new NewVersion({
            speakerEntityId: speaker,
            writer: "model",
            content,
            status: "complete",
            macroMode: "verbatim",
            origin: "generated"
          })
        })
        if (fork === F) h.rows.push(row)
        return row
      })
    const lantern: Array<SlotId> = []
    for (let n = 0; n < 24; n++)
      lantern.push(
        (yield* say(
          F,
          intermittent && n % 2 ? wren : mira,
          `${intermittent && n % 2 ? "OWN-LINE" : "LANTERN"} ${n}. ${filler}`
        )).slotId as SlotId
      )
    for (let n = 0; n < 24; n++) yield* say(D, wren, `DOCKS ${n}. ${filler}`)
    if (inserted)
      yield* writer.InsertMessage({
        userId,
        chatId,
        forkId: F,
        anchorSlotId: lantern[1]!,
        expectedRowVersion: (yield* reader.GetSlot({ userId, slotId: lantern[1]!, forkId: F })).entry.rowVersion,
        body: { _tag: "Write", speaker: mira, content: `INSERT-SECRET. ${filler}` }
      })
    const at = inserted === "join" ? lantern[20]! : null
    const preview = yield* api.PreviewChatMerge({
      chatId,
      forkId: F,
      at,
      source: { chatId, forkId: D },
      includeLeftOut: false,
      timelines
    })
    yield* api.JoinThreads({
      chatId,
      forkId: F,
      at,
      includeLeftOut: false,
      timelines,
      joins: [{ forkId: D, title: preview.sourceTitle, framing: null, digest: preview.digest }]
    })
    const J = yield* tipOf(F)
    for (let n = 0; n < 70; n++) yield* say(F, n % 2 ? wren : mira, `After ${n}. ${filler}`)
    yield* h.settle
    const summaryRequests = Effect.map(
      fixtureSql(
        h.dataDir,
        [
          {
            sql: `SELECT p.context_snapshot_json AS snapshot FROM summarization_jobs j
        JOIN rollout_payloads p ON p.rollout_id = j.rollout_id WHERE j.chat_id = ?`,
            params: [chatId]
          }
        ],
        { readOnly: true }
      ),
      ([rows]) => (rows as unknown as Array<{ snapshot: string }>).map((r) => JSON.parse(r.snapshot) as ContextSnapshot)
    )
    const summaries = Effect.map(
      fixtureSql(
        h.dataDir,
        [
          {
            sql: `SELECT s.audience_json AS audience, a.depth AS first, b.depth AS last, r.content
              FROM summaries s JOIN slots a ON a.id = s.first_slot_id JOIN slots b ON b.id = s.last_slot_id
              JOIN summary_revisions r ON r.id = s.selected_revision_id
              WHERE s.chat_id = ? AND s.status IN ('complete', 'truncated') ORDER BY a.depth, s.level`,
            params: [chatId]
          }
        ],
        { readOnly: true }
      ),
      ([rows]) => rows as unknown as Array<{ audience: string | null; first: number; last: number; content: string }>
    )
    /** The context of a reply by `speaker` at F's tip. */
    const replyBy = (speaker: EntityId) =>
      Effect.gen(function* () {
        const placeholder = yield* writer.AppendMessage({
          userId,
          chatId,
          forkId: F,
          parentSlotId: yield* tipOf(F),
          branch: true,
          commitDraft: null,
          version: new NewVersion({
            speakerEntityId: speaker,
            writer: "model",
            content: "",
            status: "generating",
            macroMode: "verbatim",
            origin: "generated"
          })
        })
        const built = yield* reader.AssembleContext({
          userId,
          chatId,
          slotId: placeholder.slotId,
          versionId: placeholder.version.id,
          now: 1,
          timeZone: "UTC",
          frozen: null,
          forkId: placeholder.forkId
        })
        return JSON.parse(built.snapshot) as ContextSnapshot
      })
    const depthOf = (slotId: SlotId) =>
      Effect.map(
        fixtureSql(h.dataDir, [{ sql: "SELECT depth FROM slots WHERE id = ?", params: [slotId] }], { readOnly: true }),
        ([rows]) => (rows as unknown as Array<{ depth: number }>)[0]!.depth
      )
    return {
      h,
      mira,
      wren,
      F,
      D,
      S,
      J,
      sDepth: yield* depthOf(S),
      jDepth: yield* depthOf(J),
      lantern,
      summaries,
      summaryRequests,
      replyBy
    }
  })

/** A stretch view's audience key for `entity`. */
const stretchAudience = (entity: string) => JSON.stringify([entity, STRETCH_VIEW].sort())

describe("summaries across splits and joins (TH7)", () => {
  lcmTest(
    "private summary continuity before the join excludes the missed parts of a partially known destination",
    (server) =>
      Effect.gen(function* () {
        const t = yield* story(server, "separate", false, true)
        const requests = (yield* t.summaryRequests).filter((s) => s.summaryJob?.audience?.includes(t.wren))
        assert.isNotEmpty(requests)
        assert.isTrue(requests.some((s) => sentText(s).includes("OWN-LINE")))
        for (const s of requests)
          assert.notMatch(sentText(s), /LANTERN|Seen: lantern/, "continuity must belong to the private view too")
        assert.notMatch(sentText(yield* t.replyBy(t.wren)), /LANTERN|Seen: lantern/)
      }),
    { timeout: 240_000 }
  )

  for (const placement of ["span", "join"] as const)
    lcmTest(
      `summary requests exclude an inserted missed message (${placement})`,
      (server) =>
        Effect.gen(function* () {
          const t = yield* story(server, "separate", placement)
          const requests = yield* t.summaryRequests
          const wren = requests.filter((s) => s.summaryJob?.audience?.includes(t.wren))
          assert.isNotEmpty(wren, "the inserted join creates Wren's own summary pass")
          assert.isTrue(
            requests.some((s) => !s.summaryJob?.audience && sentText(s).includes("INSERT-SECRET")),
            "shared inputs contain the synthetic secret"
          )
          for (const request of wren)
            assert.notInclude(sentText(request), "INSERT-SECRET", "the actual summary input is private")
          assert.notInclude(sentText(yield* t.replyBy(t.wren)), "INSERT-SECRET")
        }),
      { timeout: 240_000 }
    )

  lcmTest(
    "a separate join in one shared context: one shared chain before S, then each character's own, free of the line it missed",
    (server) =>
      Effect.gen(function* () {
        const t = yield* story(server, "separate")
        const requests = yield* t.summaryRequests
        assert.isTrue(requests.some((s) => s.summaryJob?.audience?.includes(t.wren)))
        for (const s of requests) {
          if (s.summaryJob?.audience?.includes(t.wren)) assert.notMatch(sentText(s), /LANTERN|Seen: lantern/)
          if (s.summaryJob?.audience?.includes(t.mira)) assert.notMatch(sentText(s), /DOCKS|Seen: docks/)
        }
        const all = yield* t.summaries
        const shared = all.filter((s) => s.audience === null)
        const wren = all.filter((s) => s.audience === stretchAudience(t.wren))
        const mira = all.filter((s) => s.audience === stretchAudience(t.mira))
        // The join recorded its stretch: the Lantern from its first message after S, and the join.
        const [[merge]] = (yield* fixtureSql(
          t.h.dataDir,
          [{ sql: "SELECT stretch_json FROM chat_merges WHERE chat_id = ?", params: [t.h.chat.id] }],
          { readOnly: true }
        )) as unknown as [[{ stretch_json: string }]]
        assert.deepStrictEqual(
          (JSON.parse(merge.stretch_json) as Array<{ lo: number; hi: number }>).map((g) => [g.lo, g.hi]),
          [[t.sDepth + 1, t.jDepth]]
        )
        assert.deepStrictEqual(
          [...new Set(all.map((s) => s.audience))].filter((a) => a !== null && !a.includes(STRETCH_VIEW)),
          [],
          "only stretch views keep their own summaries in a shared context"
        )
        // Before S: shared summaries only, one chain both threads read.
        assert.isTrue(shared.some((s) => s.last <= t.sDepth))
        for (const own of [...wren, ...mira])
          assert.isAbove(own.first, t.sDepth, "a view's own summaries begin after S")
        // Each view summarized its stretch from what it knew.
        assert.isNotEmpty(wren, "Wren missed the Lantern: she keeps her own")
        assert.isNotEmpty(mira, "Mira missed the docks: she keeps her own")
        for (const s of wren) assert.notInclude(s.content, "lantern", "Wren's summaries never carry the Lantern")
        for (const s of mira) assert.notInclude(s.content, "docks", "Mira's summaries never carry the docks")
        assert.isTrue(
          wren.some((s) => s.content.includes("docks") && s.first <= t.jDepth),
          "Wren's view holds her docks"
        )
        // The shared chain (a narrator's, a persona's) holds both lines past S.
        assert.isTrue(shared.some((s) => s.content.includes("lantern")))

        // Their replies read their own layers: no line they missed, in summaries or messages.
        const forWren = yield* t.replyBy(t.wren)
        const wrenText = sentText(forWren)
        assert.notInclude(wrenText, "LANTERN")
        assert.notInclude(wrenText, "lantern")
        assert.include(wrenText, "<summary")
        assert.isTrue(
          forWren.pieces.some((p) => p.source.kind === "summary"),
          "Wren's reply uses summaries"
        )
        // The summary UI names the same views: Wren's layer is her own past S, the shared before it.
        const leafSlotId = t.h.rows.at(-1)!.slotId
        const view = yield* t.h.reader.GetLcmState({
          userId: t.h.userId,
          chatId: t.h.chat.id,
          leafSlotId,
          viewer: t.wren
        })
        assert.isTrue(view.layer.some((s) => s.audience?.includes(t.wren)))
        assert.isFalse(view.layer.some((s) => s.audience === undefined && s.to - 1 > t.sDepth))
        assert.isFalse(view.layer.some((s) => s.content?.includes("lantern")))
        const whole = yield* t.h.reader.GetLcmState({ userId: t.h.userId, chatId: t.h.chat.id, leafSlotId })
        assert.isFalse(whole.layer.some((s) => s.audience !== undefined))
        // A branch of the Lantern made before the join never joined: everyone reads it whole there.
        const branch = yield* t.h.writer.CreateFork({
          userId: t.h.userId,
          chatId: t.h.chat.id,
          fromForkId: t.F,
          atSlotId: t.lantern[20]!
        })
        const off = yield* t.h.writer.AppendMessage({
          userId: t.h.userId,
          chatId: t.h.chat.id,
          forkId: branch.fork.id as ForkId,
          parentSlotId: t.lantern[20]!,
          branch: true,
          commitDraft: null,
          version: new NewVersion({
            speakerEntityId: t.mira,
            writer: "model",
            content: `Elsewhere. ${filler}`,
            status: "complete",
            macroMode: "verbatim",
            origin: "generated"
          })
        })
        const offView = yield* t.h.reader.GetLcmState({
          userId: t.h.userId,
          chatId: t.h.chat.id,
          leafSlotId: off.slotId,
          forkId: off.forkId,
          viewer: t.wren
        })
        assert.isFalse(
          offView.layer.some((s) => s.audience !== undefined),
          "no stretch view off the join's path"
        )
        const miraText = sentText(yield* t.replyBy(t.mira))
        assert.notInclude(miraText, "DOCKS")
        assert.notInclude(miraText, "docks")
      }),
    { timeout: 240_000 }
  )

  lcmTest(
    "a together join keeps one shared chain: no views, the join's lines in it for everyone",
    (server) =>
      Effect.gen(function* () {
        const t = yield* story(server, "together")
        const all = yield* t.summaries
        assert.deepStrictEqual(
          all.filter((s) => s.audience !== null),
          []
        )
        assert.isTrue(all.some((s) => s.content.includes("lantern")))
        const wrenText = sentText(yield* t.replyBy(t.wren))
        assert.include(wrenText, "<summary")
      }),
    { timeout: 240_000 }
  )
})

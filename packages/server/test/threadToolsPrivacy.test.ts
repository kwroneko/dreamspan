// Inference attacks on a character's private addresses after a separate join (spec/THREADS.md
// §11.1, review-threads5): every assertion is on the tool result text the model would get.
// Mira at the Lantern, Wren at the docks, Pell under the pier. Synthetic data only.
import { assert, describe, it } from "@effect/vitest"
import { type EntityId, type ForkId, NewVersion, type SlotId } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import { type ContextSnapshot, generationOf } from "../src/assembler/types.ts"
import type { ToolContext } from "../src/agent/tools.ts"
import { historyTools } from "../src/agent/tools/history.ts"
import { completeFixture } from "./support/lcmFixtures.ts"
import { runStory, type ThreadStory } from "./support/threadStory.ts"

/** The history tools as a reply by `speaker` at the tip of `fork` runs them, reading as its view. */
const toolsFor = (t: ThreadStory, fork: ForkId, speaker: EntityId) =>
  Effect.gen(function* () {
    const tip = (yield* t.reader.ReadPath({
      userId: t.userId,
      chatId: t.chatId,
      forkId: fork,
      leafSlotId: null,
      range: { _tag: "Bottom" },
      limit: 1
    })).entries.at(-1)!.slotId
    const placeholder = yield* t.writer.AppendMessage({
      userId: t.userId,
      chatId: t.chatId,
      forkId: fork,
      parentSlotId: tip,
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
    const built = yield* t.reader.AssembleContext({
      userId: t.userId,
      chatId: t.chatId,
      slotId: placeholder.slotId,
      versionId: placeholder.version.id,
      now: 1,
      timeZone: "UTC",
      frozen: null,
      forkId: placeholder.forkId
    })
    const snapshot = JSON.parse(built.snapshot) as ContextSnapshot
    const context: ToolContext = {
      userId: t.userId,
      chatId: t.chatId,
      forkId: placeholder.forkId as ForkId,
      slotId: placeholder.slotId,
      versionId: placeholder.version.id,
      leafSlotId: snapshot.inputs.leafSlotId as SlotId,
      viewers: generationOf(snapshot).viewers,
      rolloutId: "test",
      toolCallId: "test",
      cache: new Map(),
      reader: t.reader,
      writer: t.writer
    }
    const run = (id: string, args: object) =>
      Effect.map(historyTools.find((tool) => tool.id === id)!.execute(context, args as never), (out) => out.text)
    return Object.assign(run, { context, snapshot })
  })

const hook = historyTools.find((tool) => tool.id === "read_messages")!.snapshot!

/** The view as a Resume, step edit or replay reads it again from the snapshot's frozen form. */
const thawed = (context: ToolContext, frozen: unknown) =>
  Effect.gen(function* () {
    const replay = { ...context, cache: new Map<string, unknown>() }
    yield* hook.prepare(replay, JSON.parse(JSON.stringify(frozen)))
    return (id: string, args: object) =>
      Effect.map(historyTools.find((tool) => tool.id === id)!.execute(replay, args as never), (out) => out.text)
  })

const PRIVATE_EMPTY = "No earlier messages match."
const viewNumber = (text: string) => {
  const n = /view #(\d+)\)/.exec(text)?.[1]
  assert.isDefined(n, text)
  return Number(n)
}

describe("private addresses after a join", () => {
  it.live("a later unseen join cannot change an ordinary frozen shared-context search", () =>
    runStory(null, (t) =>
      Effect.gen(function* () {
        yield* t.append(t.F, t.mira, "LANTERNKNOWN")
        const tools = yield* toolsFor(t, t.F, t.wren)
        const original = yield* tools("search_chat", { query: "LANTERNKNOWN" })
        assert.include(original, "LANTERNKNOWN")
        const frozen = hook.freeze!(yield* hook.prepare(tools.context, undefined))
        assert.deepStrictEqual(frozen, { ordinary: true })
        yield* t.append(t.U, t.pell, "UNSEENUPSTAIRS")
        yield* t.join(t.F, [t.U], null, "separate")
        const replay = yield* thawed(tools.context, frozen)
        assert.strictEqual(yield* replay("search_chat", { query: "LANTERNKNOWN" }), original)
      })
    )
  )

  it.live("a later unseen separate join cannot retroactively restrict a frozen shared-context view", () =>
    runStory(null, (t) =>
      Effect.gen(function* () {
        yield* t.append(t.F, t.mira, "LANTERNMISSED")
        yield* t.append(t.D, t.wren, "DOCKSKNOWN")
        const firstJoin = (yield* t.join(t.F, [t.D], null, "separate")).entries[0]!
        yield* t.writer.AddStateEvent({
          userId: t.userId,
          chatId: t.chatId,
          forkId: t.F,
          slotId: firstJoin.slotId,
          versionId: null,
          scope: null,
          data: { key: "away.set", value: { entity: t.wren, away: true } }
        })
        yield* t.append(t.F, t.mira, "SHAREDKNOWN")
        const tools = yield* toolsFor(t, t.F, t.wren)
        const original = yield* tools("search_chat", { query: "SHAREDKNOWN" })
        assert.include(original, "SHAREDKNOWN", "outside the first separate stretch, the context is shared")
        const frozen = hook.freeze!(yield* hook.prepare(tools.context, undefined))
        yield* t.append(t.U, t.pell, "UNSEENUPSTAIRS")
        yield* t.join(t.F, [t.U], null, "separate")
        const replay = yield* thawed(tools.context, frozen)
        assert.strictEqual(yield* replay("search_chat", { query: "SHAREDKNOWN" }), original)
      })
    )
  )

  it.live("whole-path search retains its existing fallback when a join is hidden", () =>
    runStory("separate", (t) =>
      Effect.gen(function* () {
        yield* t.append(t.F, t.mira, "LANTERNOWN")
        yield* t.append(t.D, t.wren, "DOCKSKNOWN")
        const joined = (yield* t.join(t.F, [t.D])).entries[0]!
        yield* t.writer.SetSlotHidden({ userId: t.userId, slotId: joined.slotId, forkId: t.F, hidden: true })
        const tools = yield* toolsFor(t, t.F, t.mira)
        const result = yield* historyTools
          .find((tool) => tool.id === "search_chat")!
          .execute(
            {
              ...tools.context,
              viewers: null,
              cache: new Map()
            },
            { query: "ANTERNOWN" } as never
          )
        assert.strictEqual(result.text, "Message 4, Mira: LANTERNOWN")
      })
    )
  )

  it.live("preflight preserves a regenerated join's speaker exception after an earlier split", () =>
    runStory("separate", (t) =>
      Effect.gen(function* () {
        const anchor = yield* t.append(t.F, t.mira, "LANTERNANCHOR")
        yield* t.append(t.D, t.wren, "DOCKSKNOWN")
        const joined = (yield* t.join(t.F, [t.D])).entries[0]!
        const at = yield* t.reader.GetSlot({ userId: t.userId, slotId: anchor.slotId, forkId: t.F })
        yield* t.api.StartThreads({
          chatId: t.chatId,
          forkId: t.F,
          slotId: anchor.slotId,
          expectedRowVersion: at.entry.rowVersion,
          threads: [
            { name: "The Lantern again", cast: [t.mira], writesAs: null },
            { name: "The yard", cast: [t.wren], writesAs: null }
          ]
        })
        yield* t.writer.AddVersion({
          userId: t.userId,
          slotId: joined.slotId,
          forkId: t.F,
          select: true,
          commitDraft: null,
          version: new NewVersion({
            speakerEntityId: t.wren,
            writer: "model",
            content: joined.version.content,
            status: "complete",
            macroMode: "verbatim",
            origin: "generated"
          })
        })
        const tools = yield* toolsFor(t, t.F, t.wren)
        const expected = yield* tools("search_chat", { query: "DOCKSKNOWN" })
        assert.include(expected, "DOCKSKNOWN")
        const context = { ...tools.context, cache: new Map<string, unknown>() }
        yield* hook.prepare(context, undefined)
        const result = yield* historyTools
          .find((tool) => tool.id === "search_chat")!
          .execute(context, { query: "DOCKSKNOWN" } as never)
        assert.strictEqual(result.text, expected)
      })
    )
  )

  it.live("an unknown join cannot change ordinary indexed search matching", () =>
    runStory("separate", (t) =>
      Effect.gen(function* () {
        yield* t.append(t.F, t.mira, "LANTERNOWN")
        yield* t.append(t.D, t.wren, "DOCKSUNKNOWN")
        const before = yield* toolsFor(t, t.F, t.mira)
        const expected = yield* before("search_chat", { query: "ANTERNOWN" })
        yield* t.join(t.F, [t.D])
        const after = yield* toolsFor(t, t.F, t.mira)
        assert.strictEqual(yield* after("search_chat", { query: "ANTERNOWN" }), expected)
      })
    )
  )

  it.live("an unseen inserted join cannot change a frozen private map or its own-story gap", () =>
    runStory("separate", (t) =>
      Effect.gen(function* () {
        yield* t.append(t.D, t.wren, "DOCKSKNOWN")
        yield* t.join(t.F, [t.D])
        const start = yield* t.append(t.F, t.wren, "KNOWNBEFORE")
        yield* t.writer.AddStateEvent({
          userId: t.userId,
          chatId: t.chatId,
          forkId: t.F,
          slotId: start.slotId,
          versionId: null,
          scope: null,
          data: { key: "away.set", value: { entity: t.wren, away: true } }
        })
        const missed = yield* t.append(t.F, t.mira, "MISSEDMIDDLE")
        const end = yield* t.append(t.F, t.wren, "KNOWNAFTER")
        const tools = yield* toolsFor(t, t.F, t.wren)
        const context = { ...tools.context, forkId: t.F, leafSlotId: end.slotId as SlotId }
        const before = (id: string, args: object) =>
          Effect.map(historyTools.find((tool) => tool.id === id)!.execute(context, args as never), (out) => out.text)
        const original = yield* before("search_chat", { query: "KNOWNAFTER" })
        assert.strictEqual(viewNumber(original) - viewNumber(yield* before("search_chat", { query: "KNOWNBEFORE" })), 2)
        const frozen = hook.freeze!(yield* hook.prepare(context, undefined))
        yield* t.append(t.U, t.pell, "UNSEENUPSTAIRS")
        yield* t.join(t.F, [t.U], missed.slotId, "separate")
        const insertedPath = yield* t.reader.ReadPath({
          userId: t.userId,
          chatId: t.chatId,
          forkId: t.F,
          leafSlotId: null,
          range: { _tag: "Bottom" },
          limit: 30
        })
        assert.isAbove(insertedPath.entries.filter((e) => e.version.origin === "merge").length, 1)
        const replay = yield* thawed(context, frozen)
        assert.strictEqual(yield* replay("search_chat", { query: "KNOWNAFTER" }), original)
        const after = yield* toolsFor(t, t.F, t.wren)
        assert.strictEqual(yield* after("search_chat", { query: "KNOWNAFTER" }), original)
        assert.deepStrictEqual(after.snapshot.request, tools.snapshot.request)
      })
    )
  )

  it.live("a positive preflight racing a hidden join must still freeze ordinary mode", () =>
    runStory("separate", (t) =>
      Effect.gen(function* () {
        yield* t.append(t.D, t.wren, "DOCKSKNOWN")
        const join = (yield* t.join(t.F, [t.D])).entries[0]!
        const tools = yield* toolsFor(t, t.F, t.wren)
        const context = {
          ...tools.context,
          reader: {
            ...t.reader,
            HistoryProjectionNeeded: ((input) =>
              t.reader.HistoryProjectionNeeded(input).pipe(
                Effect.tap(() =>
                  t.writer.SetSlotHidden({
                    userId: t.userId,
                    slotId: join.slotId,
                    forkId: tools.context.forkId!,
                    hidden: true
                  })
                )
              )) as ToolContext["reader"]["HistoryProjectionNeeded"]
          }
        }
        const frozen = hook.freeze!(yield* hook.prepare(context, undefined))
        yield* t.writer.SetSlotHidden({
          userId: t.userId,
          slotId: join.slotId,
          forkId: tools.context.forkId!,
          hidden: false
        })
        const replay = { ...tools.context, cache: new Map<string, unknown>() }
        yield* hook.prepare(replay, frozen)
        const result = yield* historyTools
          .find((tool) => tool.id === "search_chat")!
          .execute(replay, { query: "DOCKSKNOWN" } as never)
        assert.strictEqual(result.text, PRIVATE_EMPTY)
        assert.deepStrictEqual(frozen, { ordinary: true })
      })
    )
  )

  it.live("an unknown join keeps ordinary results, summary tools and request bytes", () =>
    runStory("separate", (t) =>
      Effect.gen(function* () {
        yield* t.append(t.F, t.mira, "LANTERNOWN")
        yield* t.append(t.D, t.wren, "DOCKSUNKNOWN")
        const before = yield* toolsFor(t, t.F, t.mira)
        yield* t.join(t.F, [t.D])
        const after = yield* toolsFor(t, t.F, t.mira)
        for (const [id, args] of [
          ["read_messages", { from: 1, count: 20 }],
          ["search_chat", { query: "LANTERNOWN" }],
          ["search_chat", { query: "DOCKSUNKNOWN" }],
          ["search_summaries", { query: "DOCKSUNKNOWN" }],
          ["expand_summary", { messages: "1–3" }]
        ] as const)
          assert.strictEqual(yield* after(id, args), yield* before(id, args), id)
        assert.deepStrictEqual(after.snapshot.request, before.snapshot.request)
      })
    )
  )

  it.live("the only ordinary numbering gap is identical to an ordinary hidden message", () =>
    runStory("separate", (t) =>
      Effect.gen(function* () {
        const own = yield* t.append(t.F, t.mira, "LANTERNOWN")
        yield* t.append(t.D, t.wren, "DOCKSUNKNOWN")
        const ordinary = (yield* t.writer.CreateFork({
          userId: t.userId,
          chatId: t.chatId,
          fromForkId: t.F,
          atSlotId: own.slotId
        })).fork.id as ForkId
        const hidden = yield* t.append(ordinary, t.mira, "DOCKSUNKNOWN")
        yield* t.writer.SetSlotHidden({ userId: t.userId, slotId: hidden.slotId, forkId: ordinary, hidden: true })
        yield* t.join(t.F, [t.D])
        yield* t.append(ordinary, t.mira, "MORNINGKNOWN")
        yield* t.append(t.F, t.mira, "MORNINGKNOWN")
        const joined = yield* toolsFor(t, t.F, t.mira)
        const control = yield* toolsFor(t, ordinary, t.mira)
        for (const [id, args] of [
          ["read_messages", { from: 1, count: 20 }],
          ["search_chat", { query: "MORNINGKNOWN" }],
          ["read_messages", { from: 999999 }],
          ["read_messages", { from: 5, count: 1 }],
          ["search_chat", { query: "DOCKSUNKNOWN" }],
          ["search_chat", { query: "ANTERNOWN" }],
          ["search_chat", { query: "" }],
          ["search_summaries", { query: "DOCKSUNKNOWN" }],
          ["expand_summary", { messages: "1–3" }],
          ["expand_summary", { messages: "invalid", joined: "At the docks" }]
        ] as const) {
          const tool = historyTools.find((tool) => tool.id === id)!
          assert.strictEqual(
            JSON.stringify(yield* tool.execute(joined.context, args as never)),
            JSON.stringify(yield* tool.execute(control.context, args as never)),
            id
          )
        }
        assert.deepStrictEqual(joined.snapshot.request, control.snapshot.request)
      })
    )
  )

  it.live("an unknown join leaves usable summaries of the character's own chain", () =>
    runStory("separate", (t) =>
      Effect.gen(function* () {
        const own = yield* t.append(t.F, t.mira, "LANTERNOWN")
        const path = yield* t.reader.ReadPath({
          userId: t.userId,
          chatId: t.chatId,
          forkId: t.F,
          leafSlotId: own.slotId,
          range: { _tag: "Bottom" },
          limit: 20
        })
        yield* completeFixture(
          t.dataDir,
          t.writer,
          t.userId,
          t.chatId,
          path.entries.map((e) => ({
            slotId: e.slotId,
            versionId: e.version.id,
            amendCount: 0
          })),
          [],
          " LANTERN-SUMMARY"
        )
        const before = yield* toolsFor(t, t.F, t.mira)
        const listed = yield* before("search_summaries", { query: "LANTERN-SUMMARY" })
        assert.include(listed, "LANTERN-SUMMARY")
        assert.match(listed, /^Messages/)
        const expanded = yield* before("expand_summary", { messages: `1–${path.entries.length}`, max_tokens: 8000 })
        assert.include(expanded, "LANTERNOWN")
        yield* t.append(t.D, t.wren, "DOCKSUNKNOWN")
        yield* t.join(t.F, [t.D])
        const after = yield* toolsFor(t, t.F, t.mira)
        assert.strictEqual(yield* after("search_summaries", { query: "LANTERN-SUMMARY" }), listed)
        assert.strictEqual(
          yield* after("expand_summary", { messages: `1–${path.entries.length}`, max_tokens: 8000 }),
          expanded
        )
      })
    )
  )

  it.live("preparing an unaffected path or viewer never reads the path", () =>
    runStory("separate", (t) =>
      Effect.gen(function* () {
        yield* t.append(t.F, t.mira, "LANTERNOWN")
        yield* t.append(t.D, t.wren, "DOCKSOWN")
        yield* t.join(t.F, [t.D])
        for (const [fork, speaker] of [
          [t.D, t.wren],
          [t.F, t.mira]
        ] as const) {
          const tools = yield* toolsFor(t, fork, speaker)
          let paths = 0
          const context = {
            ...tools.context,
            reader: {
              ...t.reader,
              ReadPath: ((input) => {
                paths++
                return t.reader.ReadPath(input)
              }) as ToolContext["reader"]["ReadPath"]
            }
          }
          const state = yield* hook.prepare(context, undefined)
          assert.deepStrictEqual(hook.freeze!(state), { ordinary: true })
          yield* hook.prepare({ ...context, cache: new Map() }, hook.freeze!(state))
          assert.strictEqual(paths, 0, "ordinary Resume also needs no preflight path read")
        }
      })
    )
  )

  it.live("a negative preflight cannot bypass privacy when a known join is inserted before the first tool call", () =>
    runStory("separate", (t) =>
      Effect.gen(function* () {
        const own = yield* t.append(t.F, t.mira, "LANTERNOWN")
        yield* t.append(t.D, t.wren, "DOCKSUNKNOWN")
        yield* t.join(t.F, [t.D])
        const mira = yield* toolsFor(t, t.F, t.mira)
        const state = yield* hook.prepare(mira.context, undefined)
        assert.deepStrictEqual(hook.freeze!(state), { ordinary: true })
        yield* t.append(t.U, t.mira, "UPSTAIRSKNOWN")
        yield* t.join(t.F, [t.U], own.slotId, "separate")
        const run = { ...mira.context, cache: new Map<string, unknown>() }
        yield* hook.prepare(run, state)
        const found = yield* historyTools
          .find((tool) => tool.id === "search_chat")!
          .execute(run, { query: "UPSTAIRSKNOWN" } as never)
        assert.strictEqual(found.text, PRIVATE_EMPTY)
        const replay = yield* thawed(mira.context, hook.freeze!(state))
        assert.strictEqual(yield* replay("search_chat", { query: "UPSTAIRSKNOWN" }), PRIVATE_EMPTY)
      })
    )
  )

  it.live("a hidden separate join still defines the private stretch of a known together join", () =>
    runStory(null, (t) =>
      Effect.gen(function* () {
        yield* t.append(t.F, t.mira, "LANTERNOWN")
        yield* t.append(t.U, t.wren, "KNOWNTOGETHER")
        yield* t.join(t.F, [t.U], null, "together")
        yield* t.append(t.D, t.wren, "DOCKSKNOWN")
        const separate = (yield* t.join(t.F, [t.D], null, "separate")).entries[0]!
        yield* t.writer.SetSlotHidden({ userId: t.userId, slotId: separate.slotId, forkId: t.F, hidden: true })
        const wren = yield* toolsFor(t, t.F, t.wren)
        assert.match(yield* wren("search_chat", { query: "KNOWNTOGETHER" }), /^Message v[a-f0-9]{24} \(view #/)
        const state = yield* hook.prepare({ ...wren.context, cache: new Map() }, undefined)
        assert.isDefined(hook.freeze!(state), "the prepared view must freeze every private result it can issue")
      })
    )
  )

  it.live("a private reply freezes constant bytes rather than a list of known rows", () =>
    runStory("separate", (t) =>
      Effect.gen(function* () {
        yield* t.append(t.F, t.mira, "LANTERNOWN")
        yield* t.append(t.D, t.wren, "DOCKSOWN")
        yield* t.join(t.F, [t.D])
        const wren = yield* toolsFor(t, t.F, t.wren)
        const state = yield* hook.prepare(wren.context, undefined)
        const frozen = JSON.stringify(hook.freeze!(state))
        assert.strictEqual(Buffer.byteLength(frozen), 77)
        assert.notInclude(frozen, '"keys"')
        assert.strictEqual(
          yield* (yield* thawed(wren.context, hook.freeze!(state)))("read_messages", { from: 1, count: 20 }),
          yield* wren("read_messages", { from: 1, count: 20 })
        )
      })
    )
  )

  it.live("the spec's example: what Wren's tools return after the docks join the Lantern", () =>
    runStory(null, (t) =>
      Effect.gen(function* () {
        yield* t.append(t.F, t.mira, "Mira stokes the fire at the Lantern.")
        yield* t.append(t.D, t.wren, "Wren counts the crates on the pier.")
        yield* t.append(t.D, t.wren, "Wren lights the lamp on the last crate.")
        yield* t.join(t.F, [t.D], null, "separate")
        const wren = yield* toolsFor(t, t.F, t.wren)
        const found = yield* wren("search_chat", { query: "lamp" })
        const address = /Message (v[a-f0-9]{24})/.exec(found)![1]!
        const read = yield* wren("read_messages", { from: 1, count: 20 })
        // The shared beginning, then her own docks lines: nothing of the Lantern since the threads parted.
        assert.match(found, /^Message v[a-f0-9]{24} \(view #5\), Wren: Wren lights the lamp on the last crate\.$/)
        assert.match(read, /^Message v[a-f0-9]{24} \(view #1\), Mira: \*Mira looks up\.\* Late again, Tobin\.\n\n/)
        assert.match(
          read,
          /\(view #3\), Narrator: The night goes on\.\n\nMessage v[a-f0-9]{24} \(view #4\), Wren: Wren counts/
        )
        assert.isTrue(read.endsWith(`Message ${address} (view #5), Wren: Wren lights the lamp on the last crate.`))
        assert.notInclude(read, "stokes the fire")
      })
    )
  )

  it.live("a nested join of a storyline the character was never in costs no view number", () =>
    runStory(null, (t) =>
      Effect.gen(function* () {
        yield* t.append(t.F, t.mira, "DESTKNOWN")
        const head = yield* t.append(t.D, t.wren, "DOCKSOWN")
        const row = yield* t.reader.GetSlot({ userId: t.userId, slotId: head.slotId, forkId: t.D })
        const nested = yield* t.api.StartThreads({
          chatId: t.chatId,
          forkId: t.D,
          slotId: head.slotId,
          expectedRowVersion: row.entry.rowVersion,
          threads: [
            { name: "On the pier", cast: [t.wren], writesAs: null },
            { name: "Under the pier", cast: [t.pell], writesAs: null }
          ]
        })
        const under = nested.forkIds[1]!
        yield* t.append(t.D, t.wren, "PIERKNOWN")
        yield* t.append(under, t.pell, "NESTEDSECRET")
        // Pell's storyline comes into the docks; Wren was never part of it.
        yield* t.join(t.D, [under], null, "separate")
        yield* t.append(t.D, t.wren, "AFTERNESTED")
        const inDocks = yield* toolsFor(t, t.D, t.wren)
        const docksGap =
          Number(/^Message (\d+)/.exec(yield* inDocks("search_chat", { query: "AFTERNESTED" }))![1]) -
          Number(/^Message (\d+)/.exec(yield* inDocks("search_chat", { query: "PIERKNOWN" }))![1])
        assert.strictEqual(docksGap, 2, "ordinary numbering charges only the hidden join slot")
        yield* t.join(t.F, [t.D], null, "separate")
        const wren = yield* toolsFor(t, t.F, t.wren)
        const pier = yield* wren("search_chat", { query: "PIERKNOWN" })
        const after = yield* wren("search_chat", { query: "AFTERNESTED" })
        assert.strictEqual(
          viewNumber(after) - viewNumber(pier),
          1,
          "a numbering gap here discloses that someone else's storyline was joined between them"
        )
        // Nothing reads in the number between them.
        assert.strictEqual(yield* wren("read_messages", { from: viewNumber(pier) + 2, count: 1 }), PRIVATE_EMPTY)
        assert.include(yield* wren("read_messages", { from: viewNumber(pier) + 1, count: 1 }), "AFTERNESTED")
        assert.strictEqual(yield* wren("search_chat", { query: "NESTEDSECRET" }), PRIVATE_EMPTY)
      })
    )
  )

  it.live("a frozen view keeps constant bytes and fails closed after its address map changes", () =>
    runStory(null, (t) =>
      Effect.gen(function* () {
        const first = yield* t.append(t.F, t.wren, "LANTERNFIRST")
        const second = yield* t.append(t.F, t.wren, "LANTERNSECOND")
        yield* t.append(t.F, t.wren, "LANTERNTHIRD")
        yield* t.append(t.D, t.wren, "DOCKSMISSED")
        yield* t.join(t.F, [t.D], null, "separate")
        const mira = yield* toolsFor(t, t.F, t.wren)
        const state = yield* hook.prepare({ ...mira.context, cache: new Map() }, undefined)
        const frozen = hook.freeze!(state)
        const stored = JSON.stringify(frozen)
        for (const text of ["LANTERN", "DOCKS", "Mira", "Wren"]) assert.notInclude(stored, text)
        const address = (text: string) =>
          Effect.map(mira("search_chat", { query: text }), (r) => /Message (v[a-f0-9]{24})/.exec(r)![1]!)
        const [a2, a3] = [yield* address("LANTERNSECOND"), yield* address("LANTERNTHIRD")]
        const before = yield* mira("read_messages", { from: 1, count: 20 })
        // Unchanged, the thawed view reads exactly as the run did.
        assert.strictEqual(
          yield* (yield* thawed(mira.context, frozen))("read_messages", { from: 1, count: 20 }),
          before
        )
        // A known insertion changes the map: all old reads fail closed, including numeric ones.
        const slot = yield* t.reader.GetSlot({ userId: t.userId, slotId: first.slotId, forkId: t.F })
        yield* t.writer.InsertMessage({
          userId: t.userId,
          chatId: t.chatId,
          forkId: t.F,
          anchorSlotId: first.slotId,
          expectedRowVersion: slot.entry.rowVersion,
          body: { _tag: "Write", speaker: t.wren, content: "LANTERNINSERTED" }
        })
        const afterInsert = yield* thawed(mira.context, frozen)
        assert.strictEqual(yield* afterInsert("read_messages", { from: a3, count: 1 }), PRIVATE_EMPTY)
        assert.strictEqual(yield* afterInsert("search_chat", { query: "LANTERNINSERTED" }), PRIVATE_EMPTY)
        assert.strictEqual(yield* afterInsert("read_messages", { from: 1, count: 20 }), PRIVATE_EMPTY)
        // A deletion cannot let a stale address or number reach another row.
        yield* t.api.DeleteMessage({ slotId: second.slotId, forkId: t.F })
        const afterDelete = yield* thawed(mira.context, frozen)
        assert.strictEqual(yield* afterDelete("read_messages", { from: a2, count: 1 }), PRIVATE_EMPTY)
        assert.strictEqual(yield* afterDelete("read_messages", { from: a3, count: 1 }), PRIVATE_EMPTY)
        assert.notInclude(yield* afterDelete("read_messages", { from: 1, count: 20 }), "DOCKSMISSED")
      })
    )
  )

  it.live("a frozen private map stays causal through later joins, selection, deletion, restore and Undo", () =>
    runStory("separate", (t) =>
      Effect.gen(function* () {
        const own = yield* t.append(t.F, t.wren, "ORIGINALKNOWN")
        yield* t.append(t.D, t.wren, "DOCKSKNOWN")
        yield* t.join(t.F, [t.D])
        const tools = yield* toolsFor(t, t.F, t.wren)
        const frozen = hook.freeze!(yield* hook.prepare({ ...tools.context, cache: new Map() }, undefined))
        const original = yield* tools("search_chat", { query: "ORIGINALKNOWN" })
        const address = /Message (v[a-f0-9]{24})/.exec(original)![1]!
        const check = (expected: string) =>
          Effect.gen(function* () {
            const replay = yield* thawed(tools.context, frozen)
            assert.strictEqual(yield* replay("search_chat", { query: "ORIGINALKNOWN" }), expected)
            const result = yield* replay("read_messages", { from: address, count: 1 })
            if (expected === PRIVATE_EMPTY) assert.strictEqual(result, PRIVATE_EMPTY)
            else assert.include(result, "ORIGINALKNOWN")
            assert.strictEqual(yield* replay("search_chat", { query: "LATERKNOWN" }), PRIVATE_EMPTY)
          })
        yield* t.append(t.D, t.wren, "LATERKNOWN")
        yield* t.join(t.F, [t.D])
        yield* check(original) // Later joins are beyond the frozen leaf.
        const deleted = yield* t.api.DeleteMessage({ slotId: own.slotId, forkId: t.F })
        yield* check(PRIVATE_EMPTY)
        yield* t.api.RestoreBinItem({ itemId: deleted.id })
        yield* check(original)
        yield* t.writer.AddVersion({
          userId: t.userId,
          slotId: own.slotId,
          forkId: t.F,
          select: true,
          commitDraft: null,
          version: new NewVersion({
            speakerEntityId: t.mira,
            writer: "model",
            content: "MISSEDREPLACEMENT",
            status: "complete",
            macroMode: "verbatim",
            origin: "generated"
          })
        })
        yield* check(PRIVATE_EMPTY)
        yield* t.api.UndoThreads({ chatId: t.chatId, splitId: t.splitId })
        yield* check(PRIVATE_EMPTY)
      })
    )
  )

  it.live("the run reads what its generation prepared without reading the path again", () =>
    runStory("separate", (t) =>
      Effect.gen(function* () {
        yield* t.append(t.F, t.mira, "LANTERNOWN")
        yield* t.append(t.D, t.wren, "DOCKSOWN")
        yield* t.join(t.F, [t.D])
        // Wren at the docks: the chat has a merge, her path none, so her view isn't private;
        // Wren at the Lantern: private.
        for (const [fork, speaker, isPrivate] of [
          [t.D, t.wren, false],
          [t.F, t.wren, true]
        ] as const) {
          const tools = yield* toolsFor(t, fork, speaker)
          const state = yield* hook.prepare({ ...tools.context, cache: new Map() }, undefined)
          assert.strictEqual("digest" in (hook.freeze!(state) as object), isPrivate)
          let paths = 0
          const counted = {
            ...tools.context,
            cache: new Map<string, unknown>(),
            reader: {
              ...t.reader,
              ReadPath: ((input) =>
                Effect.suspend(() => {
                  paths++
                  return t.reader.ReadPath(input)
                })) as ToolContext["reader"]["ReadPath"]
            }
          }
          yield* hook.prepare(counted, state)
          const text = (yield* historyTools
            .find((tool) => tool.id === "read_messages")!
            .execute(counted, { from: 1, count: 20 } as never)).text
          assert.include(text, "DOCKSOWN")
          assert.strictEqual(paths, isPrivate ? 0 : 1)
        }
      })
    )
  )
})

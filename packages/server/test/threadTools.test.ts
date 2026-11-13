// The agent's read tools across threads (spec/THREADS.md §11, TH8) through the real server: a
// thread's tools never find another thread before a join; after one, search_chat and
// read_messages read the join's rows as messages ("Message 9 (At the docks #6), Wren: …"), and
// with the join's view only the rows the speaker knew; expand_summary and search_summaries read
// a join's frozen summary rows under the same rule. Mira at the Lantern, Wren at the docks,
// Nara the narrator in both. Synthetic data only.
import { assert, describe, it } from "@effect/vitest"
import { type EntityId, type ForkId, NewVersion, type SlotId } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import { type ContextSnapshot, generationOf } from "../src/assembler/types.ts"
import type { ToolContext } from "../src/agent/tools.ts"
import { historyTools } from "../src/agent/tools/history.ts"
import { eventually, finished } from "./support/generation.ts"
import { completionChunks, sse } from "./support/mockProvider.ts"
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
    return { viewers: context.viewers, run }
  })

/** A message's number (from 1) on `fork`'s display path, found by its text. */
const numberIn = (t: ThreadStory, fork: ForkId, text: string) =>
  Effect.gen(function* () {
    const path = yield* t.reader.ReadPath({
      userId: t.userId,
      chatId: t.chatId,
      forkId: fork,
      leafSlotId: null,
      range: { _tag: "Bottom" },
      limit: 200
    })
    const entry = path.entries.find((e) => e.version.content.startsWith(text))!
    return (entry.position ?? entry.depth) + 1
  })

/** The docks and the Lantern each go on after the threads part. */
const play = (t: ThreadStory) =>
  Effect.gen(function* () {
    const lantern = yield* t.append(t.F, t.mira, "Mira stokes the fire at the Lantern.")
    yield* t.append(t.F, t.mira, "Mira asks the keeper for two rooms.")
    yield* t.append(t.D, t.wren, "Wren counts the crates on the pier.")
    yield* t.append(t.D, t.nara!, "The tide turns under a thin moon.")
    return { lanternSlot: lantern.slotId as SlotId }
  })

const NONE = "No earlier messages match"
const REFUSAL = "History tools are unavailable for this separate thread view."
const expectRefused = (tools: Effect.Success<ReturnType<typeof toolsFor>>) =>
  Effect.gen(function* () {
    for (const [id, args] of [
      ["read_messages", { from: 1, count: 20 }],
      ["read_messages", { from: 999999, joined_from: 999999 }],
      ["search_chat", { query: "MISSEDSOURCE" }],
      ["search_summaries", { query: "MISSEDSOURCE" }],
      ["expand_summary", { messages: "1–999999", joined: "At the docks" }]
    ] as const)
      assert.strictEqual(yield* tools.run(id, args), REFUSAL)
  })

describe("the agent's read tools across threads", () => {
  it.live("separate joins refuse character reads while whole-path personas and narrators read the rows", () =>
    runStory(
      null,
      (t) =>
        Effect.gen(function* () {
          const { lanternSlot } = yield* play(t)
          const crates = yield* numberIn(t, t.D, "Wren counts the crates")
          const before = yield* toolsFor(t, t.F, t.mira)
          assert.include(yield* before.run("search_chat", { query: "crates" }), NONE)
          assert.include(yield* before.run("search_chat", { query: "stokes" }), "stokes the fire")
          const docks = yield* toolsFor(t, t.D, t.wren)
          assert.include(yield* docks.run("search_chat", { query: "stokes" }), NONE)
          const J = (yield* t.join(t.F, [t.D], null, "separate")).entries[0]!.slotId
          const slot = yield* t.reader.GetSlot({ userId: t.userId, slotId: lanternSlot, forkId: t.F })
          yield* t.writer.InsertMessage({
            userId: t.userId,
            chatId: t.chatId,
            forkId: t.F,
            anchorSlotId: lanternSlot,
            expectedRowVersion: slot.entry.rowVersion,
            body: { _tag: "Write", speaker: t.mira, content: "Mira mends a torn sail." }
          })
          for (const speaker of [t.mira, t.wren, t.quill]) yield* expectRefused(yield* toolsFor(t, t.F, speaker))
          for (const speaker of [t.nara!, t.tobin]) {
            const whole = yield* toolsFor(t, t.F, speaker)
            assert.isNull(whole.viewers)
            assert.include(yield* whole.run("search_chat", { query: "crates" }), `(At the docks #${crates}), Wren:`)
            assert.include(yield* whole.run("read_messages", { from: 1, count: 20 }), "torn sail")
            const path = yield* t.reader.ReadPath({
              userId: t.userId,
              chatId: t.chatId,
              forkId: t.F,
              leafSlotId: null,
              range: { _tag: "Bottom" },
              limit: 200
            })
            const entry = path.entries.find((e) => e.slotId === J)!
            const n = (entry.position ?? entry.depth) + 1
            const inside = yield* whole.run("read_messages", { from: n, joined_from: crates + 1, count: 5 })
            assert.notInclude(inside, "crates")
            assert.include(inside, "thin moon")
          }
        }),
      { narrator: true }
    )
  )

  it.live("actual agent request tool results keep the separate join private and refuse workshop reads", () =>
    runStory(
      null,
      (t) =>
        Effect.gen(function* () {
          yield* t.append(t.F, t.mira, "MISSEDTHREADSECRET")
          yield* t.append(t.D, t.wren, "KNOWNDOCKS")
          const J = (yield* t.join(t.F, [t.D], null, "separate")).entries[0]!
          yield* t.writer.AddStateEvent({
            userId: t.userId,
            chatId: t.chatId,
            forkId: t.F,
            slotId: null,
            versionId: null,
            scope: null,
            data: { key: "agent.enabled", value: { on: true } }
          })
          const started = yield* t.api.Generate({
            chatId: t.chatId,
            forkId: t.F,
            parentSlotId: J.slotId,
            branch: false,
            speakerEntityId: t.wren
          })
          if (started._tag !== "Posted") throw new Error("Expected a posted reply")
          yield* eventually(() => finished(t.events, started.entry.version.id) !== undefined)
          const bodies = t.mock.requests().flatMap((r) => (r.body?.tools ? [r.body] : []))
          assert.isAbove(bodies.length, 5)
          const results = bodies.flatMap((body) =>
            (body.messages as Array<{ role: string; content: string }>).filter((m) => m.role === "tool")
          )
          assert.isAbove(results.length, 5)
          for (const result of results)
            assert.notInclude(result.content.replaceAll("“MISSEDTHREADSECRET”", "“query”"), "MISSEDTHREADSECRET")
          assert.isTrue(results.some((r) => r.content === REFUSAL))
          assert.isFalse(results.some((r) => r.content.includes("KNOWNDOCKS")))
          for (const body of bodies) assert.deepStrictEqual(body.tools, bodies[0]!.tools)
          for (const name of ["read_run", "list_threads", "history_search"]) {
            assert.isTrue(
              results.some(
                (r) =>
                  r.content.includes(name) &&
                  /not offered|not available|not found|Unknown tool|unavailable/i.test(r.content)
              ),
              name
            )
          }
        }),
      {
        respond: (request, res) => {
          if (!request.body?.tools) {
            sse(res, completionChunks(["The night goes on."], {}))
            return
          }
          const done = (request.body.messages as Array<{ role: string }>).filter((m) => m.role === "tool").length
          const calls = [
            ["read_messages", { from: 1, count: 20 }],
            ["search_chat", { query: "MISSEDTHREADSECRET" }],
            ["search_summaries", { query: "MISSEDTHREADSECRET" }],
            ["expand_summary", { messages: "1–20" }],
            ["lookup_lore", { query: "MISSEDTHREADSECRET" }],
            ["list_notes", {}],
            ["read_run", { version: "workshop-secret-version" }],
            ["list_threads", {}],
            ["history_search", { chatId: "workshop-secret-chat" }]
          ] as const
          const call = calls[done]
          if (!call) {
            sse(res, completionChunks(["Wren watches the water."], {}))
            return
          }
          sse(res, [
            {
              id: "cmpl-tools",
              object: "chat.completion.chunk",
              model: "served-model",
              choices: [
                {
                  index: 0,
                  delta: {
                    role: "assistant",
                    tool_calls: [
                      {
                        index: 0,
                        id: `call_${done}`,
                        type: "function",
                        function: { name: call[0], arguments: JSON.stringify(call[1]) }
                      }
                    ]
                  },
                  finish_reason: null
                }
              ]
            },
            {
              id: "cmpl-tools",
              object: "chat.completion.chunk",
              model: "served-model",
              choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }]
            }
          ])
        }
      }
    )
  )

  it.live("partial joins, re-joins, frozen forks, swipes and deleted joins retain the tool boundary", () =>
    runStory("separate", (t) =>
      Effect.gen(function* () {
        const own = yield* t.append(t.F, t.mira, "LANTERNONLY")
        yield* t.append(t.D, t.wren, "MISSEDDOCKS")
        const dockTip = (yield* t.reader.ReadPath({
          userId: t.userId,
          chatId: t.chatId,
          forkId: t.D,
          leafSlotId: null,
          range: { _tag: "Bottom" },
          limit: 1
        })).entries[0]!.slotId
        yield* t.writer.AddStateEvent({
          userId: t.userId,
          chatId: t.chatId,
          forkId: t.D,
          slotId: dockTip,
          versionId: null,
          scope: null,
          data: { key: "away.set", value: { entity: t.mira, away: false } }
        })
        yield* t.append(t.D, t.wren, "KNOWNSOURCE")
        const before = (yield* t.writer.CreateFork({
          userId: t.userId,
          chatId: t.chatId,
          fromForkId: t.F,
          atSlotId: own.slotId
        })).fork.id as ForkId
        const J = (yield* t.join(t.F, [t.D])).entries[0]!
        const frozen = (yield* t.writer.CreateFork({
          userId: t.userId,
          chatId: t.chatId,
          fromForkId: t.F,
          atSlotId: J.slotId
        })).fork.id as ForkId
        const check = (fork: ForkId, known: boolean) =>
          Effect.gen(function* () {
            const mira = yield* toolsFor(t, fork, t.mira)
            const text = yield* mira.run("read_messages", { from: 1, count: 20 })
            assert.notInclude(text, "MISSEDDOCKS")
            if (known) assert.strictEqual(text, REFUSAL)
            else assert.notInclude(text, "KNOWNSOURCE")
            assert.include(yield* mira.run("search_chat", { query: "MISSEDDOCKS" }), known ? REFUSAL : NONE)
          })
        yield* check(before, false)
        yield* check(t.F, true)
        yield* t.writer.AddVersion({
          userId: t.userId,
          slotId: own.slotId,
          forkId: t.F,
          select: true,
          commitDraft: null,
          version: new NewVersion({
            speakerEntityId: t.mira,
            writer: "model",
            content: "LANTERNSWIPE",
            status: "complete",
            macroMode: "verbatim",
            origin: "generated"
          })
        })
        const wren = yield* toolsFor(t, t.F, t.wren)
        assert.notInclude(yield* wren.run("read_messages", { from: 1, count: 20 }), "LANTERNSWIPE")
        yield* t.append(t.D, t.wren, "KNOWNREJOIN")
        const second = (yield* t.join(t.F, [t.D])).entries[0]!
        const mira = yield* toolsFor(t, t.F, t.mira)
        yield* expectRefused(mira)
        yield* t.api.DeleteMessage({ slotId: second.slotId, forkId: t.F })
        const deleted = yield* t.api.DeleteMessage({ slotId: J.slotId, forkId: t.F })
        yield* check(t.F, false)
        yield* check(frozen, true)
        yield* t.api.RestoreBinItem({ itemId: deleted.id })
        yield* check(t.F, true)
        yield* t.api.UndoThreads({ chatId: t.chatId, splitId: t.splitId })
        yield* check(t.F, true)
      })
    )
  )

  it.live("a partial joined view does not disclose skipped source positions through tool results", () =>
    runStory(null, (t) =>
      Effect.gen(function* () {
        yield* t.append(t.F, t.mira, "LANTERNONLY")
        const missed = yield* t.append(t.D, t.wren, "MISSEDSOURCE")
        yield* t.writer.AddStateEvent({
          userId: t.userId,
          chatId: t.chatId,
          forkId: t.D,
          slotId: missed.slotId,
          versionId: null,
          scope: null,
          data: { key: "away.set", value: { entity: t.mira, away: false } }
        })
        yield* t.append(t.D, t.wren, "KNOWNSOURCE")
        yield* t.join(t.F, [t.D], null, "separate")
        const mira = yield* toolsFor(t, t.F, t.mira)
        const result = yield* mira.run("search_chat", { query: "KNOWNSOURCE" })
        assert.notMatch(result, /At the docks #\d+/, "source numbering discloses positions of the missed rows")
      })
    )
  )

  it.live("a together join inside a later separate stretch stays private in tool results", () =>
    runStory(null, (t) =>
      Effect.gen(function* () {
        yield* t.append(t.F, t.mira, "LANTERN-SENTINEL")
        yield* t.append(t.U, t.pell, "UPSTAIRS-SENTINEL")
        yield* t.append(t.D, t.wren, "DOCKS-SENTINEL")
        yield* t.join(t.F, [t.U])
        yield* t.join(t.F, [t.D], null, "separate")
        assert.notInclude(yield* t.contextFor(t.F, t.wren), "UPSTAIRS-SENTINEL")
        const wren = yield* toolsFor(t, t.F, t.wren)
        assert.notInclude(yield* wren.run("read_messages", { from: 1, count: 20 }), "UPSTAIRS-SENTINEL")
        assert.strictEqual(yield* wren.run("search_chat", { query: "UPSTAIRS-SENTINEL" }), REFUSAL)
      })
    )
  )

  it.live("a together join is read by everyone, row by row", () =>
    runStory(
      null,
      (t) =>
        Effect.gen(function* () {
          yield* play(t)
          const crates = yield* numberIn(t, t.D, "Wren counts the crates")
          yield* t.join(t.F, [t.D])
          const mira = yield* toolsFor(t, t.F, t.mira)
          assert.include(
            yield* mira.run("search_chat", { query: "crates" }),
            `(At the docks #${crates}), Wren: Wren counts`
          )
          assert.include(yield* mira.run("search_chat", { query: "tide", speaker: "Nara" }), "thin moon")
          assert.include(yield* mira.run("search_chat", { query: "stokes" }), "Mira stokes the fire")
        }),
      { narrator: true }
    )
  )

  it.live("a whole-path persona opens joined summaries while character reads stay refused", () =>
    runStory(null, (t) =>
      Effect.gen(function* () {
        yield* t.append(t.F, t.mira, "Mira stokes the fire at the Lantern.")
        // Four long docks lines: the join brings the last whole and a summary of the first two.
        for (const x of ["d1", "d2", "d3", "d4"])
          yield* t.append(t.D, t.wren, `Wren at the docks ${x} ${"x".repeat(8000)}`)
        const path = yield* t.reader.ReadPath({
          userId: t.userId,
          chatId: t.chatId,
          forkId: t.D,
          leafSlotId: null,
          range: { _tag: "Bottom" },
          limit: 200
        })
        const docks = path.entries.filter((e) => e.version.content.startsWith("Wren at the docks"))
        const input = (e: (typeof docks)[number]) => ({ slotId: e.slotId, versionId: e.version.id, amendCount: 0 })
        // The source's layer: the shared messages before the threads parted, then the docks' first two.
        yield* completeFixture(
          t.dataDir,
          t.writer,
          t.userId,
          t.chatId,
          path.entries.slice(0, path.entries.indexOf(docks[0]!)).map(input),
          [],
          " Before the threads"
        )
        yield* completeFixture(
          t.dataDir,
          t.writer,
          t.userId,
          t.chatId,
          docks.slice(0, 2).map(input),
          [],
          " LANTERN-FOG over the crates"
        )
        const from = (docks[0]!.position ?? docks[0]!.depth) + 1
        const to = from + 1
        const J = (yield* t.join(t.F, [t.D], null, "separate")).entries[0]!.slotId
        assert.deepStrictEqual(
          t.stored(J).rows.map((r) => r.kind),
          ["summary", "message", "message", "message", "message"]
        )
        const wren = yield* toolsFor(t, t.F, t.tobin)
        const listed = yield* wren.run("search_summaries", { query: "LANTERN-FOG" })
        assert.include(listed, `Messages ${from}–${to} of “At the docks” (joined at message`)
        const opened = yield* wren.run("expand_summary", {
          messages: `${from}–${to}`,
          joined: "at the docks",
          max_tokens: 8000
        })
        assert.include(opened, `(At the docks #${from}), Wren: Wren at the docks d1`)
        assert.include(opened, "Wren at the docks d2")
        assert.notInclude(opened, "d3")
        // Unnamed, the one joined summary with that range opens too.
        assert.include(yield* wren.run("expand_summary", { messages: `${from}–${to}` }), "Wren at the docks d1")
        // The summary row reads in the join as it was sent.
        const hit = yield* wren.run("search_chat", { query: "LANTERN-FOG" })
        assert.include(hit, `(At the docks, summary of #${from}–${to}): `)
        // Mira knew none of the docks: no summary of them, no rows.
        const mira = yield* toolsFor(t, t.F, t.mira)
        const listedForMira = yield* mira.run("search_summaries", { query: "LANTERN-FOG" })
        const openedForMira = yield* mira.run("expand_summary", { messages: `${from}–${to}`, joined: "At the docks" })
        assert.strictEqual(listedForMira, REFUSAL)
        // Only the shared summary before the threads parted.
        assert.strictEqual(openedForMira, REFUSAL)
        yield* expectRefused(mira)
      })
    )
  )

  it.live("separate contexts also refuse joined character reads", () =>
    runStory("separate", (t) =>
      Effect.gen(function* () {
        yield* t.append(t.F, t.mira, "LANTERNSECRET")
        yield* t.append(t.D, t.wren, "DOCKSSECRET")
        const before = yield* toolsFor(t, t.D, t.wren)
        assert.include(yield* before.run("read_messages", { from: 1, count: 20 }), "DOCKSSECRET")
        yield* t.join(t.F, [t.D])
        yield* expectRefused(yield* toolsFor(t, t.F, t.wren))
        yield* expectRefused(yield* toolsFor(t, t.F, t.mira))
        const whole = yield* toolsFor(t, t.F, t.tobin)
        assert.include(yield* whole.run("read_messages", { from: 1, count: 20 }), "DOCKSSECRET")
      })
    )
  )
})

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
import { completeFixture, fixtureSql } from "./support/lcmFixtures.ts"
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
    return { viewers: context.viewers, run, context, snapshot }
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
const PRIVATE_EMPTY = "No earlier messages match."
const addressOf = (text: string) => {
  const address = /Message (v[a-f0-9]{24})/.exec(text)?.[1]
  assert.isDefined(address, text)
  return address!
}
const REFUSAL = "History tools are unavailable for this separate thread view."
const expectPrivateBoundary = (tools: Effect.Success<ReturnType<typeof toolsFor>>) =>
  Effect.gen(function* () {
    const empty = yield* tools.run("search_chat", { query: "NONEXISTENTSYNTHETIC" })
    assert.strictEqual(empty, PRIVATE_EMPTY)
    for (const args of [{ from: 999999 }, { from: 1, joined_from: 999999 }, { from: "v000000000000000000000000" }])
      assert.strictEqual(yield* tools.run("read_messages", args), empty)
    for (const [id, args] of [
      ["search_summaries", { query: "MISSEDSOURCE" }],
      ["search_summaries", { query: "NONEXISTENTSYNTHETIC" }],
      ["expand_summary", { messages: "1–999999", joined: "At the docks" }],
      ["expand_summary", { messages: "999999", joined: "nonexistent" }]
    ] as const)
      assert.strictEqual(yield* tools.run(id, args), REFUSAL)
  })

describe("the agent's read tools across threads", () => {
  it.live("separate joins offer private character addresses while personas and narrators keep source numbers", () =>
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
          const ownLine = yield* toolsFor(t, t.F, t.wren)
          assert.include(yield* ownLine.run("read_messages", { from: crates, count: 1 }), "Wren counts the crates")
          for (const speaker of [t.mira, t.wren, t.quill])
            yield* expectPrivateBoundary(yield* toolsFor(t, t.F, speaker))
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
          assert.isTrue(results.some((r) => r.content.includes("KNOWNDOCKS")))
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
          // Freeze before returning the first address, then carry it through a step edit.
          const original = results.find((r) => r.content.includes("KNOWNDOCKS"))!.content
          const knownAddress = addressOf(original.split("\n").find((l) => l.includes("KNOWNDOCKS"))!)
          const material = yield* t.reader.RolloutMaterial({ userId: t.userId, versionId: started.entry.version.id })
          const saved = JSON.parse(material.snapshot) as ContextSnapshot
          const pinned = JSON.stringify(saved.agentToolState)
          assert.include(pinned, "KNOWNDOCKS")
          assert.notInclude(pinned, "MISSEDTHREADSECRET")
          const pathBefore = yield* t.reader.ReadPath({
            userId: t.userId,
            chatId: t.chatId,
            forkId: t.F,
            leafSlotId: J.slotId,
            range: { _tag: "Bottom" },
            limit: 20
          })
          const anchor = pathBefore.entries.at(-2)!.slotId
          const slot = yield* t.reader.GetSlot({ userId: t.userId, slotId: anchor, forkId: t.F })
          yield* t.writer.InsertMessage({
            userId: t.userId,
            chatId: t.chatId,
            forkId: t.F,
            anchorSlotId: anchor,
            expectedRowVersion: slot.entry.rowVersion,
            body: { _tag: "Write", speaker: t.wren, content: "NEWKNOWN before the old join" }
          })
          const live = yield* toolsFor(t, t.F, t.wren)
          assert.strictEqual(yield* live.run("read_messages", { from: knownAddress, count: 1 }), PRIVATE_EMPTY)
          const current = yield* t.reader.GetSlot({ userId: t.userId, slotId: started.entry.slotId, forkId: t.F })
          const resumed = yield* t.api.ResumeFromStep({
            versionId: started.entry.version.id,
            forkId: t.F,
            expectedRowVersion: current.entry.rowVersion,
            step: 0,
            edit: { kind: "arguments", arguments: { from: knownAddress, count: 1 } }
          })
          yield* eventually(() => finished(t.events, resumed.version.id) !== undefined)
          const resumedMaterial = yield* t.reader.RolloutMaterial({ userId: t.userId, versionId: resumed.version.id })
          const transcript = JSON.parse(resumedMaterial.transcript!) as Array<{
            role: string
            content?: Array<{ text?: string }>
          }>
          const firstResult = transcript.find((m) => m.role === "toolResult")!
          assert.include(JSON.stringify(firstResult), knownAddress)
          assert.include(JSON.stringify(firstResult), "KNOWNDOCKS")
          assert.notInclude(JSON.stringify(firstResult), "NEWKNOWN")
          assert.deepStrictEqual(
            (JSON.parse(resumedMaterial.snapshot) as ContextSnapshot).agentToolState,
            saved.agentToolState
          )
          const rebuilt = yield* t.reader.RebuildContext({ userId: t.userId, snapshot: material.snapshot })
          assert.strictEqual(rebuilt._tag, "Rebuilt")
          if (rebuilt._tag === "Rebuilt") {
            const rebuiltSnapshot = JSON.parse(rebuilt.snapshot) as ContextSnapshot
            assert.deepStrictEqual(rebuiltSnapshot.agentToolState, saved.agentToolState)
            const replay = { ...live.context, cache: new Map<string, unknown>() }
            const tool = historyTools.find((tool) => tool.id === "read_messages")!
            yield* tool.snapshot!.prepare(replay, generationOf(rebuiltSnapshot).agentToolState?.[tool.snapshot!.key])
            const result = yield* tool.execute(replay, { from: knownAddress, count: 1 } as never)
            assert.include(result.text, "KNOWNDOCKS")
            assert.notInclude(result.text, "NEWKNOWN")
          }
          // Synthetic crash immediately before that same read's result was flushed.
          const turns = JSON.parse(resumedMaterial.transcript!) as Array<{ role: string }>
          const firstCall = turns.findIndex((m) => m.role === "assistant")
          yield* fixtureSql(t.dataDir, [
            { sql: "UPDATE rollouts SET status = 'interrupted' WHERE id = ?", params: [resumedMaterial.rolloutId] },
            {
              sql: "UPDATE rollout_payloads SET transcript_json = ? WHERE rollout_id = ?",
              params: [JSON.stringify(turns.slice(0, firstCall + 1)), resumedMaterial.rolloutId]
            }
          ])
          const interrupted = yield* t.reader.GetSlot({ userId: t.userId, slotId: resumed.slotId, forkId: t.F })
          const continued = yield* t.api.ResumeVersion({
            versionId: resumed.version.id,
            forkId: t.F,
            expectedRowVersion: interrupted.entry.rowVersion
          })
          yield* eventually(() => finished(t.events, continued.version.id) !== undefined)
          const continuedMaterial = yield* t.reader.RolloutMaterial({
            userId: t.userId,
            versionId: continued.version.id
          })
          const continuedResult = (JSON.parse(continuedMaterial.transcript!) as Array<{ role: string }>).find(
            (m) => m.role === "toolResult"
          )!
          assert.include(JSON.stringify(continuedResult), knownAddress)
          assert.include(JSON.stringify(continuedResult), "KNOWNDOCKS")
          assert.notInclude(JSON.stringify(continuedResult), "NEWKNOWN")
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
            if (known) assert.include(text, "KNOWNSOURCE")
            else assert.notInclude(text, "KNOWNSOURCE")
            assert.include(yield* mira.run("search_chat", { query: "MISSEDDOCKS" }), known ? PRIVATE_EMPTY : NONE)
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
        yield* expectPrivateBoundary(mira)
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
        assert.include(result, "KNOWNSOURCE", "a known joined row must be usable")
        const address = addressOf(result)
        assert.include(yield* mira.run("read_messages", { from: address, count: 1 }), "KNOWNSOURCE")
        assert.strictEqual(yield* mira.run("search_chat", { query: "MISSEDSOURCE" }), PRIVATE_EMPTY)
        assert.strictEqual(yield* mira.run("search_chat", { query: "NEVEREXISTED" }), PRIVATE_EMPTY)
        assert.strictEqual(
          yield* mira.run("search_chat", { query: "KNOWNSOURCE", before_message: address }),
          PRIVATE_EMPTY
        )
        assert.notMatch(result, /At the docks #\d+/, "source numbering discloses positions of the missed rows")
      })
    )
  )

  it.live("addresses survive re-joins and missed insertions, but a known insertion invalidates only its suffix", () =>
    runStory(null, (t) =>
      Effect.gen(function* () {
        const lantern = yield* t.append(t.F, t.mira, "DESTINATIONPRIVATE")
        yield* t.append(t.D, t.wren, "SOURCEKNOWN")
        yield* t.join(t.F, [t.D], null, "separate")
        const before = yield* toolsFor(t, t.F, t.wren)
        const result = yield* before.run("search_chat", { query: "SOURCEKNOWN" })
        const address = addressOf(result)
        yield* t.append(t.D, t.wren, "NEWREJOINKNOWN")
        yield* t.join(t.F, [t.D], null, "separate")
        const rejoined = yield* toolsFor(t, t.F, t.wren)
        assert.strictEqual(yield* rejoined.run("search_chat", { query: "SOURCEKNOWN" }), result)
        const insert = (anchor: SlotId, speaker: EntityId, content: string) =>
          Effect.gen(function* () {
            const slot = yield* t.reader.GetSlot({ userId: t.userId, slotId: anchor, forkId: t.F })
            return yield* t.writer.InsertMessage({
              userId: t.userId,
              chatId: t.chatId,
              forkId: t.F,
              anchorSlotId: anchor,
              expectedRowVersion: slot.entry.rowVersion,
              body: { _tag: "Write", speaker, content }
            })
          })
        yield* insert(lantern.slotId, t.mira, "MISSEDINSERT")
        const missed = yield* toolsFor(t, t.F, t.wren)
        assert.strictEqual(yield* missed.run("search_chat", { query: "SOURCEKNOWN" }), result)
        assert.strictEqual(yield* missed.run("search_chat", { query: "MISSEDINSERT" }), PRIVATE_EMPTY)
        yield* insert(lantern.slotId, t.wren, "KNOWNINSERT")
        const changed = yield* toolsFor(t, t.F, t.wren)
        assert.strictEqual(yield* changed.run("read_messages", { from: address }), PRIVATE_EMPTY)
        assert.notStrictEqual(addressOf(yield* changed.run("search_chat", { query: "SOURCEKNOWN" })), address)
        // A running projection keeps its old address and contents until it finishes.
        assert.include(yield* before.run("read_messages", { from: address, count: 1 }), "SOURCEKNOWN")
        assert.notInclude(yield* changed.run("read_messages", { from: 1, count: 20 }), "MISSEDINSERT")
      })
    )
  )

  it.live("a joined view counts an absence only between known rows of that same storyline", () =>
    runStory("separate", (t) =>
      Effect.gen(function* () {
        yield* t.append(t.F, t.mira, "DESTINATIONKNOWN")
        const prefix = yield* t.append(t.D, t.wren, "MISSEDPREFIX")
        const presence = (slot: SlotId, away: boolean) =>
          t.writer.AddStateEvent({
            userId: t.userId,
            chatId: t.chatId,
            forkId: t.D,
            slotId: slot,
            versionId: null,
            scope: null,
            data: { key: "away.set", value: { entity: t.mira, away } }
          })
        yield* presence(prefix.slotId, false)
        const a = yield* t.append(t.D, t.wren, "KNOWNFIRST")
        yield* presence(a.slotId, true)
        yield* t.append(t.D, t.wren, "MISSEDMIDDLEONE")
        const lastMissed = yield* t.append(t.D, t.wren, "MISSEDMIDDLETWO")
        yield* presence(lastMissed.slotId, false)
        yield* t.append(t.D, t.wren, "KNOWNLAST")
        yield* t.join(t.F, [t.D])
        const tools = yield* toolsFor(t, t.F, t.mira)
        const first = yield* tools.run("search_chat", { query: "KNOWNFIRST" })
        const last = yield* tools.run("search_chat", { query: "KNOWNLAST" })
        const n = (text: string) => Number(/view #(\d+)/.exec(text)![1])
        assert.strictEqual(yield* tools.run("read_messages", { from: n(first) + 1, count: 1 }), PRIVATE_EMPTY)
        assert.strictEqual(n(last) - n(first), 3, "two missed messages inside her own storyline keep their gap")
        const read = yield* tools.run("read_messages", { from: addressOf(first), count: 2 })
        assert.include(read, "KNOWNLAST")
        for (const sentinel of ["MISSEDPREFIX", "MISSEDMIDDLEONE", "MISSEDMIDDLETWO"])
          assert.strictEqual(yield* tools.run("search_chat", { query: sentinel }), PRIVATE_EMPTY)
        assert.notMatch(read, /At the docks #|joined at message|source_|created_at|ordinal/)
      })
    )
  )

  it.live("nested sets, each join's choice and Context switches share the result boundary", () =>
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
        yield* t.join(t.D, [under], null, "separate")
        const sourceTools = yield* toolsFor(t, t.D, t.wren)
        const sourceAddress = addressOf(yield* sourceTools.run("search_chat", { query: "PIERKNOWN" }))
        yield* t.join(t.F, [t.D], null, "separate")
        const wren = yield* toolsFor(t, t.F, t.wren)
        assert.include(yield* wren.run("search_chat", { query: "PIERKNOWN" }), sourceAddress)
        assert.include(yield* wren.run("read_messages", { from: sourceAddress, count: 1 }), "PIERKNOWN")
        assert.strictEqual(yield* wren.run("search_chat", { query: "NESTEDSECRET" }), PRIVATE_EMPTY)
        assert.notInclude(yield* wren.run("read_messages", { from: 1, count: 20 }), "NESTEDSECRET")
        yield* t.append(t.U, t.pell, "TOGETHERKNOWN")
        yield* t.join(t.F, [t.U], null, "together")
        const check = (shared: boolean) =>
          Effect.gen(function* () {
            const mira = yield* toolsFor(t, t.F, t.mira)
            const result = yield* mira.run("search_chat", { query: "TOGETHERKNOWN" })
            if (shared) assert.include(result, "TOGETHERKNOWN")
            else assert.strictEqual(result, PRIVATE_EMPTY)
            assert.strictEqual(yield* mira.run("search_chat", { query: "PIERKNOWN" }), PRIVATE_EMPTY)
            yield* expectPrivateBoundary(mira)
          })
        yield* check(true)
        const tip = (yield* t.reader.ReadPath({
          userId: t.userId,
          chatId: t.chatId,
          forkId: t.F,
          leafSlotId: null,
          range: { _tag: "Bottom" },
          limit: 1
        })).entries[0]!.slotId
        for (const value of ["separate", "shared"] as const) {
          yield* t.writer.AddStateEvent({
            userId: t.userId,
            chatId: t.chatId,
            forkId: t.F,
            slotId: tip,
            versionId: null,
            scope: null,
            data: { key: "context.per_speaker", value }
          })
          yield* check(value === "shared")
        }
      })
    )
  )

  it.live("a frozen nested-row fixture keeps a uniform refusal for embedded source ranges", () =>
    runStory(null, (t) =>
      Effect.gen(function* () {
        yield* t.append(t.F, t.mira, "DESTINATION")
        yield* t.append(t.D, t.wren, "KNOWNDOCKS")
        yield* t.join(t.F, [t.D], null, "separate")
        const tools = yield* toolsFor(t, t.F, t.wren)
        // Current thread joins omit joins from their frozen source rows. Model a future or
        // legacy frozen compound row explicitly: its nested provenance must fail closed.
        const context: ToolContext = {
          ...tools.context,
          reader: {
            ...t.reader,
            JoinRows: ((input) =>
              t.reader.JoinRows(input).pipe(
                Effect.map((joins) =>
                  joins.map((join) => ({
                    ...join,
                    rows: join.rows.map((row) => ({
                      ...row,
                      sourceJoin: row.kind === "message" ? true : row.sourceJoin
                    }))
                  }))
                )
              )) as ToolContext["reader"]["JoinRows"]
          }
        }
        for (const [id, args] of [
          ["read_messages", { from: 1 }],
          ["read_messages", { from: 999999 }],
          ["search_chat", { query: "KNOWNDOCKS" }],
          ["search_chat", { query: "MISSEDSOURCE" }],
          ["search_chat", { query: "NONEXISTENT" }],
          ["search_summaries", { query: "KNOWNDOCKS" }],
          ["expand_summary", { messages: "1–99" }]
        ] as const) {
          const result = yield* historyTools.find((tool) => tool.id === id)!.execute(context, args as never)
          assert.strictEqual(result.text, REFUSAL)
          assert.isTrue(result.isError)
        }
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
        assert.strictEqual(yield* wren.run("search_chat", { query: "UPSTAIRS-SENTINEL" }), PRIVATE_EMPTY)
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

  it.live("a whole-path persona opens joined summaries while private summary tools stay refused", () =>
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
        yield* expectPrivateBoundary(mira)
      })
    )
  )

  it.live("separate contexts also offer only known joined rows", () =>
    runStory("separate", (t) =>
      Effect.gen(function* () {
        yield* t.append(t.F, t.mira, "LANTERNSECRET")
        yield* t.append(t.D, t.wren, "DOCKSSECRET")
        const before = yield* toolsFor(t, t.D, t.wren)
        assert.include(yield* before.run("read_messages", { from: 1, count: 20 }), "DOCKSSECRET")
        yield* t.join(t.F, [t.D])
        yield* expectPrivateBoundary(yield* toolsFor(t, t.F, t.wren))
        yield* expectPrivateBoundary(yield* toolsFor(t, t.F, t.mira))
        const whole = yield* toolsFor(t, t.F, t.tobin)
        assert.include(yield* whole.run("read_messages", { from: 1, count: 20 }), "DOCKSSECRET")
      })
    )
  )
})

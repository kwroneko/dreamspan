// The agent's read tools across threads (spec/THREADS.md §11, TH8) through the real server: a
// thread's tools never find another thread before a join; after one, search_chat and
// read_messages read the join's rows as messages ("Message 9 (At the docks #6), Wren: …"), and
// with the join's view only the rows the speaker knew; expand_summary and search_summaries read
// a join's frozen summary rows under the same rule. Mira at the Lantern, Wren at the docks,
// Nara the narrator in both. Synthetic data only.
import { assert, describe, it } from "@effect/vitest"
import { type EntityId, type ForkId, NewVersion, type SlotId } from "@rp/shared/chat.ts"
import { STRETCH_VIEW } from "@rp/shared/knowledge.ts"
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

describe("the agent's read tools across threads", () => {
  it.live(
    "a thread's tools never find another thread before a join, and after a separate one only what each knew",
    () =>
      runStory(
        null,
        (t) =>
          Effect.gen(function* () {
            const { lanternSlot } = yield* play(t)
            const crates = yield* numberIn(t, t.D, "Wren counts the crates")
            // Before the join: each thread's tools read only its own line.
            const miraBefore = yield* toolsFor(t, t.F, t.mira)
            assert.include(yield* miraBefore.run("search_chat", { query: "crates" }), NONE)
            assert.include(yield* miraBefore.run("search_chat", { query: "stokes" }), "Mira stokes the fire")
            const wrenBefore = yield* toolsFor(t, t.D, t.wren)
            assert.include(yield* wrenBefore.run("search_chat", { query: "stokes" }), NONE)

            const J = (yield* t.join(t.F, [t.D], null, "separate")).entries[0]!.slotId
            // A Lantern message inserted into the stretch after the join is the stretch's too.
            const slot = yield* t.reader.GetSlot({ userId: t.userId, slotId: lanternSlot, forkId: t.F })
            yield* t.writer.InsertMessage({
              userId: t.userId,
              chatId: t.chatId,
              forkId: t.F,
              anchorSlotId: lanternSlot,
              expectedRowVersion: slot.entry.rowVersion,
              body: { _tag: "Write", speaker: t.mira, content: "Mira mends a torn sail by the hearth." }
            })
            const shown = yield* t.reader.ReadPath({
              userId: t.userId,
              chatId: t.chatId,
              forkId: t.F,
              leafSlotId: null,
              range: { _tag: "Bottom" },
              limit: 200
            })
            const joinEntry = shown.entries.find((e) => e.slotId === J)!
            const n = (joinEntry.position ?? joinEntry.depth) + 1

            // Wren, read whole in a shared context: the docks rows as messages, nothing of the Lantern.
            const wren = yield* toolsFor(t, t.F, t.wren)
            assert.include(wren.viewers ?? [], STRETCH_VIEW)
            const found = yield* wren.run("search_chat", { query: "crates" })
            assert.include(found, `Message ${n} (At the docks #${crates}), Wren: Wren counts the crates on the pier.`)
            assert.include(yield* wren.run("search_chat", { query: "stokes" }), NONE)
            assert.include(yield* wren.run("search_chat", { query: "sail" }), NONE)
            const read = yield* wren.run("read_messages", { from: 1, count: 20 })
            assert.include(read, "The tide turns under a thin moon.")
            assert.notInclude(read, "stokes the fire")
            assert.notInclude(read, "torn sail")
            assert.notInclude(read, "Here “At the docks” joins")
            // Inside the join: from its second row.
            const inside = yield* wren.run("read_messages", { from: n, joined_from: crates + 1, count: 5 })
            assert.notInclude(inside, "crates")
            assert.include(
              inside,
              `Message ${n} (At the docks #${crates + 1}), Nara: The tide turns under a thin moon.`
            )

            // Mira: the Lantern, its inserted message too, nothing of the docks.
            const mira = yield* toolsFor(t, t.F, t.mira)
            assert.include(yield* mira.run("search_chat", { query: "crates" }), NONE)
            assert.include(yield* mira.run("search_chat", { query: "sail" }), "torn sail")
            assert.notInclude(yield* mira.run("read_messages", { from: 1, count: 20 }), "crates")

            // Nara, the narrator, reads it all.
            const nara = yield* toolsFor(t, t.F, t.nara!)
            assert.isNull(nara.viewers)
            assert.include(yield* nara.run("search_chat", { query: "crates" }), `(At the docks #${crates}), Wren:`)
            assert.include(yield* nara.run("search_chat", { query: "stokes" }), "Mira stokes the fire")
          }),
        { narrator: true }
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

  it.live("a join's summaries open for those who knew what they condense", () =>
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
        const wren = yield* toolsFor(t, t.F, t.wren)
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
        assert.include(listedForMira, "No summaries match")
        // Only the shared summary before the threads parted.
        assert.strictEqual(
          openedForMira,
          `No summary covers exactly messages ${from}–${to} of “At the docks”. Summaries: 1–${from - 1}.`
        )
        assert.include(yield* mira.run("search_chat", { query: "LANTERN-FOG" }), NONE)
      })
    )
  )

  it.live("with separate contexts a join is read by presence, row by row", () =>
    runStory("separate", (t) =>
      Effect.gen(function* () {
        yield* t.append(t.F, t.mira, "Mira stokes the fire at the Lantern.")
        yield* t.append(t.D, t.wren, "Wren counts the crates on the pier.")
        const crates = yield* numberIn(t, t.D, "Wren counts the crates")
        yield* t.join(t.F, [t.D])
        const wren = yield* toolsFor(t, t.F, t.wren)
        assert.notInclude(wren.viewers ?? [], STRETCH_VIEW)
        assert.include(
          yield* wren.run("search_chat", { query: "crates" }),
          `(At the docks #${crates}), Wren: Wren counts`
        )
        assert.include(yield* wren.run("search_chat", { query: "stokes" }), NONE)
        const mira = yield* toolsFor(t, t.F, t.mira)
        assert.include(yield* mira.run("search_chat", { query: "crates" }), NONE)
      })
    )
  )
})

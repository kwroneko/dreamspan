// Inference attacks on a character's private addresses after a separate join (spec/THREADS.md
// §11.1, review-threads5): every assertion is on the tool result text the model would get.
// Mira at the Lantern, Wren at the docks, Pell under the pier. Synthetic data only.
import { assert, describe, it } from "@effect/vitest"
import { type EntityId, type ForkId, NewVersion, type SlotId } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import { type ContextSnapshot, generationOf } from "../src/assembler/types.ts"
import type { ToolContext } from "../src/agent/tools.ts"
import { historyTools } from "../src/agent/tools/history.ts"
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
    return Object.assign(run, { context })
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
          viewNumber(yield* inDocks("search_chat", { query: "AFTERNESTED" })) -
          viewNumber(yield* inDocks("search_chat", { query: "PIERKNOWN" }))
        assert.strictEqual(docksGap, 1, "the docks' own view says nothing of Pell's storyline")
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

  it.live("a frozen view keeps no text, and thawed after edits resolves only rows it froze", () =>
    runStory(null, (t) =>
      Effect.gen(function* () {
        const first = yield* t.append(t.F, t.mira, "LANTERNFIRST")
        const second = yield* t.append(t.F, t.mira, "LANTERNSECOND")
        yield* t.append(t.F, t.mira, "LANTERNTHIRD")
        yield* t.append(t.D, t.wren, "DOCKSMISSED")
        yield* t.join(t.F, [t.D], null, "separate")
        const mira = yield* toolsFor(t, t.F, t.mira)
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
        // A known message inserted before them: the old addresses still name the same rows, and
        // the new one isn't part of the frozen view.
        const slot = yield* t.reader.GetSlot({ userId: t.userId, slotId: first.slotId, forkId: t.F })
        yield* t.writer.InsertMessage({
          userId: t.userId,
          chatId: t.chatId,
          forkId: t.F,
          anchorSlotId: first.slotId,
          expectedRowVersion: slot.entry.rowVersion,
          body: { _tag: "Write", speaker: t.mira, content: "LANTERNINSERTED" }
        })
        const afterInsert = yield* thawed(mira.context, frozen)
        assert.include(yield* afterInsert("read_messages", { from: a3, count: 1 }), "LANTERNTHIRD")
        assert.strictEqual(yield* afterInsert("search_chat", { query: "LANTERNINSERTED" }), PRIVATE_EMPTY)
        // A frozen row deleted since: its address answers as a missing one; the next still reads.
        yield* t.api.DeleteMessage({ slotId: second.slotId, forkId: t.F })
        const afterDelete = yield* thawed(mira.context, frozen)
        assert.strictEqual(yield* afterDelete("read_messages", { from: a2, count: 1 }), PRIVATE_EMPTY)
        assert.include(yield* afterDelete("read_messages", { from: a3, count: 1 }), "LANTERNTHIRD")
        assert.notInclude(yield* afterDelete("read_messages", { from: 1, count: 20 }), "DOCKSMISSED")
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
        // Mira at the Lantern: private.
        for (const [fork, speaker, isPrivate] of [
          [t.D, t.wren, false],
          [t.F, t.mira, true]
        ] as const) {
          const tools = yield* toolsFor(t, fork, speaker)
          const state = yield* hook.prepare({ ...tools.context, cache: new Map() }, undefined)
          assert.strictEqual(hook.freeze!(state) !== undefined, isPrivate)
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
          assert.include(text, isPrivate ? "LANTERNOWN" : "DOCKSOWN")
          assert.strictEqual(paths, 0)
        }
      })
    )
  )
})

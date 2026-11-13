// What each speaker reads at a join (spec/THREADS.md §7.3, TH6) through the real server, in a
// chat with one shared context: Mira at the Lantern, Wren at the docks, Nara the narrator in both.
// A join that keeps the timelines separate filters its parallel stretch only: Wren reads the docks
// as her own history (her request through the docks is the one she had there), Mira reads the
// Lantern and nothing of the docks, Nara reads both with the docks as the labelled section. A
// together join reads as merges always have, and a request before the join never sees the docks.
// Synthetic data only.
import { assert, describe, it } from "@effect/vitest"
import { type ForkId, NewVersion, type SlotId } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import type { ContextSnapshot } from "../src/assembler/types.ts"
import { runStory, sentText, type ThreadStory } from "./support/threadStory.ts"

const SECTION = "Meanwhile, in parallel with what follows: At the docks"

const texts = (snapshot: ContextSnapshot) =>
  snapshot.request.messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))

/** The docks and the Lantern each go on: two lines apiece after the threads part. */
const play = (t: ThreadStory) =>
  Effect.gen(function* () {
    const lantern = yield* t.append(t.F, t.mira, "Mira stokes the fire at the Lantern.")
    yield* t.append(t.F, t.mira, "Mira asks the keeper for two rooms.")
    yield* t.append(t.D, t.wren, "Wren counts the crates on the pier.")
    yield* t.append(t.D, t.nara!, "The tide turns under a thin moon.")
    return { lanternSlot: lantern.slotId as SlotId }
  })

/** The request for a reply by Mira directly after `parent` in `fork`: before anything later there. */
const requestAfter = (t: ThreadStory, fork: ForkId, parent: SlotId) =>
  Effect.gen(function* () {
    const placeholder = yield* t.writer.AppendMessage({
      userId: t.userId,
      chatId: t.chatId,
      forkId: fork,
      parentSlotId: parent,
      branch: true,
      commitDraft: null,
      version: new NewVersion({
        speakerEntityId: t.mira,
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
    return JSON.parse(built.snapshot) as ContextSnapshot
  })

describe("what each speaker reads at a join", () => {
  it.live("separate timelines in a shared-context chat: each character its own thread, the narrator both", () =>
    runStory(
      null,
      (t) =>
        Effect.gen(function* () {
          const { lanternSlot } = yield* play(t)
          // Wren's last request at the docks, before the join.
          const atDocks = texts(yield* t.requestFor(t.D, t.wren))

          // The dialog's choice: offered in a shared-context chat, with each character's view.
          const together = yield* t.preview(t.F, t.D)
          assert.isTrue(together.choosesTimelines)
          assert.strictEqual(together.timelines, "together")
          assert.isUndefined(together.views)
          const seen = yield* t.preview(t.F, t.D, null, "separate")
          assert.strictEqual(seen.timelines, "separate")
          assert.notStrictEqual(seen.digest, together.digest)
          assert.isFalse(seen.views!.find((v) => v.entity === t.mira)!.readable)
          assert.isTrue(seen.views!.find((v) => v.entity === t.wren)!.readable)
          assert.isUndefined(seen.views!.find((v) => v.entity === t.nara))

          const J = (yield* t.join(t.F, [t.D], null, "separate")).entries[0]!.slotId
          assert.strictEqual(t.stored(J).merge.timelines, "separate")

          // Wren: the docks as her own messages, nothing of the Lantern, no section.
          const forWren = yield* t.requestFor(t.F, t.wren)
          const wren = sentText(forWren)
          assert.include(wren, "Wren counts the crates on the pier.")
          assert.include(wren, "The tide turns under a thin moon.")
          assert.notInclude(wren, "stokes the fire")
          assert.notInclude(wren, "two rooms")
          assert.notInclude(wren, SECTION)
          // Her request through the docks is the one she had there: its cached prefix carries over.
          const after = texts(forWren)
          const tide = (messages: ReadonlyArray<string>) =>
            messages.findIndex((m) => m.includes("The tide turns under a thin moon."))
          assert.isAbove(tide(after), 0)
          assert.deepStrictEqual(after.slice(0, tide(after) + 1), atDocks.slice(0, tide(atDocks) + 1))

          // Mira: the Lantern, nothing of the docks.
          const mira = yield* t.contextFor(t.F, t.mira)
          assert.include(mira, "stokes the fire")
          assert.include(mira, "two rooms")
          assert.notInclude(mira, "crates on the pier")
          assert.notInclude(mira, SECTION)

          // Nara, the narrator: both, the docks as the labelled section, as together.
          const nara = yield* t.contextFor(t.F, t.nara!)
          assert.include(nara, SECTION)
          assert.include(nara, "crates on the pier")
          assert.include(nara, "stokes the fire")

          // Before the join, nobody reads the docks (causal order).
          const before = sentText(yield* requestAfter(t, t.F, lanternSlot))
          assert.notInclude(before, "crates on the pier")
        }),
      { narrator: true }
    )
  )

  it.live(
    "a message inserted into the stretch after a separate join is the stretch's too: never read by one who wasn't there",
    () =>
      runStory(
        null,
        (t) =>
          Effect.gen(function* () {
            const { lanternSlot } = yield* play(t)
            yield* t.join(t.F, [t.D], null, "separate")
            const insert = (anchor: SlotId, content: string) =>
              Effect.gen(function* () {
                const slot = yield* t.reader.GetSlot({ userId: t.userId, slotId: anchor, forkId: t.F })
                return yield* t.writer.InsertMessage({
                  userId: t.userId,
                  chatId: t.chatId,
                  forkId: t.F,
                  anchorSlotId: anchor,
                  expectedRowVersion: slot.entry.rowVersion,
                  body: { _tag: "Write", speaker: t.mira, content }
                })
              })
            // In the Lantern after the join: right after the split, and among its messages.
            yield* insert(t.S, "A lamp is lit in the Lantern's window.")
            yield* insert(lanternSlot, "Mira mends a torn sail by the hearth.")
            const mira = yield* t.contextFor(t.F, t.mira)
            assert.include(mira, "A lamp is lit in the Lantern's window.")
            assert.include(mira, "Mira mends a torn sail by the hearth.")
            const wren = yield* t.contextFor(t.F, t.wren)
            assert.include(wren, "Wren counts the crates on the pier.")
            assert.notInclude(wren, "A lamp is lit")
            assert.notInclude(wren, "torn sail")
            assert.notInclude(wren, "stokes the fire")
            // Both are recorded in the join's stretch.
            const stretch = t.stretchOf(t.F)
            assert.strictEqual(stretch.filter((row) => row.inserted === 1 && row.opens === 0).length, 2)
          }),
        { narrator: true }
      )
  )

  it.live("a together join reads as merges do: everyone both threads, the docks as the section", () =>
    runStory(
      null,
      (t) =>
        Effect.gen(function* () {
          yield* play(t)
          const J = (yield* t.join(t.F, [t.D])).entries[0]!.slotId
          assert.strictEqual(t.stored(J).merge.timelines, "together")
          const wren = yield* t.requestFor(t.F, t.wren)
          const mira = yield* t.requestFor(t.F, t.mira)
          for (const text of [sentText(wren), sentText(mira)]) {
            assert.include(text, SECTION)
            assert.include(text, "crates on the pier")
            assert.include(text, "stokes the fire")
          }
          // The same history for both: only the reply's own turn differs.
          const history = (snapshot: ContextSnapshot) => {
            const all = texts(snapshot)
            return all.slice(0, all.findIndex((m) => m.includes("Here “At the docks” joins")) + 1)
          }
          assert.isAbove(history(wren).length, 0)
          assert.deepStrictEqual(history(wren), history(mira))
        }),
      { narrator: true }
    )
  )
})

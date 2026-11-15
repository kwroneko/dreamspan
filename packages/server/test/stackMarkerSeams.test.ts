// Marker membership uses the same destination/selected-version projection as assembly.
import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { runMergeStory, sentText } from "./support/mergeOrigin.ts"

it.live("separate-history joins mark destination cast changes; swipe selection keeps only its own effects", () =>
  runMergeStory((t) =>
    Effect.gen(function* () {
      const kai = yield* t.card("Kai")
      const source = yield* t.chat("Pier", [kai])
      yield* t.say(source, kai, "SOURCE-MARKER-SEAM")
      yield* t.mark(source, { key: "cards.rotation", value: { on: true } })
      const joined = yield* t.merge(t.ledger, source, "separate")
      const read = (slotId: typeof joined.slotId) =>
        t.api.GetStateMarks({
          ...t.ledger,
          slotId,
          keys: ["participant.join", "cards.rotation", "presence.set", "decision.points"]
        })
      const joinedMarks = yield* read(joined.slotId)
      assert.isTrue(
        joinedMarks.events.some(
          (e) =>
            e.slotId === joined.slotId && e.key === "participant.join" && (e.value as { entity: string }).entity === kai
        )
      )
      assert.isFalse(joinedMarks.events.some((e) => e.key === "cards.rotation"))
      assert.include(sentText(yield* t.requestFor(t.ledger, kai)), "SOURCE-MARKER-SEAM")
      const slotId = yield* t.say(t.ledger, t.mira, "Original destination swipe.")
      const page = yield* t.api.ReadPath({ ...t.ledger, leafSlotId: null, range: { _tag: "Bottom" }, limit: 20 })
      const original = page.entries.find((e) => e.slotId === slotId)!
      yield* t.writer.AddStateEvent({
        userId: t.userId,
        ...t.ledger,
        slotId,
        versionId: original.version.id,
        scope: null,
        data: { key: "presence.set", value: { entity: t.wren, present: false } }
      })
      yield* t.api.ChangeCast({ ...t.ledger, slotId, change: { _tag: "DecisionPoints", off: ["lore"] } })
      assert.isTrue((yield* read(slotId)).events.some((e) => e.versionId === original.version.id))
      const alternate = yield* t.api.WriteVersion({
        slotId,
        forkId: t.ledger.forkId,
        content: "A short alternative.",
        expectedRowVersion: original.rowVersion
      })
      // Find/sort are presentation of this unchanged list, not a state projection of their own.
      const versions = yield* t.api.ListVersions({ slotId, forkId: t.ledger.forkId })
      assert.sameMembers(
        versions.map((v) => v.id),
        [original.version.id, alternate.version.id]
      )
      const swapped = yield* read(slotId)
      assert.isFalse(swapped.events.some((e) => e.versionId === original.version.id))
      assert.isTrue(
        swapped.events.some((e) => e.key === "decision.points" && e.slotId === slotId && e.versionId === null)
      )
      yield* t.api.SelectVersion({
        slotId,
        forkId: t.ledger.forkId,
        versionId: original.version.id,
        expectedVersionId: alternate.version.id
      })
      assert.isTrue((yield* read(slotId)).events.some((e) => e.versionId === original.version.id))
    })
  )
)

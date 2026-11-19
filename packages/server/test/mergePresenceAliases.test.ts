import { assert, it } from "@effect/vitest"
import { NewVersion, type EntityId } from "@dreamspan/shared/chat.ts"
import { Effect } from "effect"
import { runMergeStory, sentText } from "./support/mergeOrigin.ts"

it.live(
  "a replaced card keeps its destination shared past without needing a new authored turn",
  () =>
    runMergeStory((t) =>
      Effect.gen(function* () {
        yield* t.away(t.ledger, t.wren, true)
        yield* t.say(t.ledger, t.mira, "DESTINATION-SHARED-WHILE-AWAY")
        const next = yield* t.api.ForkCardForChat({
          ...t.ledger,
          slotId: yield* t.tip(t.ledger),
          entityId: t.wren,
          name: "Wren next",
          nickname: "Wren",
          characterVersion: "2"
        })
        const replacement = next.entityId as EntityId
        const source = yield* t.chat("Docks", [replacement])
        yield* t.say(source, replacement, "SOURCE-REPLACEMENT")
        assert.include(sentText(yield* t.requestFor(t.ledger, replacement)), "DESTINATION-SHARED-WHILE-AWAY")
        yield* t.merge(t.ledger, source, "separate")
        const request = sentText(yield* t.requestFor(t.ledger, replacement))
        assert.include(request, "DESTINATION-SHARED-WHILE-AWAY")
        assert.include(request, "SOURCE-REPLACEMENT")
      })
    ),
  { timeout: 120_000 }
)

it.live(
  "an unselected authored swipe remains evidence of destination presence",
  () =>
    runMergeStory((t) =>
      Effect.gen(function* () {
        const kai = yield* t.card("Kai")
        const source = yield* t.chat("Docks", [kai])
        yield* t.say(source, kai, "SOURCE-SWIPE")
        const parent = yield* t.say(t.ledger, t.mira, "DESTINATION-OLDER")
        yield* t.mark(t.ledger, { key: "participant.join", value: { entity: kai } })
        const slotId = yield* t.say(t.ledger, t.mira, "SHARED-ORIGINAL-SWIPE")
        // Correct the earlier cast, then create a new selected swipe without Kai. The
        // retained original still records that he participated, as ordinary history does.
        yield* t.writer.AddStateEvent({
          userId: t.userId,
          ...t.ledger,
          slotId: parent,
          versionId: null,
          scope: null,
          data: { key: "participant.leave", value: { entity: kai } }
        })
        yield* t.writer.AddVersion({
          userId: t.userId,
          slotId,
          forkId: t.ledger.forkId,
          select: true,
          commitDraft: null,
          version: new NewVersion({
            speakerEntityId: t.mira,
            writer: "model",
            content: "SHARED-SELECTED-SWIPE",
            status: "complete",
            macroMode: "verbatim",
            origin: "generated"
          })
        })
        yield* t.mark(t.ledger, { key: "participant.join", value: { entity: kai } })
        assert.include(sentText(yield* t.requestFor(t.ledger, kai)), "DESTINATION-OLDER")
        yield* t.merge(t.ledger, source, "separate")
        const request = sentText(yield* t.requestFor(t.ledger, kai))
        assert.include(request, "DESTINATION-OLDER")
        assert.include(request, "SHARED-SELECTED-SWIPE")
        assert.include(request, "SOURCE-SWIPE")
      })
    ),
  { timeout: 120_000 }
)

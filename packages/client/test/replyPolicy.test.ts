import { assert, it } from "@effect/vitest"
import type { EntityId } from "@rp/shared/chat.ts"
import { Cast } from "@rp/shared/chatSetupApi.ts"
import { Effect } from "effect"
import { nextInTurn, replyPolicies } from "../src/features/chat/replyPolicy.ts"

it.effect("a scoped reply policy changes the composer's choice, disables and restores", () =>
  Effect.gen(function* () {
    const a = "synthetic-a" as EntityId,
      b = "synthetic-b" as EntityId
    const cast = new Cast({
      slotId: null,
      participants: [a, b],
      absent: [],
      playedByMe: [],
      model: null,
      preset: null,
      lorebooks: [],
      cardLorebooksOff: [],
      globalLorebooksOff: [],
      loreBelowHistory: true,
      rolesProjection: null,
      cards: []
    })
    assert.deepStrictEqual(nextInTurn(cast, [], null), { id: a, after: null })
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Effect.sync(() => replyPolicies.register({ id: "round-robin", next: () => ({ id: b, after: a }) })),
          (undo) => Effect.sync(undo)
        )
        assert.deepStrictEqual(nextInTurn(cast, [], null), { id: b, after: a })
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.acquireRelease(
              Effect.sync(() => replyPolicies.disable("round-robin")),
              (undo) => Effect.sync(undo)
            )
            assert.isNull(nextInTurn(cast, [], null))
          })
        )
        assert.strictEqual(nextInTurn(cast, [], null)?.id, b)
      })
    )
    assert.strictEqual(nextInTurn(cast, [], null)?.id, a)
  })
)

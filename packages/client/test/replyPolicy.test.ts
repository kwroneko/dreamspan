import { assert, it } from "@effect/vitest"
import type { EntityId } from "@rp/shared/chat.ts"
import { Cast } from "@rp/shared/chatSetupApi.ts"
import { Effect } from "effect"
import { nextInTurn, planReply, replyPolicies } from "../src/features/chat/replyPolicy.ts"

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
    assert.deepStrictEqual(planReply(cast, [], null, null), { next: { id: a, after: null }, replier: a, reply: true })
    // Empty casts still permit the existing unnamed reply; null alone cannot mean disabled.
    assert.isTrue(planReply(null, [], null, null).reply)
    assert.isFalse(planReply({ ...cast, absent: [a, b] }, [], null, null).reply)
    assert.isTrue(planReply({ ...cast, absent: [a, b] }, [], null, b).reply)
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Effect.sync(() => replyPolicies.register({ id: "round-robin", next: () => ({ id: b, after: a }) })),
          (undo) => Effect.sync(undo)
        )
        assert.deepStrictEqual(nextInTurn(cast, [], null), { id: b, after: a })
        assert.deepStrictEqual(planReply(cast, [], null, null), { next: { id: b, after: a }, replier: b, reply: true })
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.acquireRelease(
              Effect.sync(() => replyPolicies.disable("round-robin")),
              (undo) => Effect.sync(undo)
            )
            assert.isNull(nextInTurn(cast, [], null))
            assert.deepStrictEqual(planReply(cast, [], null, null), { next: null, replier: null, reply: false })
            assert.deepStrictEqual(planReply(cast, [], null, b), { next: null, replier: b, reply: true })
            assert.isFalse(planReply(null, [], null, null).reply)
          })
        )
        assert.strictEqual(nextInTurn(cast, [], null)?.id, b)
      })
    )
    assert.strictEqual(nextInTurn(cast, [], null)?.id, a)
    assert.isTrue(planReply(cast, [], null, null).reply)
    const undo = replyPolicies.register({ id: "round-robin", next: () => null })
    try {
      assert.isFalse(planReply(cast, [], null, null).reply, "a plugin can decline an automatic reply")
    } finally {
      undo()
    }
  })
)

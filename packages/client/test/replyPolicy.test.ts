import { assert, it } from "@effect/vitest"
import { CastCard, type EntityId, type PathEntry } from "@rp/shared/chat.ts"
import { Cast } from "@rp/shared/chatSetupApi.ts"
import { Effect } from "effect"
import { AUTO_POLICY, nextInTurn, planReply, replyPolicies } from "../src/features/chat/replyPolicy.ts"

const card = (id: EntityId, name: string, talkativeness: number) =>
  new CastCard({
    entityId: id,
    name,
    label: name,
    persona: false,
    inBin: false,
    talkativeness,
    lorebook: false,
    avatarMediaId: null
  })

const castOf = (participants: Array<EntityId>, cards: Array<CastCard>, more: Partial<Cast> = {}) =>
  new Cast({
    slotId: null,
    participants,
    absent: [],
    playedByMe: [],
    model: null,
    preset: null,
    lorebooks: [],
    cardLorebooksOff: [],
    listedLorebooks: [],
    loreBelowHistory: true,
    macroBindings: {},
    macroNames: { user: "User", char: "" },
    rolesProjection: null,
    roleProjections: [],
    cards,
    ...more
  })

/** A turn on the path: only what the policies read. */
const turn = (id: string, speaker: EntityId | null, content = "") =>
  ({ version: { id, speakerEntityId: speaker, content } }) as unknown as PathEntry

it.effect("a scoped reply policy changes the composer's choice, disables and restores", () =>
  Effect.gen(function* () {
    const a = "synthetic-a" as EntityId,
      b = "synthetic-b" as EntityId
    // a always passes the roll and b never does, so Auto's pick is a.
    const cast = castOf([a, b], [card(a, "Ana", 1), card(b, "Bram", 0)])
    assert.strictEqual(AUTO_POLICY, "natural")
    assert.isDefined(replyPolicies.get("round-robin"), "round-robin stays registered")
    assert.deepStrictEqual(nextInTurn(cast, [], null), { id: a, after: null })
    assert.deepStrictEqual(planReply(cast, [], null, null), { next: { id: a, after: null }, replier: a, reply: true })
    // Empty casts still permit the existing unnamed reply; null alone cannot mean disabled.
    assert.isTrue(planReply(null, [], null, null).reply)
    assert.isFalse(planReply({ ...cast, absent: [a, b] }, [], null, null).reply)
    assert.isTrue(planReply({ ...cast, absent: [a, b] }, [], null, b).reply)
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Effect.sync(() => replyPolicies.register({ id: AUTO_POLICY, next: () => ({ id: b, after: a }) })),
          (undo) => Effect.sync(undo)
        )
        assert.deepStrictEqual(nextInTurn(cast, [], null), { id: b, after: a })
        assert.deepStrictEqual(planReply(cast, [], null, null), { next: { id: b, after: a }, replier: b, reply: true })
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.acquireRelease(
              Effect.sync(() => replyPolicies.disable(AUTO_POLICY)),
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
    const undo = replyPolicies.register({ id: AUTO_POLICY, next: () => null })
    try {
      assert.isFalse(planReply(cast, [], null, null).reply, "a plugin can decline an automatic reply")
    } finally {
      undo()
    }
  })
)

it("Auto picks by ST's natural order: named first, then by talkativeness, never the last speaker unasked", () => {
  const [mira, tobin, wren, ana] = ["synthetic-mira", "synthetic-tobin", "synthetic-wren", "synthetic-ana"] as [
    EntityId,
    EntityId,
    EntityId,
    EntityId
  ]
  const cards = [card(mira, "Mira", 1), card(tobin, "Tobin", 0), card(wren, "Wren", 0), card(ana, "Ana", 1)]
  const cast = castOf([mira, tobin, wren, ana], cards, { playedByMe: [ana] })
  const user = [turn("v1", ana, "The lantern gutters.")]
  // No one named: Mira's roll always passes, Tobin's and Wren's never; Ana is played, never picked.
  assert.strictEqual(planReply(cast, user, ana, null, "Hello.").replier, mira)
  assert.strictEqual(planReply(cast, user, ana, null, null).replier, mira)
  // Naming someone in the text being sent makes them reply, a silent one too.
  assert.strictEqual(planReply(cast, user, ana, null, "Wren, what do you see?").replier, wren)
  assert.strictEqual(planReply(cast, user, ana, null, "ask tobin").replier, tobin)
  // A pick still wins.
  assert.strictEqual(planReply(cast, user, ana, tobin, "Wren?").replier, tobin)
  // Nothing typed after Mira's turn: she doesn't answer herself, so one of the silent two does,
  // the same one each time for the same tip.
  const afterMira = [...user, turn("v2", mira, "Mira looks at the door.")]
  const once = planReply(cast, afterMira, ana, null, null).replier
  assert.include([tobin, wren], once)
  for (let i = 0; i < 5; i++) assert.strictEqual(planReply(cast, afterMira, ana, null, "  ").replier, once)
  // With nothing typed, the tip's own text names who answers.
  assert.strictEqual(planReply(cast, [...user, turn("v3", mira, "Tobin, the door.")], ana, null, null).replier, tobin)
  // Typed text is user input: the last speaker isn't banned.
  assert.strictEqual(planReply(cast, afterMira, ana, null, "And then?").replier, mira)
  // Muted (absent) cards and the composer's own speaker are never Auto's pick.
  const muted = castOf([mira, tobin, wren, ana], cards, { playedByMe: [ana], absent: [mira] })
  assert.notStrictEqual(planReply(muted, user, ana, null, "Mira?").replier, mira)
  assert.notStrictEqual(planReply(cast, user, mira, null, null).replier, mira)
  // Alone, the last speaker answers themselves.
  const solo = castOf([mira, ana], cards, { playedByMe: [ana] })
  assert.strictEqual(planReply(solo, afterMira, ana, null, null).replier, mira)
})

it("the pick follows the tip: the same for the same tip, varying as the chat moves on", () => {
  const ids = ["synthetic-a", "synthetic-b", "synthetic-c", "synthetic-d"] as Array<EntityId>
  const cast = castOf(
    ids,
    ids.map((id, i) => card(id, `Name${i}`, 0.5))
  )
  const picks = new Set<EntityId | null>()
  for (let i = 0; i < 40; i++) {
    const path = [turn(`synthetic-version-${i}`, null)]
    const first = planReply(cast, path, null, null, null).replier
    assert.strictEqual(planReply(cast, path, null, null, "typed").replier, first)
    picks.add(first)
  }
  assert.isAbove(picks.size, 1)
})

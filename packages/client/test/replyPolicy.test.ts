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
    assert.deepStrictEqual(nextInTurn(cast, [], null), { id: a, after: null, then: [] })
    assert.deepStrictEqual(planReply(cast, [], null, null), {
      next: { id: a, after: null, then: [] },
      replier: a,
      auto: true,
      round: [],
      reply: true
    })
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
        assert.deepStrictEqual(planReply(cast, [], null, null), {
          next: { id: b, after: a },
          replier: b,
          auto: true,
          round: [],
          reply: true
        })
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.acquireRelease(
              Effect.sync(() => replyPolicies.disable(AUTO_POLICY)),
              (undo) => Effect.sync(undo)
            )
            assert.isNull(nextInTurn(cast, [], null))
            assert.deepStrictEqual(planReply(cast, [], null, null), {
              next: null,
              replier: null,
              auto: false,
              round: [],
              reply: false
            })
            assert.deepStrictEqual(planReply(cast, [], null, b), {
              next: null,
              replier: b,
              auto: false,
              round: [],
              reply: true
            })
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
  assert.strictEqual(planReply(cast, afterMira, ana, null, "", true).replier, mira)
  // Muted (absent) cards and the composer's own speaker are never Auto's pick.
  const muted = castOf([mira, tobin, wren, ana], cards, { playedByMe: [ana], absent: [mira] })
  assert.notStrictEqual(planReply(muted, user, ana, null, "Mira?").replier, mira)
  assert.notStrictEqual(planReply(cast, user, mira, null, null).replier, mira)
  // Nor are away cards (spec/CHARACTER-CONTEXT.md §5), named or not.
  const away = castOf([mira, tobin, wren, ana], cards, { playedByMe: [ana], away: [mira] })
  assert.notStrictEqual(planReply(away, user, ana, null, "Mira?").replier, mira)
  for (let i = 0; i < 20; i++)
    assert.notStrictEqual(planReply(away, [...user, turn(`a${i}`, tobin)], ana, null, null).replier, mira)
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

it("follows the chat's reply order: list, pooled and manual, as ST's group strategies", () => {
  const [mira, tobin, wren, ana] = ["synthetic-mira", "synthetic-tobin", "synthetic-wren", "synthetic-ana"] as [
    EntityId,
    EntityId,
    EntityId,
    EntityId
  ]
  const cards = [card(mira, "Mira", 1), card(tobin, "Tobin", 1), card(wren, "Wren", 1), card(ana, "Ana", 1)]
  const order = (replyOrder: string, more: Partial<Cast> = {}) =>
    castOf([mira, tobin, wren, ana], cards, { playedByMe: [ana], replyOrder, ...more })
  const user = [turn("v1", ana, "Hello.")]
  // List order, one at a time: the first in the cast's order after your message, then the next each time.
  const list = order("list", { replySingle: true })
  assert.strictEqual(planReply(list, user, ana, null, null).replier, mira)
  assert.strictEqual(planReply(list, [...user, turn("v2", mira)], ana, null, null).replier, tobin)
  assert.strictEqual(planReply(list, [...user, turn("v2", mira), turn("v3", tobin)], ana, null, null).replier, wren)
  assert.strictEqual(
    planReply(list, [...user, turn("v2", mira), turn("v3", tobin), turn("v4", wren)], ana, null, null).replier,
    mira
  )
  // Sending a message starts the list again, whoever spoke last; a muted card is skipped.
  assert.strictEqual(planReply(list, [...user, turn("v2", mira)], ana, null, "And you?").replier, mira)
  assert.strictEqual(
    planReply(order("list", { absent: [tobin], replySingle: true }), [...user, turn("v2", mira)], ana, null, null)
      .replier,
    wren
  )
  // Pooled: someone who hasn't spoken since your message; once all have, not the last.
  const pooled = order("pooled")
  assert.strictEqual(planReply(pooled, [...user, turn("v2", mira), turn("v3", tobin)], ana, null, null).replier, wren)
  for (let i = 0; i < 20; i++) {
    const all = [...user, turn("v2", mira), turn("v3", tobin), turn(`v4-${i}`, wren)]
    assert.notStrictEqual(planReply(pooled, all, ana, null, null).replier, wren)
  }
  // Manual: nobody replies to what you send unless picked; an empty Send picks one of them.
  const manual = order("manual")
  assert.deepStrictEqual(planReply(manual, user, ana, null, "Hello?"), {
    next: null,
    replier: null,
    auto: false,
    round: [],
    reply: false
  })
  assert.deepStrictEqual(planReply(manual, user, ana, null, "", true), {
    next: null,
    replier: null,
    auto: false,
    round: [],
    reply: false
  })
  assert.strictEqual(planReply(manual, user, ana, tobin, "", true).replier, tobin)
  // An image-only user turn starts a new list/pooled round, too.
  const afterMira = [...user, turn("v2", mira)]
  assert.strictEqual(planReply(list, afterMira, ana, null, "", true).replier, mira)
  const imagePicks = new Set(
    Array.from(
      { length: 30 },
      (_, i) => planReply(pooled, [...user, turn(`v-${i}`, mira)], ana, null, "", true).replier
    )
  )
  assert.include([...imagePicks], mira)
  assert.strictEqual(planReply(manual, user, ana, tobin, "Hello?").replier, tobin)
  assert.include([mira, tobin, wren], planReply(manual, user, ana, null, null).replier)
  // An order no policy has is the default, natural order.
  assert.strictEqual(planReply(order("synthetic-unknown"), user, ana, null, "Wren?").replier, wren)
  // Each of ST's four is offered with its name and what it means.
  for (const id of ["natural", "list", "pooled", "manual"]) {
    const policy = replyPolicies.get(id)!
    assert.isString(policy.label)
    assert.isString(policy.description)
    assert.isString(policy.autoDetail)
  }
})

it("plans ST's whole round per reply order, and one reply with the switch on or a pick", () => {
  const [mira, tobin, wren, ana] = ["synthetic-mira", "synthetic-tobin", "synthetic-wren", "synthetic-ana"] as [
    EntityId,
    EntityId,
    EntityId,
    EntityId
  ]
  const cards = [card(mira, "Mira", 1), card(tobin, "Tobin", 0), card(wren, "Wren", 1), card(ana, "Ana", 1)]
  const order = (replyOrder: string, more: Partial<Cast> = {}) =>
    castOf([mira, tobin, wren, ana], cards, { playedByMe: [ana], replyOrder, ...more })
  const user = [turn("v1", ana, "Hello.")]
  const whole = (cast: Cast, path: ReadonlyArray<PathEntry>, input: string | null, picked: EntityId | null = null) => {
    const plan = planReply(cast, path, ana, picked, input)
    return plan.replier === null ? [] : [plan.replier, ...plan.round]
  }
  // Natural (ST's activateNaturalOrder): those named, in the order named, then everyone whose roll
  // passes, in a shuffled order, without repeats; talkativeness 0 never passes.
  const natural = order("natural")
  assert.sameMembers(whole(natural, user, "Hello."), [mira, wren])
  const named = whole(natural, user, "Tobin, and Wren?")
  assert.deepStrictEqual(named.slice(0, 2), [tobin, wren])
  assert.sameMembers(named, [tobin, wren, mira])
  // An empty send reads the tip's text, and the last character to speak doesn't answer themselves.
  assert.deepStrictEqual(whole(natural, [...user, turn("v2", mira, "Quiet.")], null), [wren])
  // The same tip and text plan the same round every time (the preview, Send, a reload agree).
  const again = whole(natural, user, "Hello.")
  for (let i = 0; i < 5; i++) assert.deepStrictEqual(whole(natural, user, "Hello."), again)
  // List (ST's activateListOrder): everyone in the cast's order, after a message or an empty send,
  // the last speaker too; muted cards are left out.
  assert.deepStrictEqual(whole(order("list"), user, "Hi."), [mira, tobin, wren])
  assert.deepStrictEqual(whole(order("list"), [...user, turn("v2", wren)], null), [mira, tobin, wren])
  assert.deepStrictEqual(whole(order("list", { absent: [tobin] }), user, "Hi."), [mira, wren])
  // Pooled (ST's activatePooledOrder) is one reply; manual is none to a message, one to an empty send.
  assert.lengthOf(whole(order("pooled"), user, "Hi."), 1)
  assert.deepStrictEqual(whole(order("manual"), user, "Hi."), [])
  assert.lengthOf(whole(order("manual"), user, null), 1)
  // One reply at a time (the Cast tab's switch): the round's first only.
  assert.deepStrictEqual(whole(order("natural", { replySingle: true }), user, "Tobin, and Wren?"), [tobin])
  assert.deepStrictEqual(whole(order("list", { replySingle: true }), user, "Hi."), [mira])
  // A pick under Next is one reply, as ST's force talk.
  assert.deepStrictEqual(whole(natural, user, "Hello.", tobin), [tobin])
})

it("No one under Next: no reply to what you send, Auto's one reply when asked, a pick still replies", () => {
  const [mira, tobin, wren, ana] = ["synthetic-mira", "synthetic-tobin", "synthetic-wren", "synthetic-ana"] as [
    EntityId,
    EntityId,
    EntityId,
    EntityId
  ]
  const cards = [card(mira, "Mira", 1), card(tobin, "Tobin", 1), card(wren, "Wren", 1), card(ana, "Ana", 1)]
  const user = [turn("v1", ana, "Hello.")]
  for (const replyOrder of ["natural", "list", "pooled", "manual"]) {
    const cast = castOf([mira, tobin, wren, ana], cards, { playedByMe: [ana], replyOrder })
    // A message or an image sent: no reply and no round, whoever is named.
    for (const [input, images] of [
      ["Mira, what now?", false],
      ["", true]
    ] as const) {
      const sent = planReply(cast, user, ana, null, input, images, true)
      assert.strictEqual(sent.replier, null, replyOrder)
      assert.deepStrictEqual(sent.round, [], replyOrder)
      assert.isFalse(sent.reply, replyOrder)
    }
    // An empty Send asks: Auto's pick, one reply.
    const asked = planReply(cast, user, ana, null, null, false, true)
    assert.strictEqual(asked.replier, planReply(cast, user, ana, null, null).replier, replyOrder)
    assert.deepStrictEqual(asked.round, [], replyOrder)
    // A pick under Next replies to the message, one reply.
    assert.deepStrictEqual(planReply(cast, user, ana, wren, "Hi.", false, true), {
      next: planReply(cast, user, ana, null, "Hi.").next,
      replier: wren,
      auto: false,
      round: [],
      reply: true
    })
  }
  // With one character, and with none: a message still gets no reply.
  assert.isFalse(
    planReply(castOf([mira, ana], cards, { playedByMe: [ana] }), user, ana, null, "Hi.", false, true).reply
  )
  assert.isFalse(planReply(null, [], null, null, "Hi.", false, true).reply)
})

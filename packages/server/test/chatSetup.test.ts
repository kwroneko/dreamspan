// Starting chats from cards, who's in them, and their settings (DESIGN §2.1, §2.2, §3.5):
// a card's greeting shows without a chat, the chat is made on the first turn with every
// greeting as a version of its first message, and changes to the cast are state events
// at a position. Cross-user access is in the isolation matrix.
import { assert, describe, it } from "@effect/vitest"
import type { Chat, EntityId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { Effect } from "effect"
import { Generator } from "../src/chat/Generator.ts"
import { freezeTemplate } from "../src/chat/macros.ts"
import { Writer } from "../src/db/Database.ts"
import * as FakeGenerator from "../src/dev/fakeGenerator.ts"
import { client, outcome, posted, serverLayer, testConfig } from "./support/config.ts"

type Api = Effect.Success<ReturnType<typeof client>>

const slow = FakeGenerator.layer({ tokensPerSecond: 20, tokens: 2000 })

/** A card of the caller's, made as an import would, optionally in the persona folder. */
const card = (api: Api, label: string, doc: Record<string, unknown>, persona = false) =>
  Effect.gen(function* () {
    const writer = yield* Writer
    const me = yield* api.Whoami()
    const { entityId } = yield* writer.CreateEntity({
      userId: me.id as UserId,
      kind: "card",
      label,
      subtitle: "",
      doc,
      schemaVersion: 1,
      origin: "user",
      sourcePath: null
    })
    if (persona) yield* writer.SetEntityTags({ userId: me.id as UserId, entityId, tags: ["persona"] })
    return entityId
  })

const mira = { name: "Mira", first_mes: "The bell rings for {{user}}.", alternate_greetings: ["", "Mira waves."] }

const pathOf = (api: Api, chatId: Chat["id"]) =>
  Effect.map(
    api.ReadPath({ chatId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 50 }),
    (window) => window.entries
  )

describe("chat setup", () => {
  it.live("a card's greetings show without a chat; the first send makes it, greetings as versions", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const miraId = yield* card(api, "Mira (harbor)", mira)
      const anaId = yield* card(api, "Ana", { name: "Ana", description: "A cartographer." }, true)

      const shown = yield* api.GetCardForChat({ entityId: miraId })
      assert.deepStrictEqual(shown.greetings, ["The bell rings for {{user}}.", "Mira waves."])
      assert.strictEqual(shown.card.name, "Mira")
      assert.strictEqual(shown.card.label, "Mira (harbor)")
      // Opening a card makes no chat (DESIGN §2.1).
      assert.lengthOf(yield* api.ListChats({ limit: 10, before: null }), 0)

      const started = yield* api.StartChat({
        cards: [miraId],
        persona: anaId,
        greeting: 1,
        first: { _tag: "Send", content: "Hello.", speakerEntityId: anaId }
      })
      assert.strictEqual(started.chat.title, "Mira & Ana")
      assert.strictEqual(started.entry.version.speakerEntityId, anaId)
      const [greeting, message] = yield* pathOf(api, started.chat.id)
      assert.strictEqual(message!.slotId, started.entry.slotId)
      assert.strictEqual(greeting!.versionCount, 2)
      // Macros stay unresolved, for display and assembly to resolve (DESIGN §5.6).
      assert.strictEqual(greeting!.version.content, "Mira waves.")
      assert.strictEqual(greeting!.version.origin, "greeting")
      assert.strictEqual(greeting!.version.macroMode, "template")
      assert.strictEqual(greeting!.version.speakerEntityId, miraId)
      const versions = yield* api.ListVersions({ slotId: greeting!.slotId })
      assert.deepStrictEqual(
        versions.map((v) => v.content),
        ["The bell rings for {{user}}.", "Mira waves."]
      )

      const cast = yield* api.GetCast({ chatId: started.chat.id, slotId: null })
      assert.deepStrictEqual(cast.participants, [miraId, anaId])
      assert.deepStrictEqual(cast.playedByMe, [anaId])
      assert.deepStrictEqual(
        cast.cards.map((c) => [c.name, c.persona]),
        [
          ["Ana", true],
          ["Mira", false]
        ]
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )

  it.live("a greeting's random and time macros are frozen when the chat is made, sent or not", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const dated = yield* card(api, "Dated", {
        name: "Dated",
        first_mes: "The log says {{datetimeformat::YYYY-MM-DD}}.",
        alternate_greetings: [Array.from({ length: 300 }, () => "{{time}}").join(" ")]
      })
      // What a preview drew on another day, for the first greeting only.
      const seen = freezeTemplate("The log says {{datetimeformat::YYYY-MM-DD}}.", {}, {})
      const preview = Object.fromEntries(Object.keys(seen).map((key) => [key, "1999-12-31"]))
      const started = yield* api.StartChat({
        cards: [dated],
        persona: null,
        greeting: 1,
        first: { _tag: "Send", content: "Hi.", speakerEntityId: null },
        frozen: [preview]
      })
      const [greeting] = yield* pathOf(api, started.chat.id)
      const versions = yield* api.ListVersions({ slotId: greeting!.slotId })
      // The preview's value is kept; the greeting the client sent nothing for is frozen too,
      // with all 300 of its values, more than any fixed small cap would take.
      assert.deepStrictEqual(versions[0]!.frozenMacros, preview)
      assert.lengthOf(Object.keys(versions[1]!.frozenMacros ?? {}), 300)
      // Without any frozen values sent, the server still draws them.
      const bare = yield* api.StartChat({
        cards: [dated],
        persona: null,
        greeting: null,
        first: { _tag: "Send", content: "Hi.", speakerEntityId: null }
      })
      const [bareGreeting] = yield* pathOf(api, bare.chat.id)
      assert.lengthOf(Object.keys(bareGreeting!.version.frozenMacros ?? {}), 1)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )

  it.live("a chat can start with a reply, as a card, with a one-turn direction", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const miraId = yield* card(api, "Mira", mira)
      const started = yield* api.StartChat({
        cards: [miraId],
        persona: null,
        greeting: null,
        first: { _tag: "Generate", speakerEntityId: miraId, direction: "Describe the harbor." }
      })
      assert.strictEqual(started.entry.version.status, "generating")
      assert.strictEqual(started.entry.version.direction, "Describe the harbor.")
      assert.strictEqual(started.entry.version.speakerEntityId, miraId)
      assert.match(started.chat.title, /^Mira, /)
      yield* api.StopGeneration({ versionId: started.entry.version.id })
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), slow)))
  )

  it.live("a queued send is answered by the speaker picked when it was sent, not the reply it waited for", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const miraId = yield* card(api, "Mira", mira)
      const anaId = yield* card(api, "Ana", { name: "Ana" }, true)
      // The user has the model write their own turn (impersonation), and replies meanwhile.
      const started = yield* api.StartChat({
        cards: [miraId],
        persona: anaId,
        greeting: null,
        first: { _tag: "Generate", speakerEntityId: anaId, direction: "" }
      })
      const queued = yield* api.SendMessage({
        chatId: started.chat.id,
        parentSlotId: started.entry.slotId,
        branch: false,
        content: "Now answer me.",
        speakerEntityId: anaId,
        replySpeakerEntityId: miraId
      })
      assert.strictEqual(queued._tag, "Queued")
      yield* api.StopGeneration({ versionId: started.entry.version.id })
      let entries = yield* pathOf(api, started.chat.id)
      while (entries.length < 4) {
        yield* Effect.sleep(20)
        entries = yield* pathOf(api, started.chat.id)
      }
      assert.deepStrictEqual(
        entries.map((e) => e.version.speakerEntityId),
        [miraId, anaId, anaId, miraId]
      )
      yield* api.StopGeneration({ versionId: entries[3]!.version.id })
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), slow)))
  )

  it.live("without a generator, a chat starting with a reply isn't made at all", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const miraId = yield* card(api, "Mira", mira)
      assert.strictEqual(
        yield* outcome(
          api.StartChat({
            cards: [miraId],
            persona: null,
            greeting: null,
            first: { _tag: "Generate", speakerEntityId: miraId, direction: "" }
          })
        ),
        "GenerationUnavailable"
      )
      assert.lengthOf(yield* api.ListChats({ limit: 10, before: null }), 0)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )

  it.live("a card without greetings starts with the first message", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const quiet = yield* card(api, "Quiet", { name: "Quiet" })
      const started = yield* api.StartChat({
        cards: [quiet],
        persona: null,
        greeting: 0,
        first: { _tag: "Send", content: "Anyone?", speakerEntityId: null }
      })
      assert.isNull(started.entry.parentSlotId)
      assert.lengthOf(yield* pathOf(api, started.chat.id), 1)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )

  it.live("the cast changes from a position on: join, presence, leave, played by me, settings", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const miraId = yield* card(api, "Mira", mira)
      const tobin = yield* card(api, "Tobin", { name: "Tobin" })
      const started = yield* api.StartChat({
        cards: [miraId],
        persona: null,
        greeting: 0,
        first: { _tag: "Send", content: "Hello.", speakerEntityId: null }
      })
      const at = started.entry.slotId
      const change = (c: Parameters<Api["ChangeCast"]>[0]["change"]) =>
        api.ChangeCast({ chatId: started.chat.id, slotId: at, change: c })
      yield* change({ _tag: "Join", entityId: tobin })
      yield* change({ _tag: "Presence", entityId: miraId, present: false })
      yield* change({ _tag: "PlayedByMe", entityIds: [tobin] })
      yield* change({ _tag: "Layout", layout: "swap_tail" })
      const after = yield* change({ _tag: "Roles", projection: "alternate" })
      assert.deepStrictEqual(after.participants, [miraId, tobin])
      assert.deepStrictEqual(after.absent, [miraId])
      assert.deepStrictEqual(after.playedByMe, [tobin])
      assert.strictEqual(after.layoutCards, "swap_tail")
      assert.strictEqual(after.rolesProjection, "alternate")
      // From that message on: before it, nothing changed.
      const before = yield* api.GetCast({ chatId: started.chat.id, slotId: null })
      assert.deepStrictEqual(before.participants, [miraId])
      assert.isNull(before.layoutCards)
      const left = yield* change({ _tag: "Leave", entityId: tobin })
      assert.deepStrictEqual(left.participants, [miraId])

      // Send as a card: the message is theirs.
      const sent = yield* posted(
        api.SendMessage({
          chatId: started.chat.id,
          parentSlotId: at,
          branch: false,
          content: "As Tobin.",
          speakerEntityId: tobin
        })
      )
      assert.strictEqual(sent.entry.version.speakerEntityId, tobin)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )

  it.live("cards in the bin aren't offered, and can't start a chat or speak", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const writer = yield* Writer
      const me = yield* api.Whoami()
      const miraId = yield* card(api, "Mira", mira)
      const gone = yield* card(api, "Gone", { name: "Gone" })
      yield* writer.DeleteEntity({ userId: me.id as UserId, entityId: gone })
      assert.deepStrictEqual(
        (yield* api.ListCards()).map((c) => c.name),
        ["Mira"]
      )
      assert.strictEqual(yield* outcome(api.GetCardForChat({ entityId: gone as EntityId })), "NotFound")
      const send = { _tag: "Send" as const, content: "Hi.", speakerEntityId: null }
      assert.strictEqual(
        yield* outcome(api.StartChat({ cards: [gone], persona: null, greeting: null, first: send })),
        "NotFound"
      )
      assert.strictEqual(
        yield* outcome(
          api.StartChat({ cards: [miraId], persona: null, greeting: null, first: { ...send, speakerEntityId: gone } })
        ),
        "NotFound"
      )
      // Nothing half-made was left behind.
      assert.lengthOf(yield* api.ListChats({ limit: 10, before: null }), 0)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )
})

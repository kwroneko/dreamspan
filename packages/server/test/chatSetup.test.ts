// Starting chats from cards, who's in them, and their settings (DESIGN §2.1, §2.2, §3.5):
// a card's greeting shows without a chat, the chat is made on the first turn with every
// greeting as a version of its first message, and changes to the cast are state events
// at a position. Cross-user access is in the isolation matrix.
import { assert, describe, it } from "@effect/vitest"
import type { Chat, EntityId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { DraftHistoryPolicy } from "@rp/shared/drafts.ts"
import { greetingSources } from "@rp/shared/greetings.ts"
import { Effect } from "effect"
import { foldState } from "@rp/shared/state.ts"
import { Generator } from "../src/chat/Generator.ts"
import { freezeTemplate } from "../src/chat/macros.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import * as FakeGenerator from "../src/dev/fakeGenerator.ts"
import { client, outcome, posted, serverLayer, testConfig } from "./support/config.ts"
import type { CardDoc } from "@rp/shared/docs/card.ts"
import { cardDoc } from "./support/docs.ts"
import { slowIt } from "./support/slow.ts"

type Api = Effect.Success<ReturnType<typeof client>>

const slow = FakeGenerator.layer({ tokensPerSecond: 20, tokens: 2000 })

/** A card of the caller's, made as an import would, optionally in the persona folder. */
const card = (api: Api, label: string, doc: Partial<CardDoc>, persona = false) =>
  Effect.gen(function* () {
    const writer = yield* Writer
    const me = yield* api.Whoami()
    const { entityId } = yield* writer.CreateEntity({
      userId: me.id as UserId,
      kind: "card",
      label,
      subtitle: "",
      doc: cardDoc(label, doc),
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
  for (const dbWorkers of ["source", "bundle"] as const) {
    it.live(`greeting source overrides, disablement and restoration reach ${dbWorkers} storage`, () =>
      Effect.gen(function* () {
        const api = yield* client()
        const miraId = yield* card(api, "Mira", {
          ...mira,
          group_only_greetings: ["Together at {{time}}."]
        })
        const tobin = yield* card(api, "Tobin", { first_mes: "Tobin nods." })
        const start = (greeting = 2) =>
          api
            .StartChat({
              cards: [miraId, tobin],
              persona: null,
              greeting,
              greeters: [{ entityId: miraId, greeting }],
              first: { _tag: "Send", content: "Hello", speakerEntityId: null }
            })
            .pipe(
              Effect.flatMap(({ chat }) => pathOf(api, chat.id)),
              Effect.map((path) => path[0]!)
            )
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* greetingSources.disable("greetings.group-only")
            const greeting = yield* start()
            assert.strictEqual(greeting.version.content, mira.first_mes)
            assert.strictEqual(greeting.versionCount, 2)
          })
        )
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* greetingSources.disable("greetings.ordinary")
            const group = greetingSources.get("greetings.group-only")!
            yield* greetingSources.register({
              ...group,
              offer: (card, count) =>
                group.offer(card, count).map((option) => ({ ...option, text: `Custom ${option.text}` }))
            })
            const greeting = yield* start()
            assert.strictEqual(greeting.version.content, "Custom Together at {{time}}.")
            assert.strictEqual(greeting.versionCount, 1)
            assert.ok(greeting.version.frozenMacros)
          })
        )
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* greetingSources.register({
              id: "synthetic/greeting",
              offer: () => [{ index: 99, text: "Plugin at {{time}}.", groupOnly: false }]
            })
            const greeting = yield* start(99)
            assert.strictEqual(greeting.version.content, "Plugin at {{time}}.")
            assert.strictEqual(greeting.versionCount, 4)
            assert.ok(greeting.version.frozenMacros)
          })
        )
        const restored = yield* start()
        assert.strictEqual(restored.version.content, "Together at {{time}}.")
        assert.strictEqual(restored.versionCount, 3)
      }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig({ dbWorkers }), Generator.none)))
    )
  }

  it.live("group-only greetings are saved in groups and fall back with only one character, excluding persona", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const miraId = yield* card(api, "Mira", {
        ...mira,
        group_only_greetings: ["", "Mira greets the crew at {{time}}."]
      })
      const tobin = yield* card(api, "Tobin", { first_mes: "Tobin nods." })
      const ana = yield* card(api, "Ana", {}, true)
      const preview = yield* api.GetCardForChat({ entityId: miraId })
      assert.deepStrictEqual(preview.groupGreetings, ["Mira greets the crew at {{time}}."])
      const frozen = freezeTemplate("Mira greets the crew at {{time}}.", {}, { user: "Ana", char: "Mira" }, {})
      assert.ok(frozen)
      const start = (cards: ReadonlyArray<EntityId>) =>
        api.StartChat({
          cards,
          persona: ana,
          greeting: 2,
          greeters: [{ entityId: miraId, greeting: 2, frozen }],
          first: { _tag: "Send", content: "Hello", speakerEntityId: ana }
        })
      const group = yield* start([miraId, tobin])
      const [groupGreeting] = yield* pathOf(api, group.chat.id)
      assert.strictEqual(groupGreeting!.version.content, "Mira greets the crew at {{time}}.")
      assert.strictEqual(groupGreeting!.versionCount, 3)
      assert.deepStrictEqual(groupGreeting!.version.frozenMacros, frozen)
      const single = yield* start([miraId])
      const [singleGreeting] = yield* pathOf(api, single.chat.id)
      assert.strictEqual(singleGreeting!.version.content, mira.first_mes)
      assert.strictEqual(singleGreeting!.versionCount, 2)
      const duplicate = yield* start([miraId, miraId])
      assert.strictEqual((yield* pathOf(api, duplicate.chat.id))[0]!.version.content, mira.first_mes)
      const personaInCards = yield* start([miraId, ana])
      assert.strictEqual((yield* pathOf(api, personaInCards.chat.id))[0]!.version.content, mira.first_mes)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )

  it.live("reads, pins and unpins stable prompt names on their own fork", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const miraId = yield* card(api, "Mira", { ...mira, nickname: "Pilot" })
      const anaId = yield* card(api, "Ana", { name: "Ana" }, true)
      const started = yield* api.StartChat({
        cards: [miraId],
        persona: anaId,
        greeting: 0,
        first: { _tag: "Send", content: "Hi", speakerEntityId: anaId }
      })
      const at = { chatId: started.chat.id, slotId: started.entry.slotId }
      assert.deepStrictEqual((yield* api.GetCast(at)).macroNames, { user: "Ana", char: "Pilot" })
      const pin = (name: "user" | "char", value: string | null) =>
        api.ChangeCast({ ...at, change: { _tag: "MacroBinding", name, value } })
      yield* pin("user", "Captain")
      yield* pin("char", "Narrator")
      const main = (yield* api.GetChat({ chatId: at.chatId })).currentForkId
      const fork = yield* api.CreateFork({ chatId: at.chatId, fromForkId: main, atSlotId: at.slotId })
      const changed = yield* api.ChangeCast({
        ...at,
        forkId: fork.fork.id,
        change: { _tag: "MacroBinding", name: "user", value: null }
      })
      assert.deepStrictEqual(changed.macroNames, { user: "Ana", char: "Narrator" })
      assert.deepStrictEqual((yield* api.GetCast({ ...at, forkId: main })).macroNames, {
        user: "Captain",
        char: "Narrator"
      })
      yield* pin("char", "")
      assert.strictEqual((yield* api.GetCast(at)).macroNames.char, "")
      yield* pin("char", null)
      assert.deepStrictEqual((yield* api.GetCast(at)).macroNames, { user: "Ana", char: "Pilot" })
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )

  it.live("a card's greetings show without a chat; the first send makes it, greetings as versions", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const miraId = yield* card(api, "Mira (harbor)", mira)
      const anaId = yield* card(api, "Ana", { name: "Ana", description: "A cartographer." }, true)

      const shown = yield* api.GetCardForChat({ entityId: miraId })
      assert.deepStrictEqual(shown.greetings, ["The bell rings for {{user}}.", "Mira waves."])
      assert.strictEqual(shown.card.name, "Mira")
      assert.strictEqual(shown.card.label, "Mira")
      // Opening a card makes no chat (DESIGN §2.1).
      assert.lengthOf(yield* api.ListChats({ limit: 10, before: null }), 0)

      const started = yield* api.StartChat({
        cards: [miraId],
        persona: anaId,
        greeting: 1,
        first: { _tag: "Send", content: "Hello.", speakerEntityId: anaId }
      })
      assert.strictEqual(started.chat.title, "Mira & Ana")
      const me = yield* api.Whoami()
      const initial = foldState(
        yield* (yield* Reader).StateEventsAt({ userId: me.id, chatId: started.chat.id, slotId: null })
      )
      assert.strictEqual(initial.lcm?.enabled, true)
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
      yield* api.ChangeCast({
        chatId: started.chat.id,
        slotId: null,
        change: { _tag: "PlayedByMe", entityIds: [miraId, anaId] }
      })
      const selected = yield* api.GetCast({ chatId: started.chat.id, slotId: null })
      assert.deepStrictEqual(selected.playedByMe, [anaId])
      assert.strictEqual(selected.macroNames.user, "Ana")
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
      const names = { user: "User", char: "Dated" }
      const dated = yield* card(api, "Dated", {
        name: "Dated",
        // Its date format names the card: the frozen date mustn't depend on the name.
        first_mes: "The log of {{char}} says {{datetimeformat::[{{char}}] YYYY-MM-DD}}.",
        alternate_greetings: [Array.from({ length: 300 }, () => "{{time}}").join(" ")]
      })
      const text = "The log of {{char}} says {{datetimeformat::[{{char}}] YYYY-MM-DD}}."
      // What the preview read: a clock on another day.
      const seen = freezeTemplate(text, {}, names, {})!
      const preview = Object.fromEntries(Object.keys(seen).map((key) => [key, String(Date.UTC(1999, 11, 31, 12))]))
      const started = yield* api.StartChat({
        cards: [dated],
        persona: null,
        greeting: 0,
        first: { _tag: "Send", content: "Hi.", speakerEntityId: null },
        frozen: preview
      })
      const [greeting] = yield* pathOf(api, started.chat.id)
      const versions = yield* api.ListVersions({ slotId: greeting!.slotId })
      // The preview's clock is kept, and the greeting the client sent nothing for is frozen
      // too: all 300 of its values.
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

  it.live("frozen values the macros couldn't have drawn are drawn again", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const names = { user: "User", char: "Odd" }
      const text = "{{random::{{char}}::safe}} {{roll::1d6}} {{isodate}}"
      const odd = yield* card(api, "Odd", { name: "Odd", first_mes: text })
      const keys = Object.keys(freezeTemplate(text, {}, names, {})!)
      assert.lengthOf(keys, 3)
      // A choice the arguments allow (the card's name) is kept.
      const kept = yield* api.StartChat({
        cards: [odd],
        persona: null,
        greeting: 0,
        first: { _tag: "Send", content: "Hi.", speakerEntityId: null },
        frozen: { [keys[0]!]: "Odd", [keys[1]!]: "4", [keys[2]!]: String(Date.UTC(2020, 0, 1)) }
      })
      const [good] = yield* pathOf(api, kept.chat.id)
      assert.deepStrictEqual(Object.values(good!.version.frozenMacros ?? {}), [
        "Odd",
        "4",
        String(Date.UTC(2020, 0, 1))
      ])
      // Values outside the choices, the dice or sane dates are not.
      const forged = yield* api.StartChat({
        cards: [odd],
        persona: null,
        greeting: 0,
        first: { _tag: "Send", content: "Hi.", speakerEntityId: null },
        frozen: { [keys[0]!]: "FORGED", [keys[1]!]: "7", [keys[2]!]: "99999999999999" }
      })
      const [bad] = yield* pathOf(api, forged.chat.id)
      const [choice, roll, clock] = Object.values(bad!.version.frozenMacros ?? {})
      assert.include(["Odd", "safe"], choice)
      assert.include(["1", "2", "3", "4", "5", "6"], roll)
      assert.isBelow(Math.abs(Number(clock) - Date.now()), 60_000)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )

  it.live("a greeting whose single draw is huge, and a card with 1,001 greetings, both start", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const huge = yield* card(api, "Huge", { name: "Huge", first_mes: "{{random::x{{space::262145}}x}}" })
      const preview = freezeTemplate("{{random::x{{space::262145}}x}}", {}, { user: "User", char: "Huge" }, {})!
      assert.strictEqual(Object.values(preview)[0]!.length, 262_147)
      const send = { _tag: "Send" as const, content: "Hi.", speakerEntityId: null }
      assert.strictEqual(
        yield* outcome(api.StartChat({ cards: [huge], persona: null, greeting: 0, first: send, frozen: preview })),
        "ok"
      )
      assert.strictEqual(
        yield* outcome(api.StartChat({ cards: [huge], persona: null, greeting: 0, first: send })),
        "ok"
      )
      const many = yield* card(api, "Many", {
        name: "Many",
        first_mes: "Welcome {{time}}",
        alternate_greetings: Array.from({ length: 1000 }, (_, i) => `Alternate ${i} {{time}}`)
      })
      const started = yield* api.StartChat({ cards: [many], persona: null, greeting: 1000, first: send })
      const [greeting] = yield* pathOf(api, started.chat.id)
      assert.strictEqual(greeting!.versionCount, 1001)
      assert.strictEqual(greeting!.version.content, "Alternate 999 {{time}}")
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
      yield* change({ _tag: "LoreBelowHistory", on: false })
      const after = yield* change({ _tag: "Roles", projection: "alternate" })
      assert.deepStrictEqual(after.participants, [miraId, tobin])
      assert.deepStrictEqual(after.absent, [miraId])
      assert.deepStrictEqual(after.playedByMe, [tobin])
      assert.isFalse(after.loreBelowHistory)
      assert.strictEqual(after.rolesProjection, "alternate")
      // From that message on: before it, nothing changed.
      const before = yield* api.GetCast({ chatId: started.chat.id, slotId: null })
      assert.deepStrictEqual(before.participants, [miraId])
      assert.isTrue(before.loreBelowHistory)
      const left = yield* change({ _tag: "Leave", entityId: tobin })
      assert.deepStrictEqual(left.participants, [miraId])
      assert.include(
        left.cards.map((card) => card.entityId),
        tobin
      )

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

  it.live("a persona switch is one write: the card joins, becomes the persona, the old persona card leaves", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const miraId = yield* card(api, "Mira", mira)
      const ana = yield* card(api, "Ana", { name: "Ana" }, true)
      const bo = yield* card(api, "Bo", { name: "Bo" }, true)
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
      const reader = yield* Reader
      const me = yield* api.Whoami()
      const events = () => reader.StateEventsAt({ userId: me.id as UserId, chatId: started.chat.id, slotId: at })
      // A persona-folder card in the chat and played, as speaking as one used to make it.
      yield* change({ _tag: "Join", entityId: ana })
      yield* change({ _tag: "PlayedByMe", entityIds: [ana] })
      const count = (yield* events()).length

      const switched = yield* change({ _tag: "Persona", entityId: bo })
      assert.deepStrictEqual(switched.playedByMe, [bo])
      assert.deepStrictEqual(switched.participants, [miraId, bo])
      assert.include(
        switched.cards.map((card) => card.entityId),
        ana
      )
      const reloaded = yield* api.GetCast({ chatId: started.chat.id, slotId: at })
      assert.include(
        reloaded.cards.map((card) => card.entityId),
        ana
      )
      assert.lengthOf(yield* events(), count + 3)
      // A card that isn't a persona stays when it stops being played; one already in the chat doesn't join again.
      yield* change({ _tag: "Join", entityId: tobin })
      yield* change({ _tag: "PlayedByMe", entityIds: [tobin] })
      const back = yield* change({ _tag: "Persona", entityId: bo })
      assert.deepStrictEqual(back.playedByMe, [bo])
      assert.deepStrictEqual(back.participants, [miraId, bo, tobin])

      // A card that isn't the user's: nothing is written, not even part of the switch.
      const before = (yield* events()).length
      yield* Effect.flip(change({ _tag: "Persona", entityId: "0190f000-0000-7000-8000-000000000000" as EntityId }))
      assert.lengthOf(yield* events(), before)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )

  it.live("a chat's notes: its own and its characters', each on or off per branch, made and binned", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const reader = yield* Reader
      const writer = yield* Writer
      const miraRef = yield* api.CreateCard({ label: "Mira", name: "Mira" })
      const tobinRef = yield* api.CreateCard({ label: "Tobin", name: "Tobin" })
      const outfit = yield* api.CreateCardNote({ cardRefId: miraRef.id, title: "Outfit" })
      const mood = yield* api.CreateCardNote({ cardRefId: miraRef.id, title: "Mood" })
      // Outfit is on in every chat with Mira unless a chat switches it off.
      const me = yield* api.Whoami()
      const outfitDoc = (yield* api.OpenEditor({ refId: outfit.id })).doc
      yield* writer.EditRef({
        userId: me.id as UserId,
        refId: outfit.id,
        doc: { ...outfitDoc, on_by_default: true },
        expectedRowVersion: outfit.rowVersion,
        message: null,
        commitDraft: null
      })
      // The user plays Tobin: a persona note is a card's note, listed and switched like any.
      yield* api.CreateCardNote({ cardRefId: tobinRef.id, title: "Persona note" })
      const started = yield* api.StartChat({
        cards: [miraRef.entityId],
        persona: tobinRef.entityId,
        greeting: null,
        first: { _tag: "Send", content: "Hello.", speakerEntityId: null }
      })
      const chatId = started.chat.id
      const at = started.entry.slotId
      const listed = (slotId: typeof at | null) =>
        Effect.map(api.ListChatNotes({ chatId, slotId }), (notes) =>
          notes.map((n) => `${n.ref.label}${n.card === null ? " (chat)" : ""}: ${n.active ? "on" : "off"}`)
        )
      assert.deepStrictEqual(yield* listed(at), ["Outfit: on", "Mood: off", "Persona note: off"])

      const scene = yield* api.CreateChatNote({ chatId, title: "  Scene  " })
      assert.strictEqual(scene.label, "Scene")
      // The chat's author's note, which notes at its top or bottom join, says so (no hidden kinds).
      const authorNotes = Effect.map(api.ListChatNotes({ chatId, slotId: at }), (notes) =>
        notes.filter((n) => n.authorNote).map((n) => n.ref.label)
      )
      assert.deepStrictEqual(yield* authorNotes, [])
      yield* writer.AddStateEvent({
        userId: me.id as UserId,
        chatId,
        slotId: null,
        versionId: null,
        scope: null,
        data: { key: "author_note.set", value: { note: scene.entityId } }
      })
      assert.deepStrictEqual(yield* authorNotes, ["Scene"])
      assert.deepStrictEqual(yield* listed(at), ["Scene (chat): off", "Outfit: on", "Mood: off", "Persona note: off"])
      const change = (entityId: EntityId, active: boolean) =>
        api.ChangeCast({ chatId, slotId: at, change: { _tag: "Note", entityId, active } })
      yield* change(scene.entityId, true)
      yield* change(outfit.entityId, false)
      yield* change(mood.entityId, true)
      assert.deepStrictEqual(yield* listed(at), ["Scene (chat): on", "Outfit: off", "Mood: on", "Persona note: off"])
      // Only from that message on, and only on its branch.
      assert.deepStrictEqual(yield* listed(null), ["Scene (chat): off", "Outfit: on", "Mood: off", "Persona note: off"])
      const other = yield* posted(
        api.SendMessage({ chatId, parentSlotId: null, branch: true, content: "Another start." })
      )
      assert.deepStrictEqual(yield* listed(other.entry.slotId), [
        "Scene (chat): off",
        "Outfit: on",
        "Mood: off",
        "Persona note: off"
      ])

      // To the bin and back, like any delete.
      const binned = yield* api.DeleteNote({ noteRefId: scene.id })
      assert.deepStrictEqual(yield* listed(at), ["Outfit: off", "Mood: on", "Persona note: off"])
      yield* api.RestoreBinItem({ itemId: binned.id })
      assert.deepStrictEqual(yield* listed(at), ["Scene (chat): on", "Outfit: off", "Mood: on", "Persona note: off"])

      // Another user's reads and writes see nothing of it.
      const bo = yield* writer.EnsureUser({ handle: "bo", displayName: "Bo" })
      const refused = yield* Effect.flip(
        reader.ChatNoteEntries({ userId: bo.id as UserId, chatId, slotId: null, cards: [miraRef.entityId] })
      )
      assert.strictEqual(refused._tag, "NotFound")
      const planted = yield* Effect.flip(writer.CreateChatNote({ userId: bo.id as UserId, chatId, title: "Planted" }))
      assert.strictEqual(planted._tag, "NotFound")
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

// Queue prose uses the same drafting protocol as message edits, with a key owned by the
// chat so posting/withdrawing the queue entry cannot invalidate an in-flight draft save.
describe("queued edits", () => {
  for (const changes of [105, DraftHistoryPolicy.maxEntries + 5])
    (changes > 1000 ? slowIt : it).live(`exposes and restores queue edit history after ${changes} changes`, () =>
      Effect.gen(function* () {
        const api = yield* client()
        const chat = yield* api.CreateChat({ title: "Long queue edit history" })
        // Queue drafts belong to the chat after the queued row has gone, too.
        const target = { _tag: "Queue" as const, chatId: chat.id, queuedId: "posted-item", rowVersion: 1 }
        const original = "An early passage that must remain reachable. ".repeat(8)
        let draft = yield* api.SaveMessageDraft({
          target,
          draftId: null,
          content: original,
          expectedRowVersion: null,
          expectedSession: null
        })
        const passage = (i: number) => `${i}: ${String.fromCharCode(65 + (i % 26)).repeat(400)}`
        for (let i = 0; i < changes; i++) {
          // Destructive replacements cannot coalesce, independent of host timing.
          draft = yield* api.SaveMessageDraft({
            target,
            draftId: draft.id,
            content: passage(i),
            expectedRowVersion: draft.rowVersion,
            expectedSession: draft.session
          })
        }
        const history = yield* api.QueueDraftHistory({ chatId: chat.id, queuedId: target.queuedId })
        assert.deepStrictEqual(
          yield* api.MessageDraftHistory({ target, limit: DraftHistoryPolicy.maxEntries + 1 }),
          history
        )
        assert.lengthOf(history, Math.min(changes, DraftHistoryPolicy.maxEntries) + 1)
        const initial = history.at(-1)!
        const oldest = Math.max(0, changes - DraftHistoryPolicy.maxEntries)
        assert.strictEqual(initial.seq, oldest)
        const restored = yield* api.RestoreQueueDraft({
          chatId: chat.id,
          queuedId: target.queuedId,
          draftId: draft.id,
          seq: initial.seq,
          expectedRowVersion: draft.rowVersion
        })
        assert.strictEqual(restored.content, oldest === 0 ? original : passage(oldest - 1))
        const sharedRestore = yield* api.RestoreMessageDraft({
          target,
          draftId: restored.id,
          seq: history[0]!.seq,
          expectedRowVersion: restored.rowVersion
        })
        assert.strictEqual(sharedRestore.content, passage(changes - 1))
      }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
    )

  for (const kind of ["message", "direction"] as const) {
    it.live(`persists ${kind} edits, undo and recovery across a queue lifecycle`, () =>
      Effect.gen(function* () {
        const api = yield* client()
        const miraId = yield* card(api, "Mira", mira)
        const started = yield* api.StartChat({
          cards: [miraId],
          persona: null,
          greeting: null,
          first: { _tag: "Generate", speakerEntityId: miraId, direction: "Wait" }
        })
        const sent =
          kind === "message"
            ? yield* api.SendMessage({
                chatId: started.chat.id,
                parentSlotId: started.entry.slotId,
                branch: false,
                speakerEntityId: null,
                content: "Original message",
                reply: false
              })
            : yield* api.Generate({
                chatId: started.chat.id,
                parentSlotId: started.entry.slotId,
                branch: false,
                speakerEntityId: miraId,
                direction: "Original direction"
              })
        assert.strictEqual(sent._tag, "Queued")
        if (sent._tag !== "Queued") return
        const queued = sent.queued
        const target = {
          _tag: "Queue" as const,
          chatId: started.chat.id,
          queuedId: queued.id,
          rowVersion: queued.rowVersion
        }
        const original = kind === "message" ? queued.content : queued.direction!
        const first = yield* api.SaveMessageDraft({
          target,
          draftId: null,
          content: original,
          expectedRowVersion: null,
          expectedSession: null
        })
        const long = "Unsent writing about the harbor and its keeper. ".repeat(8)
        const second = yield* api.SaveMessageDraft({
          target,
          draftId: first.id,
          content: long,
          expectedRowVersion: first.rowVersion,
          expectedSession: first.session
        })
        const third = yield* api.SaveMessageDraft({
          target,
          draftId: second.id,
          content: "x",
          expectedRowVersion: second.rowVersion,
          expectedSession: second.session
        })
        const history = yield* api.QueueDraftHistory({ chatId: started.chat.id, queuedId: queued.id })
        const state = history.find((state) => state.length === long.length)!
        assert.isDefined(state)
        const restored = yield* api.RestoreQueueDraft({
          chatId: started.chat.id,
          queuedId: queued.id,
          draftId: third.id,
          seq: state.seq,
          expectedRowVersion: third.rowVersion
        })
        assert.strictEqual(restored.content, long)
        const changed = yield* api.EditQueued({
          queuedId: queued.id,
          content: long,
          speakerEntityId: queued.speakerEntityId,
          expectedRowVersion: queued.rowVersion,
          draft: { draftId: restored.id, session: restored.session }
        })
        assert.strictEqual(kind === "message" ? changed.content : changed.direction, long)
        assert.lengthOf(yield* api.MessageDrafts({ chatId: started.chat.id }), 0)
        // Text typed while Save was travelling starts a new drafting session, and survives
        // removal of the queue entry before that save reaches the writer.
        yield* api.WithdrawQueued({ queuedId: queued.id, expectedRowVersion: changed.rowVersion })
        const late = yield* api.SaveMessageDraft({
          target,
          draftId: restored.id,
          content: "Typed during Save",
          expectedRowVersion: restored.rowVersion,
          expectedSession: restored.session
        })
        assert.strictEqual(late.content, "Typed during Save")
        assert.deepStrictEqual(
          (yield* api.MessageDrafts({ chatId: started.chat.id })).map((draft) => draft.content),
          ["Typed during Save"]
        )
        yield* api.DiscardMessageDraft({ target, draftId: late.id, expectedRowVersion: late.rowVersion })
        const recovered = yield* api.ListRecoveredTexts({ limit: 100, before: null })
        assert.isTrue(recovered.some((text) => text.content === "Typed during Save"))
        yield* api.StopGeneration({ versionId: started.entry.version.id })
      }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), slow)))
    )
  }

  it.live("posting a queued message preserves an unsent edit and accepts a late browser save", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const miraId = yield* card(api, "Mira", mira)
      const started = yield* api.StartChat({
        cards: [miraId],
        persona: null,
        greeting: null,
        first: { _tag: "Generate", speakerEntityId: miraId, direction: "" }
      })
      const sent = yield* api.SendMessage({
        chatId: started.chat.id,
        parentSlotId: started.entry.slotId,
        branch: false,
        speakerEntityId: null,
        content: "Posted original",
        reply: false
      })
      if (sent._tag !== "Queued") return yield* Effect.die("expected queue")
      const target = {
        _tag: "Queue" as const,
        chatId: started.chat.id,
        queuedId: sent.queued.id,
        rowVersion: sent.queued.rowVersion
      }
      const draft = yield* api.SaveMessageDraft({
        target,
        draftId: null,
        content: "Unsent edit",
        expectedRowVersion: null,
        expectedSession: null
      })
      yield* api.StopGeneration({ versionId: started.entry.version.id })
      while ((yield* api.ListQueued({ chatId: started.chat.id })).length > 0) yield* Effect.sleep(20)
      const late = yield* api.SaveMessageDraft({
        target,
        draftId: draft.id,
        content: "Still editing after posting",
        expectedRowVersion: draft.rowVersion,
        expectedSession: draft.session
      })
      assert.strictEqual(late.content, "Still editing after posting")
      const path = yield* pathOf(api, started.chat.id)
      assert.strictEqual(path.at(-1)!.version.content, "Posted original")
      assert.strictEqual((yield* api.MessageDrafts({ chatId: started.chat.id }))[0]!.content, late.content)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), slow)))
  )
  it.live("the user chooses which chat note is the author's note, or none, from a message on", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const card = yield* api.CreateCard({ label: "Wren", name: "Wren" })
      const cardNote = yield* api.CreateCardNote({ cardRefId: card.id, title: "Wren's note" })
      const started = yield* api.StartChat({
        cards: [card.entityId],
        persona: null,
        greeting: null,
        first: { _tag: "Send", content: "Hello.", speakerEntityId: null }
      })
      const chatId = started.chat.id
      const first = started.entry.slotId
      const scene = yield* api.CreateChatNote({ chatId, title: "Scene" })
      const mood = yield* api.CreateChatNote({ chatId, title: "Mood" })
      const authorNotes = (slotId: typeof first) =>
        Effect.map(api.ListChatNotes({ chatId, slotId }), (notes) =>
          notes.filter((n) => n.authorNote).map((n) => n.ref.label)
        )
      const choose = (slotId: typeof first, entityId: EntityId | null) =>
        api.ChangeCast({ chatId, slotId, change: { _tag: "AuthorNote", entityId } })
      assert.deepStrictEqual(yield* authorNotes(first), [])
      yield* choose(first, scene.entityId)
      assert.deepStrictEqual(yield* authorNotes(first), ["Scene"])
      // Choosing another replaces it; there is only ever one.
      yield* choose(first, mood.entityId)
      assert.deepStrictEqual(yield* authorNotes(first), ["Mood"])
      // From a later message on: the earlier message keeps its choice.
      const later = yield* api.SendMessage({
        chatId,
        forkId: started.chat.currentForkId,
        parentSlotId: first,
        branch: false,
        content: "Later."
      })
      assert.strictEqual(later._tag, "Posted")
      if (later._tag !== "Posted") return
      yield* choose(later.entry.slotId, null)
      assert.deepStrictEqual(yield* authorNotes(later.entry.slotId), [])
      assert.deepStrictEqual(yield* authorNotes(first), ["Mood"])
      // Only a chat's own notes can be its author's note. A refused choice keeps the old one.
      yield* choose(later.entry.slotId, mood.entityId)
      assert.strictEqual(yield* outcome(choose(later.entry.slotId, cardNote.entityId)), "NotFound")
      const shared = yield* api.CreateSnippet({ chatId, forkId: null, title: "Shared", content: "Fog." })
      assert.strictEqual(yield* outcome(choose(later.entry.slotId, shared.ref.entityId)), "NotFound")
      const other = yield* api.CreateChat({ title: "Other" })
      const foreign = yield* api.CreateChatNote({ chatId: other.id, title: "Elsewhere" })
      assert.strictEqual(yield* outcome(choose(later.entry.slotId, foreign.entityId)), "NotFound")
      assert.deepStrictEqual(yield* authorNotes(later.entry.slotId), ["Mood"])
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )
})

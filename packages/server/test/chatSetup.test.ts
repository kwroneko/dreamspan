// Starting chats from cards, who's in them, and their settings (DESIGN §2.1, §2.2, §3.5):
// a card's greeting shows without a chat, the chat is made on the first turn with every
// greeting as a version of its first message, and changes to the cast are state events
// at a position. Cross-user access is in the isolation matrix.
import { assert, describe, it } from "@effect/vitest"
import type { Chat, EntityId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { Effect } from "effect"
import { foldState } from "@rp/shared/state.ts"
import { Generator } from "../src/chat/Generator.ts"
import { freezeTemplate } from "../src/chat/macros.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import * as FakeGenerator from "../src/dev/fakeGenerator.ts"
import { client, outcome, posted, serverLayer, testConfig } from "./support/config.ts"
import type { CardDoc } from "@rp/shared/docs/card.ts"
import { cardDoc } from "./support/docs.ts"

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

  it.live("a card edited only in this chat: its own version, made once, shown there and nowhere else", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const writer = yield* Writer
      const me = yield* api.Whoami()
      const miraId = yield* card(api, "Mira", { ...mira, description: "Mira keeps the harbor bell." })
      const start = () =>
        api.StartChat({
          cards: [miraId],
          persona: null,
          greeting: 0,
          first: { _tag: "Send", content: "Hello.", speakerEntityId: null }
        })
      const here = (yield* start()).chat.id
      const there = (yield* start()).chat.id
      const [before] = yield* api.ListChatCards({ chatId: here, slotId: null, entityIds: [miraId] })
      assert.isNull(before!.overrideRefId)
      assert.strictEqual(before!.usedByChats, 2)
      assert.strictEqual(before!.definition.description, "Mira keeps the harbor bell.")
      assert.strictEqual(before!.definition.alternateGreetings, 2)

      // Made on first use, opened after that.
      const opened = yield* api.EditCardForChat({ chatId: here, slotId: null, entityId: miraId })
      assert.isFalse(opened.bound)
      const override = opened.ref
      assert.strictEqual(override.refKind, "chat_override")
      assert.strictEqual(override.chatId, here)
      assert.strictEqual(override.followsRefId, before!.refId)
      assert.strictEqual(
        (yield* api.EditCardForChat({ chatId: here, slotId: null, entityId: miraId })).ref.id,
        override.id
      )

      const doc = (yield* api.OpenEditor({ refId: override.id })).doc
      yield* writer.EditRef({
        userId: me.id as UserId,
        refId: override.id,
        doc: { ...doc, description: "Mira rings the harbor bell." },
        expectedRowVersion: override.rowVersion,
        message: null,
        commitDraft: null
      })
      const [edited] = yield* api.ListChatCards({ chatId: here, slotId: null, entityIds: [miraId] })
      assert.strictEqual(edited!.overrideRefId, override.id)
      assert.isTrue(edited!.usesOverride)
      assert.strictEqual(edited!.binding, "default")
      assert.strictEqual(edited!.refId, before!.refId)
      assert.strictEqual(edited!.definition.description, "Mira rings the harbor bell.")
      const [elsewhere] = yield* api.ListChatCards({ chatId: there, slotId: null, entityIds: [miraId] })
      assert.isNull(elsewhere!.overrideRefId)
      assert.strictEqual(elsewhere!.definition.description, "Mira keeps the harbor bell.")
      // The library entry is unchanged.
      assert.strictEqual(
        (yield* api.OpenEditor({ refId: before!.refId })).doc["description"],
        "Mira keeps the harbor bell."
      )
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

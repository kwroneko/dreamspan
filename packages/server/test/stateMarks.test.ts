// The read behind the timeline's change markers (`GetStateMarks`, db/stateMarks.ts): the state
// events of the named keys on a branch's path with where each was written and the names of what
// they name; per branch, inherited up to the fork point; and display only: reading them, or
// hiding a kind of marker, changes no request.
import { assert, describe, it } from "@effect/vitest"
import { type EntityId, type ForkId, NewVersion, type SlotId } from "@dreamspan/shared/chat.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { Effect } from "effect"
import { Generator } from "../src/chat/Generator.ts"
import { Writer } from "../src/db/Database.ts"
import { client, post, posted, serverLayer, testConfig } from "./support/config.ts"
import { cardDoc } from "./support/docs.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { completionChunks, sse, startMockProvider } from "./support/mockProvider.ts"

type Api = Effect.Success<ReturnType<typeof client>>

const KEYS = ["participant.join", "participant.leave", "presence.set", "context.per_speaker"]

const card = (api: Api, name: string) =>
  Effect.gen(function* () {
    const writer = yield* Writer
    const me = yield* api.Whoami()
    const { entityId } = yield* writer.CreateEntity({
      userId: me.id as UserId,
      kind: "card",
      label: name,
      subtitle: "",
      doc: cardDoc(name),
      schemaVersion: 1,
      origin: "user",
      sourcePath: null
    })
    return entityId as EntityId
  })

/** Mira and Tobin, the user's line and Mira's reply, written by hand. */
const twoMessages = Effect.gen(function* () {
  const api = yield* client()
  const mira = yield* card(api, "Mira")
  const tobin = yield* card(api, "Tobin")
  const wren = yield* card(api, "Wren")
  const started = yield* api.StartChat({
    cards: [mira, tobin],
    persona: null,
    greeting: null,
    first: { _tag: "Send", content: "The inn's door creaks open.", speakerEntityId: null }
  })
  const userId = (yield* api.Whoami()).id as UserId
  const chatId = started.chat.id
  const forkId = started.chat.currentForkId as ForkId
  const first = started.entry.slotId as SlotId
  const reply = yield* (yield* Writer).AppendMessage({
    userId,
    chatId,
    forkId,
    parentSlotId: first,
    branch: false,
    version: new NewVersion({
      speakerEntityId: mira,
      writer: "human",
      content: "*Mira sets down her cup.*",
      status: "complete",
      macroMode: "verbatim",
      origin: "user_written"
    }),
    commitDraft: null
  })
  return { api, mira, tobin, wren, chatId, forkId, first, second: reply.slotId as SlotId }
})

const shape = (marks: { readonly events: ReadonlyArray<{ slotId: string | null; key: string; value: unknown }> }) =>
  marks.events.map(({ slotId, key, value }) => ({ slotId, key, value }))

describe("the timeline's change markers' read", () => {
  it.live("keeps built-in markers when registered kinds request more than 64 keys", () =>
    Effect.gen(function* () {
      const { api, chatId, forkId, second, mira } = yield* twoMessages
      const marks = yield* api.GetStateMarks({
        chatId,
        forkId,
        slotId: second,
        keys: ["participant.join", ...Array.from({ length: 64 }, (_, i) => `fixture/key-${i}`)]
      })
      assert.isTrue(marks.events.some((e) => e.key === "participant.join"))
      assert.strictEqual(marks.names[mira], "Mira")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )
  it.live("returns every note in a switched moved group, including its unswitched partner", () =>
    Effect.gen(function* () {
      const { api, chatId, forkId, second } = yield* twoMessages
      const made = (yield* (yield* Writer).CreateEntity({
        userId: (yield* api.Whoami()).id,
        kind: "card",
        label: "Pair",
        subtitle: "",
        doc: { ...cardDoc("Pair"), description: "Blue. Secret." },
        schemaVersion: 1,
        origin: "user",
        sourcePath: null
      })).ref
      yield* api.MoveToOwnTurnNote({
        cardRefId: made.id,
        expectedRevisionId: made.headRevisionId,
        field: "description",
        text: "Blue. Secret.",
        at: 6,
        length: 7
      })
      const notes = yield* api.ListCardNotes({ cardRefId: made.id })
      assert.lengthOf(notes, 2)
      yield* api.ChangeCast({ chatId, forkId, slotId: second, change: { _tag: "Join", entityId: made.entityId } })
      yield* api.ChangeCast({
        chatId,
        forkId,
        slotId: second,
        change: { _tag: "Note", entityId: notes[0]!.ref.entityId, active: false }
      })
      const marks = yield* api.GetStateMarks({
        chatId,
        forkId,
        slotId: second,
        keys: ["note.activate", "note.deactivate"]
      })
      assert.sameMembers(
        Object.keys(marks.notes),
        notes.map((n) => n.ref.entityId)
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )
  it.live("lists the named keys' events where they were written, with the names of what they name", () =>
    Effect.gen(function* () {
      const { api, mira, tobin, wren, chatId, forkId, first, second } = yield* twoMessages
      yield* api.ChangeCast({
        chatId,
        forkId,
        slotId: first,
        change: { _tag: "Presence", entityId: tobin, present: false }
      })
      yield* api.ChangeCast({ chatId, forkId, slotId: second, change: { _tag: "Join", entityId: wren } })
      yield* api.ChangeCast({ chatId, forkId, slotId: second, change: { _tag: "ContextPerSpeaker", view: "separate" } })
      // Not asked for: an away mark has rows of its own.
      yield* api.ChangeCast({ chatId, forkId, slotId: second, change: { _tag: "Away", entityId: mira, away: true } })
      const marks = yield* api.GetStateMarks({ chatId, forkId, slotId: second, keys: KEYS })
      assert.deepStrictEqual(shape(marks), [
        // Where the chat started: before the first message.
        { slotId: null, key: "participant.join", value: { entity: mira } },
        { slotId: null, key: "participant.join", value: { entity: tobin } },
        { slotId: first, key: "presence.set", value: { entity: tobin, present: false } },
        { slotId: second, key: "participant.join", value: { entity: wren } },
        { slotId: second, key: "context.per_speaker", value: "separate" }
      ])
      assert.deepStrictEqual(marks.names, { [mira]: "Mira", [tobin]: "Tobin", [wren]: "Wren" })
      // Read through an earlier message: nothing written after it.
      assert.strictEqual(
        shape(yield* api.GetStateMarks({ chatId, forkId, slotId: first, keys: KEYS })).filter(
          (e) => e.slotId === second
        ).length,
        0
      )
      assert.deepStrictEqual(yield* api.GetStateMarks({ chatId, forkId, slotId: second, keys: [] }), {
        events: [],
        names: {},
        notes: {}
      })
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )

  it.live("is per branch: a fork inherits what was before it, and neither sees the other's later changes", () =>
    Effect.gen(function* () {
      const { api, mira, tobin, wren, chatId, forkId, first, second } = yield* twoMessages
      yield* api.ChangeCast({
        chatId,
        forkId,
        slotId: first,
        change: { _tag: "Presence", entityId: tobin, present: false }
      })
      const made = yield* api.CreateFork({ chatId, fromForkId: forkId, atSlotId: first })
      const sibling = made.fork.id as ForkId
      // After the fork: one change on each branch, at the message both show.
      yield* api.ChangeCast({ chatId, forkId, slotId: first, change: { _tag: "Join", entityId: wren } })
      yield* api.ChangeCast({
        chatId,
        forkId: sibling,
        slotId: first,
        change: { _tag: "Presence", entityId: mira, present: false }
      })
      const positional = (marks: Parameters<typeof shape>[0]) => shape(marks).filter((e) => e.slotId !== null)
      assert.deepStrictEqual(positional(yield* api.GetStateMarks({ chatId, forkId, slotId: second, keys: KEYS })), [
        { slotId: first, key: "presence.set", value: { entity: tobin, present: false } },
        { slotId: first, key: "participant.join", value: { entity: wren } }
      ])
      assert.deepStrictEqual(
        positional(yield* api.GetStateMarks({ chatId, forkId: sibling, slotId: first, keys: KEYS })),
        [
          { slotId: first, key: "presence.set", value: { entity: tobin, present: false } },
          { slotId: first, key: "presence.set", value: { entity: mira, present: false } }
        ]
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )

  it.live("deleting and restoring a carrier removes and restores both its marker and its effective state", () =>
    Effect.gen(function* () {
      const { api, tobin, chatId, forkId, first, second } = yield* twoMessages
      yield* api.ChangeCast({
        chatId,
        forkId,
        slotId: first,
        change: { _tag: "Presence", entityId: tobin, present: false }
      })
      const read = () => api.GetStateMarks({ chatId, forkId, slotId: second, keys: KEYS })
      assert.isTrue((yield* api.GetCast({ chatId, forkId, slotId: second })).absent.includes(tobin))
      const before = shape(yield* read())
      const item = yield* api.DeleteMessage({ slotId: first, forkId })
      assert.isFalse((yield* read()).events.some((e) => e.slotId === first))
      assert.isFalse((yield* api.GetCast({ chatId, forkId, slotId: second })).absent.includes(tobin))
      yield* api.RestoreBinItem({ itemId: item.id })
      assert.deepStrictEqual(shape(yield* read()), before)
      assert.isTrue((yield* api.GetCast({ chatId, forkId, slotId: second })).absent.includes(tobin))
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )

  it.live(
    "version-attached effects follow the selected swipe; manual changes survive edits and multi-delete Undo",
    () =>
      Effect.gen(function* () {
        const { api, tobin, chatId, forkId, first, second } = yield* twoMessages
        const writer = yield* Writer
        const userId = (yield* api.Whoami()).id
        const read = () => api.GetStateMarks({ chatId, forkId, slotId: second, keys: KEYS })
        const page = yield* api.ReadPath({ chatId, forkId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 10 })
        const original = page.entries.find((e) => e.slotId === first)!
        yield* writer.AddStateEvent({
          userId,
          chatId,
          forkId,
          slotId: first,
          versionId: original.version.id,
          scope: null,
          data: { key: "presence.set", value: { entity: tobin, present: false } }
        })
        assert.isTrue((yield* read()).events.some((e) => e.versionId === original.version.id))
        const alternate = yield* api.WriteVersion({
          slotId: first,
          forkId,
          content: "A synthetic alternative.",
          expectedRowVersion: original.rowVersion
        })
        assert.isFalse((yield* read()).events.some((e) => e.versionId === original.version.id))
        yield* api.SelectVersion({
          slotId: first,
          forkId,
          versionId: original.version.id,
          expectedVersionId: alternate.version.id
        })
        assert.isTrue((yield* read()).events.some((e) => e.versionId === original.version.id))
        yield* api.ChangeCast({
          chatId,
          forkId,
          slotId: first,
          change: { _tag: "ContextPerSpeaker", view: "separate" }
        })
        const before = shape(yield* read())
        const items = yield* api.DeleteMessages({ forkId, slotIds: [first] })
        assert.isFalse((yield* read()).events.some((e) => e.slotId === first))
        yield* api.RestoreBinItems({ itemIds: items.map((item) => item.id) })
        assert.deepStrictEqual(shape(yield* read()), before)
      }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )

  it.live("reading and hiding markers leaves exports and indexed search text unchanged", () =>
    Effect.gen(function* () {
      const { api, tobin, chatId, forkId, first, second } = yield* twoMessages
      yield* api.ChangeCast({
        chatId,
        forkId,
        slotId: first,
        change: { _tag: "Presence", entityId: tobin, present: false }
      })
      const exported = () =>
        Effect.gen(function* () {
          const response = yield* post("/library/chat-export", { chatId, forkId, scope: "branch", format: "jsonl" })
          assert.strictEqual(response.status, 200)
          return yield* Effect.promise(() => response.text())
        })
      const before = yield* exported()
      const search = yield* api.SearchMessages({ text: "cup", cursor: null })
      yield* api.GetStateMarks({ chatId, forkId, slotId: second, keys: KEYS })
      yield* api.SetDisplayPrefs({ prefs: { stateMarkers: { "state.mute": false } } })
      assert.strictEqual(yield* exported(), before)
      assert.deepStrictEqual(yield* api.SearchMessages({ text: "cup", cursor: null }), search)
      assert.isFalse(JSON.stringify(search).includes("muted"))
      assert.lengthOf((yield* api.SearchMessages({ text: "muted", cursor: null })).hits, 0)
      assert.notInclude(before, "muted")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )

  it.live("takes no place among the messages: the same pages, numbers and cursors with and without changes", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const tobin = yield* card(api, "Tobin")
      /** Twelve lines, the fourth deleted; with `changes`, a change at every line, and the marks read. */
      const build = (changes: boolean) =>
        Effect.gen(function* () {
          const chat = yield* api.CreateChat({ title: changes ? "With changes" : "Without" })
          const chatId = chat.id
          const forkId = chat.currentForkId as ForkId
          yield* api.ChangeCast({ chatId, forkId, slotId: null, change: { _tag: "Join", entityId: tobin } })
          const slots: Array<SlotId> = []
          for (let i = 1; i <= 12; i++) {
            const sent = yield* posted(
              api.SendMessage({
                chatId,
                parentSlotId: slots.at(-1) ?? null,
                branch: false,
                content: `Synthetic line ${i}.`,
                reply: false
              })
            )
            slots.push(sent.entry.slotId as SlotId)
            if (!changes) continue
            yield* api.ChangeCast({
              chatId,
              forkId,
              slotId: sent.entry.slotId as SlotId,
              change: { _tag: "Presence", entityId: tobin, present: i % 2 === 0 }
            })
            yield* api.ChangeCast({
              chatId,
              forkId,
              slotId: sent.entry.slotId as SlotId,
              change: { _tag: "CardsRotation", on: i % 2 === 1 }
            })
          }
          yield* api.DeleteMessage({ slotId: slots[3]!, forkId })
          if (changes) {
            const marks = yield* api.GetStateMarks({
              chatId,
              forkId,
              slotId: slots.at(-1)!,
              keys: [...KEYS, "cards.rotation"]
            })
            assert.isAtLeast(marks.events.filter((event) => event.slotId !== null).length, 22)
          }
          // Every page from the newest up, five at a time, by where each message is, not its id.
          const index = (slot: string | null) => (slot === null ? null : slots.indexOf(slot as SlotId))
          const pages: Array<unknown> = []
          let range: Parameters<typeof api.ReadPath>[0]["range"] = { _tag: "Bottom" }
          for (;;) {
            const page: Effect.Success<ReturnType<typeof api.ReadPath>> = yield* api.ReadPath({
              chatId,
              forkId,
              leafSlotId: null,
              range,
              limit: 5
            })
            pages.push({
              older: index(page.older),
              newer: index(page.newer),
              leaf: index(page.leafSlotId),
              entries: page.entries.map((entry) => ({
                at: index(entry.slotId),
                depth: entry.depth,
                position: entry.position ?? null,
                content: entry.version.content,
                versions: entry.versionCount
              }))
            })
            if (page.older === null) break
            range = { _tag: "Older", from: page.older }
          }
          return pages
        })
      const without = yield* build(false)
      const withChanges = yield* build(true)
      assert.deepStrictEqual(withChanges, without)
      // Eleven messages in all, and the deleted one is walked through, not returned.
      const entries = (without as Array<{ entries: Array<{ content: string }> }>).flatMap((page) => page.entries)
      assert.strictEqual(entries.length, 11)
      assert.isFalse(entries.some((entry) => entry.content === "Synthetic line 4."))
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )

  it.live(
    "is display only: reading the marks and hiding a kind leave the next request byte for byte the same",
    () => {
      const config = testConfig()
      return Effect.gen(function* () {
        const mock = yield* Effect.acquireRelease(
          Effect.promise(() => startMockProvider((_request, res) => sse(res, completionChunks(["Noted."], {})))),
          (m) => Effect.promise(() => m.close())
        )
        const api = yield* client()
        const events: Array<import("@dreamspan/shared/chatApi.ts").ChatEvent> = []
        const { chat, version } = yield* generateReply(api, {
          connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
          model: {},
          characters: ["Tobin"],
          events
        })
        const forkId = chat.currentForkId as ForkId
        const parent = version.slotId as SlotId
        const cast = yield* api.GetCast({ chatId: chat.id, forkId, slotId: parent })
        const tobin = cast.cards.find((one) => one.name === "Tobin")!.entityId
        // Changes recorded after the reply: they apply to what's generated next.
        yield* api.ChangeCast({
          chatId: chat.id,
          forkId,
          slotId: parent,
          change: { _tag: "Presence", entityId: tobin, present: false }
        })
        yield* api.ChangeCast({ chatId: chat.id, forkId, slotId: parent, change: { _tag: "CardsRotation", on: true } })
        const completions = () => mock.requests().filter((r) => r.path === "/v1/chat/completions")
        const generate = (branch: boolean) =>
          Effect.gen(function* () {
            const before = completions().length
            const { entry } = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: parent, branch }))
            yield* eventually(() => finished(events, entry.version.id) !== undefined)
            return completions()[before]!.body
          })
        const without = yield* generate(false)
        const marks = yield* api.GetStateMarks({
          chatId: chat.id,
          forkId,
          slotId: parent,
          keys: ["presence.set", "cards.rotation", "participant.join"]
        })
        assert.isAbove(marks.events.filter((event) => event.slotId === parent).length, 1)
        yield* api.SetDisplayPrefs({ prefs: { stateMarkers: { "state.mute": false } } })
        assert.deepStrictEqual((yield* api.GetDisplayPrefs({})).stateMarkers, { "state.mute": false })
        // The same position again, as another branch from it: the same request.
        const after = yield* generate(true)
        assert.deepStrictEqual(after, without)
        const text = JSON.stringify(after)
        for (const word of ["muted", "Card swap", "changes:"]) assert.notInclude(text, word)
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    },
    120_000
  )
})

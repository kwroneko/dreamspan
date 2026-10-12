// The recycle bin's RPCs over a real server (DESIGN §6.2): restoring puts a message back
// where it was with the chat state on it, and a chat's leaf (and composer) back on it;
// deleting for good, and the recovered text. Cross-user access is in the isolation matrix.
import { assert, describe, it } from "@effect/vitest"
import type { Chat, ChatId, SlotId } from "@rp/shared/chat.ts"
import type { ChatEvent } from "@rp/shared/chatApi.ts"
import { Effect, Stream } from "effect"
import { Writer } from "../src/db/Database.ts"
import { cardDoc } from "./support/docs.ts"
import { client, outcome, posted, testConfig, withServer } from "./support/config.ts"

type Api = Effect.Success<ReturnType<typeof client>>

const send = (api: Api, chatId: ChatId, parentSlotId: SlotId | null, content: string) =>
  Effect.map(posted(api.SendMessage({ chatId, parentSlotId, branch: false, content })), (sent) => sent.entry.slotId)

const contents = (api: Api, chatId: ChatId) =>
  Effect.map(api.ReadPath({ chatId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 100 }), (window) =>
    window.entries.map((e) => e.version.content)
  )

const eventually = (check: () => boolean) =>
  Effect.gen(function* () {
    const deadline = Date.now() + 10_000
    while (!check()) {
      if (Date.now() > deadline) return yield* Effect.die(new Error("timed out waiting"))
      yield* Effect.sleep(10)
    }
  })

const subscribe = (api: Api, chatId: Chat["id"]) =>
  Effect.gen(function* () {
    const events: Array<ChatEvent> = []
    yield* api.SubscribeChat({ chatId }).pipe(
      Stream.runForEach((batch) => Effect.sync(() => events.push(...batch))),
      Effect.forkScoped
    )
    yield* eventually(() => events.length > 0)
    return events
  })

describe("the recycle bin's RPCs", () => {
  it.live("puts the chat's last message back at its end, with the composer that went up with the leaf", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const chat = yield* api.CreateChat({ title: "Harbor" })
      const m0 = yield* send(api, chat.id, null, "m0")
      const m1 = yield* send(api, chat.id, m0, "m1")
      yield* api.SaveComposer({ chatId: chat.id, tipSlotId: m1, content: "half typed", expectedRowVersion: null })
      const events = yield* subscribe(api, chat.id)
      const item = yield* api.DeleteMessage({ slotId: m1 })
      assert.deepStrictEqual(yield* contents(api, chat.id), ["m0"])
      assert.strictEqual((yield* api.GetComposer({ chatId: chat.id, tipSlotId: m0 }))?.content, "half typed")
      assert.deepStrictEqual(
        (yield* api.ListBin({ limit: 10, before: null })).map((i) => i.id),
        [item.id]
      )

      const seen = events.length
      yield* api.RestoreBinItem({ itemId: item.id })
      assert.deepStrictEqual(yield* contents(api, chat.id), ["m0", "m1"])
      assert.strictEqual((yield* api.GetChat({ chatId: chat.id })).activeLeafSlotId, m1)
      assert.strictEqual((yield* api.GetComposer({ chatId: chat.id, tipSlotId: m1 }))?.content, "half typed")
      assert.deepStrictEqual(yield* api.ListBin({ limit: 10, before: null }), [])
      // Open tabs read it again, and hear where the leaf is.
      yield* eventually(() => events.slice(seen).some((e) => e._tag === "Chat" && e.chat.activeLeafSlotId === m1))
      assert.isTrue(events.slice(seen).some((e) => e._tag === "Reload"))
    }).pipe(Effect.scoped, withServer(testConfig()))
  )

  it.live("leaves the leaf where the chat went on since, so the message comes back as a branch", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const chat = yield* api.CreateChat({ title: "Chapel" })
      const m0 = yield* send(api, chat.id, null, "m0")
      const m1 = yield* send(api, chat.id, m0, "m1")
      const item = yield* api.DeleteMessage({ slotId: m1 })
      const other = yield* send(api, chat.id, m0, "other")
      yield* api.RestoreBinItem({ itemId: item.id })
      assert.strictEqual((yield* api.GetChat({ chatId: chat.id })).activeLeafSlotId, other)
      const window = yield* api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 10 })
      assert.deepStrictEqual(
        window.entries.map((e) => [e.version.content, e.branchCount]),
        [
          ["m0", 1],
          ["other", 2]
        ]
      )
    }).pipe(Effect.scoped, withServer(testConfig()))
  )

  it.live("brings back the chat state on a restored message", () =>
    Effect.gen(function* () {
      const writer = yield* Writer
      const api = yield* client()
      const me = yield* api.Whoami()
      const { entityId } = yield* writer.CreateEntity({
        userId: me.id,
        kind: "card",
        label: "Mira",
        subtitle: "",
        doc: cardDoc("Mira"),
        schemaVersion: 1,
        origin: "user",
        sourcePath: null
      })
      const chat = yield* api.CreateChat({ title: "State" })
      const m0 = yield* send(api, chat.id, null, "m0")
      const m1 = yield* send(api, chat.id, m0, "m1")
      const m2 = yield* send(api, chat.id, m1, "m2")
      yield* api.ChangeCast({ chatId: chat.id, slotId: m1, change: { _tag: "Join", entityId } })
      const joined = () =>
        Effect.map(api.GetCast({ chatId: chat.id, slotId: m2 }), (cast) => cast.participants.includes(entityId))
      assert.isTrue(yield* joined())
      const item = yield* api.DeleteMessage({ slotId: m1 })
      assert.isFalse(yield* joined())
      yield* api.RestoreBinItem({ itemId: item.id })
      assert.isTrue(yield* joined())
    }).pipe(Effect.scoped, withServer(testConfig()))
  )

  it.live("deletes for good, empties the bin, and keeps recovered text apart", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const chat = yield* api.CreateChat({ title: "Purge" })
      const m0 = yield* send(api, chat.id, null, "m0")
      yield* api.WriteVersion({ slotId: m0, content: "m0 again", expectedRowVersion: 1 })
      const versions = yield* api.ListVersions({ slotId: m0 })
      const swipe = yield* api.DeleteVersion({ versionId: versions[0]!.id })
      yield* api.PurgeBinItem({ itemId: swipe.id })
      assert.strictEqual((yield* api.ListVersions({ slotId: m0 })).length, 1)
      assert.strictEqual(yield* outcome(api.RestoreBinItem({ itemId: swipe.id })), "NotFound")
      const gone = yield* api.CreateChat({ title: "Gone" })
      yield* api.DeleteChat({ chatId: gone.id })
      assert.deepStrictEqual(yield* api.EmptyBin(), { purged: 1 })
      assert.deepStrictEqual(yield* api.ListBin({ limit: 10, before: null }), [])

      // Text wiped and then sent goes to the recovered text, never to the deleted items.
      const long = "A long paragraph about the harbor at night. ".repeat(10)
      const typed = yield* api.SaveComposer({ chatId: chat.id, tipSlotId: m0, content: long, expectedRowVersion: null })
      const wiped = yield* api.SaveComposer({
        chatId: chat.id,
        tipSlotId: m0,
        content: "x",
        expectedRowVersion: typed.rowVersion
      })
      yield* posted(
        api.SendMessage({
          chatId: chat.id,
          parentSlotId: m0,
          branch: false,
          content: "x",
          composerRowVersion: wiped.rowVersion
        })
      )
      const [recovered] = yield* api.ListRecoveredTexts({ limit: 10, before: null })
      assert.strictEqual(recovered!.sourceLabel, 'Composer in "Purge"')
      assert.strictEqual((yield* api.GetRecoveredText({ id: recovered!.id })).content, long)
      yield* api.DeleteRecoveredText({ id: recovered!.id })
      assert.deepStrictEqual(yield* api.ListRecoveredTexts({ limit: 10, before: null }), [])
      assert.deepStrictEqual(yield* api.ListBin({ limit: 10, before: null }), [])
    }).pipe(Effect.scoped, withServer(testConfig()))
  )
})

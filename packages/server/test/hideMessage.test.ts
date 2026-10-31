// Hiding a message from the model and showing it again (ST's ghost toggle), over a real
// server with a mock provider: the message stays in the chat, marked as the user's doing,
// isn't sent while hidden, the cache estimate says why, and nothing generates. Also a new
// chat of a group: titled with the group's name, it's one of the group's chats.
import { assert, describe, it } from "@effect/vitest"
import type { CardDoc } from "@rp/shared/docs/card.ts"
import type { CacheWarmth } from "@rp/shared/inspectorApi.ts"
import type { ChatEvent } from "@rp/shared/chatApi.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { Effect } from "effect"
import { Generator } from "../src/chat/Generator.ts"
import { Writer } from "../src/db/Database.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { cardDoc } from "./support/docs.ts"
import { eventually, generateReply } from "./support/generation.ts"
import { completionChunks, type Recorded, sse, startMockProvider } from "./support/mockProvider.ts"

const completion = (_request: Recorded, res: Parameters<typeof sse>[0]) =>
  sse(res, completionChunks(["The ledger ", "says otherwise."], { prompt_tokens: 120, completion_tokens: 6 }))

const mockProvider = Effect.acquireRelease(
  Effect.promise(() => startMockProvider(completion)),
  (m) => Effect.promise(() => m.close())
)

const estimates = (events: ReadonlyArray<ChatEvent>, from: number) =>
  events.slice(from).flatMap((e) => (e._tag === "Cache" ? [e.warmth] : []))

describe("hiding a message from the model", () => {
  it.live("keeps it in the chat, leaves it out of the next request, starts nothing, and shows it again", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* mockProvider
      const api = yield* client()
      const { version, chat, events } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1`, cacheTtlS: 300 },
        model: {}
      })
      const read = () => api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 10 })
      const sent = (yield* read()).entries[1]!
      assert.isFalse(sent.contextExcluded)
      assert.isFalse(sent.hiddenByUser)
      const requests = mock.requests().length
      const before = events.length

      const hidden = yield* api.SetMessageHidden({ slotId: sent.slotId, hidden: true })
      assert.isTrue(hidden.contextExcluded)
      assert.isTrue(hidden.hiddenByUser)
      assert.isFalse(hidden.inContext)
      assert.isAbove(hidden.rowVersion, sent.rowVersion)
      // Still in the chat, with its text, and published to open tabs.
      const after = (yield* read()).entries
      assert.lengthOf(after, 3)
      assert.strictEqual(after[1]!.version.content, "The road flooded.")
      assert.isTrue(after[1]!.contextExcluded)
      yield* eventually(() => events.slice(before).some((e) => e._tag === "Slot" && e.entry.slotId === sent.slotId))
      // The estimate says why the cache won't match.
      yield* eventually(() => estimates(events, before).some((w) => w?.changed != null))
      const cold = estimates(events, before).findLast((w: CacheWarmth | null) => w?.changed != null)!
      assert.strictEqual(cold.changed!.reason, "Message 2 was hidden.")
      // Hiding again changes nothing; nothing was generated.
      const again = yield* api.SetMessageHidden({ slotId: sent.slotId, hidden: true })
      assert.strictEqual(again.rowVersion, hidden.rowVersion)
      yield* Effect.sleep("100 millis")
      assert.strictEqual(mock.requests().length, requests)
      assert.isFalse(
        events.slice(before).some((e) => e._tag === "Version" && e.version.status === "generating"),
        "a hide starts no generation"
      )

      // The next reply's request leaves the hidden message out.
      const sentText = (body: Record<string, unknown> | null) =>
        JSON.stringify(body?.messages ?? []).includes("The road flooded.")
      const reply = after[2]!
      const swipe = yield* api.Regenerate({ slotId: reply.slotId, expectedRowVersion: reply.rowVersion })
      yield* eventually(() => mock.requests().length > requests)
      assert.isFalse(sentText(mock.requests().at(-1)!.body))
      yield* eventually(() =>
        events.some(
          (e) => e._tag === "Version" && e.version.id === swipe.version.id && e.version.status !== "generating"
        )
      )

      // Shown again, it's sent again.
      const shown = yield* api.SetMessageHidden({ slotId: sent.slotId, hidden: false })
      assert.isFalse(shown.contextExcluded)
      assert.isFalse(shown.hiddenByUser)
      assert.isTrue(shown.inContext)
      const latest = (yield* read()).entries[2]!
      yield* api.Regenerate({ slotId: latest.slotId, expectedRowVersion: latest.rowVersion })
      yield* eventually(() => mock.requests().length > requests + 1)
      assert.isTrue(sentText(mock.requests().at(-1)!.body))
      assert.notStrictEqual(version.id, swipe.version.id)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("is the user's own message only", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const refused = yield* Effect.flip(api.SetMessageHidden({ slotId: "missing" as never, hidden: true }))
      assert.strictEqual(refused._tag, "NotFound")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )
})

describe("a new chat of a group", () => {
  it.live("titled with the group's name, it joins the group's chats", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const writer = yield* Writer
      const me = yield* api.Whoami()
      const card = (label: string, doc: Partial<CardDoc>, persona = false) =>
        Effect.gen(function* () {
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
      const ana = yield* card("Ana", { name: "Ana", first_mes: "Hi, {{user}}." })
      const mira = yield* card("Mira", { name: "Mira", first_mes: "Hello." })
      const sam = yield* card("Sam", { name: "Sam" }, true)
      const start = (title?: string) =>
        api.StartChat({
          cards: [ana, mira],
          persona: sam,
          greeting: 0,
          first: { _tag: "Send", content: "Evening.", speakerEntityId: sam },
          ...(title === undefined ? {} : { title })
        })
      const first = yield* start("The Lantern Inn")
      assert.strictEqual(first.chat.title, "The Lantern Inn")
      yield* Effect.sleep("5 millis")
      const second = yield* start("The Lantern Inn")
      // Blank, it's named by its cast, as before: another group.
      yield* start("  ")
      const groups = yield* api.ListChatGroups()
      const inn = groups.find((group) => group.name === "The Lantern Inn")!
      assert.strictEqual(inn.chats, 2)
      assert.strictEqual(inn.latestChatId, second.chat.id)
      assert.deepStrictEqual(
        inn.members.map((member) => member.name),
        ["Ana", "Mira"]
      )
      assert.isTrue(groups.some((group) => group.name === "Ana & Mira"))
      // The first member greets, as the chat's first message, with `{{user}}` as the persona.
      const path = yield* api.ReadPath({
        chatId: second.chat.id,
        leafSlotId: null,
        range: { _tag: "Bottom" },
        limit: 5
      })
      assert.strictEqual(path.entries[0]!.version.speakerEntityId, ana)
      assert.strictEqual(path.entries[0]!.version.origin, "greeting")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )
})

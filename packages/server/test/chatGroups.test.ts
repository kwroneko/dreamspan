// Groups on the home grid (DESIGN §2.1; ST's group tiles): the chats with the same readable
// name and the same characters the user doesn't play, two or more, worked out on the server
// in one read; a group's chats, latest message first; and a chat's own model and preset
// taken off again (`model.unbind`, `preset.unbind`), so it follows the default. Cross-user
// access is in the isolation matrix; the read at 5,000 chats is timed in cardUsage.test.ts.
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import type { CardDoc } from "@rp/shared/docs/card.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { Effect } from "effect"
import { Generator } from "../src/chat/Generator.ts"
import { Writer } from "../src/db/Database.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { cardDoc, presetDoc } from "./support/docs.ts"
import { writeRealisticStFolder } from "./support/stRealistic.ts"
import { importStFolder } from "./support/stUpload.ts"
import { tempDir } from "./support/tempDir.ts"

type Api = Effect.Success<ReturnType<typeof client>>

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

describe("chat groups", () => {
  it.live("groups chats by name and characters, leaving out the user's own and the bin", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const ana = yield* card(api, "Ana", { name: "Ana", first_mes: "Hi." })
      const mira = yield* card(api, "Mira", { name: "Mira", first_mes: "Hello." })
      const tobin = yield* card(api, "Tobin", { name: "Tobin", first_mes: "Hey." })
      const sam = yield* card(api, "Sam", { name: "Sam" }, true)
      const start = (cards: ReadonlyArray<typeof ana>) =>
        api.StartChat({
          cards,
          persona: sam,
          greeting: null,
          first: { _tag: "Send", content: "Hello.", speakerEntityId: sam }
        })

      const first = yield* start([ana, mira])
      yield* Effect.sleep("5 millis")
      const second = yield* start([ana, mira])
      yield* Effect.sleep("5 millis")
      // One character is no group; a third member is another group.
      yield* start([mira])
      const trio = yield* start([ana, mira, tobin])
      const binned = yield* start([ana, mira])
      yield* api.DeleteChat({ chatId: binned.chat.id })

      const groups = yield* api.ListChatGroups()
      assert.deepStrictEqual(
        groups.map((group) => [group.name, group.chats]),
        [
          // A chat made here is titled by everyone in it, the persona too.
          ["Ana & Mira & Tobin & Sam", 1],
          ["Ana & Mira & Sam", 2]
        ]
      )
      const pair = groups[1]!
      // The persona the user plays isn't a member; the latest chat is the one to continue.
      assert.deepStrictEqual(
        pair.members.map((member) => member.name),
        ["Ana", "Mira"]
      )
      assert.strictEqual(pair.latestChatId, second.chat.id)
      assert.strictEqual(pair.lastMessageAt, second.chat.lastMessageAt)

      const listed = yield* api.ListGroupChats({ chatId: first.chat.id })
      assert.deepStrictEqual(
        listed.chats.map((chat) => chat.id),
        [second.chat.id, first.chat.id]
      )
      assert.strictEqual(listed.group.name, "Ana & Mira & Sam")
      assert.strictEqual((yield* api.ListGroupChats({ chatId: trio.chat.id })).chats.length, 1)
      const single = (yield* api.ListChats({ limit: 50, before: null, entityId: mira })).find(
        (chat) => ![first, second, trio].some((made) => made.chat.id === chat.id)
      )!
      const refused = yield* Effect.flip(api.ListGroupChats({ chatId: single.id }))
      assert.strictEqual(refused._tag, "NotFound")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )

  it.live(
    "finds a realistic ST folder's groups by their names, among its one-character chats",
    () =>
      Effect.gen(function* () {
        const root = tempDir("st-groups")
        writeRealisticStFolder(root)
        const files = new Map(
          readdirSync(root, { recursive: true, withFileTypes: true })
            .filter((entry) => entry.isFile())
            .map((entry) => {
              const path = join(entry.parentPath, entry.name)
              return [relative(root, path), new Uint8Array(readFileSync(path))] as const
            })
        )
        yield* importStFolder(files)
        const groups = yield* (yield* client()).ListChatGroups()
        assert.deepStrictEqual(
          Object.fromEntries(groups.map((group) => [group.name, [group.chats, group.members.length]])),
          {
            "The Lantern Inn": [3, 4],
            "Station Kepler": [2, 3],
            "Masquerade at Corvina Hall": [1, 5]
          }
        )
      }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none))),
    120_000
  )

  it.live("takes a chat's own model and preset off, from a position on", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const mira = yield* card(api, "Mira", { name: "Mira", first_mes: "Hello." })
      const started = yield* api.StartChat({
        cards: [mira],
        persona: null,
        greeting: null,
        first: { _tag: "Send", content: "Hello.", speakerEntityId: null }
      })
      const chatId = started.chat.id
      const at = started.entry.slotId
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: "Local",
          baseUrl: "http://127.0.0.1:9/v1",
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        }
      })
      const model = yield* api.AddUserModel({ connectionId: connection.id, key: "local-model", overrides: {} })
      const me = yield* api.Whoami()
      const preset = yield* (yield* Writer).CreateEntity({
        userId: me.id as UserId,
        kind: "preset",
        label: "Long context",
        subtitle: "",
        doc: presetDoc() as never,
        schemaVersion: 1,
        origin: "user",
        sourcePath: null
      })
      yield* api.ChangeCast({
        chatId,
        slotId: at,
        change: { _tag: "Model", connection: connection.id, model: model.id }
      })
      const bound = yield* api.ChangeCast({
        chatId,
        slotId: at,
        change: { _tag: "Preset", ref: preset.ref.id }
      })
      assert.strictEqual(bound.model?.model, model.id)
      assert.strictEqual(bound.preset, preset.ref.id)

      yield* api.ChangeCast({ chatId, slotId: at, change: { _tag: "DefaultModel" } })
      const cleared = yield* api.ChangeCast({ chatId, slotId: at, change: { _tag: "DefaultPreset" } })
      assert.isNull(cleared.model)
      assert.isNull(cleared.preset)
      // Before those events, at the chat's start, nothing was ever set.
      const before = yield* api.GetCast({ chatId, slotId: null })
      assert.isNull(before.model)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )
})

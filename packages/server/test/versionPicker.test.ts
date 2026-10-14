// Versions on every message and the version picker (DESIGN §3.1): a model version of a turn
// the user wrote speaks as that turn's speaker; a version can be starred and hidden from
// the arrows; "Regenerate with…" records the model chosen. Cross-user access is in the
// isolation matrix.
import { assert, describe, it } from "@effect/vitest"
import type { Chat, EntityId, SlotId } from "@rp/shared/chat.ts"
import type { ChatEvent } from "@rp/shared/chatApi.ts"
import type { UserId } from "@rp/shared/domain.ts"
import type { CardDoc } from "@rp/shared/docs/card.ts"
import { Effect, Stream } from "effect"
import { Writer } from "../src/db/Database.ts"
import * as FakeGenerator from "../src/dev/fakeGenerator.ts"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"
import { cardDoc } from "./support/docs.ts"

type Api = Effect.Success<ReturnType<typeof client>>

const fast = FakeGenerator.layer({ tokensPerSecond: 3000, tokens: 60 })

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

/** Polls until `check` holds, for at most 10 s. */
const eventually = <E>(check: Effect.Effect<boolean, E>) =>
  Effect.gen(function* () {
    const deadline = Date.now() + 10_000
    while (!(yield* check)) {
      if (Date.now() > deadline) return yield* Effect.die(new Error("timed out waiting"))
      yield* Effect.sleep(20)
    }
  })

/** Until nothing in the slot is generating. */
const settled = (api: Api, slotId: SlotId) =>
  eventually(Effect.map(api.ListVersions({ slotId }), (list) => list.every((v) => v.status !== "generating")))

const subscribe = (api: Api, chatId: Chat["id"]) =>
  Effect.gen(function* () {
    const events: Array<ChatEvent> = []
    yield* api.SubscribeChat({ chatId }).pipe(
      Stream.runForEach((batch) => Effect.sync(() => events.push(...batch))),
      Effect.forkScoped
    )
    yield* eventually(Effect.sync(() => events.length > 0))
    return events
  })

/** A chat with Mira, the user playing Ana, whose first message is Ana's "Hello.". */
const started = (api: Api) =>
  Effect.gen(function* () {
    const miraId = yield* card(api, "Mira", { name: "Mira", first_mes: "The bell rings." })
    const anaId = yield* card(api, "Ana", { name: "Ana" }, true)
    const chat = yield* api.StartChat({
      cards: [miraId],
      persona: anaId,
      greeting: 0,
      first: { _tag: "Send", content: "Hello.", speakerEntityId: anaId }
    })
    return { ...chat, miraId, anaId }
  })

describe("version picker", () => {
  it.live("a message the user wrote gets a model version, written as its speaker", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const { chat, entry: mine, anaId } = yield* started(api)
      const swipe = yield* api.Regenerate({ slotId: mine.slotId, expectedRowVersion: mine.rowVersion })
      assert.strictEqual(swipe.versionCount, 2)
      assert.strictEqual(swipe.version.writer, "model")
      assert.strictEqual(swipe.version.speakerEntityId, anaId)
      assert.strictEqual(swipe.side, "user")
      yield* settled(api, mine.slotId)

      // A message naming no one, on the user's side, is written as the card the user plays.
      const unnamed = yield* posted(
        api.SendMessage({ chatId: chat.id, parentSlotId: mine.slotId, branch: true, content: "Hm." })
      )
      assert.isNull(unnamed.entry.version.speakerEntityId)
      const again = yield* api.Regenerate({
        slotId: unnamed.entry.slotId,
        expectedRowVersion: unnamed.entry.rowVersion
      })
      assert.strictEqual(again.version.speakerEntityId, anaId as EntityId)
      yield* settled(api, unnamed.entry.slotId)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), fast)))
  )

  it.live("a version is starred and hidden, each on its own, and every tab hears of it", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const { chat, entry: mine } = yield* started(api)
      const events = yield* subscribe(api, chat.id)
      const versionId = mine.version.id
      const starred = yield* api.SetVersionFlags({ versionId, starred: true })
      assert.isTrue(starred.starred)
      assert.isFalse(starred.hidden)
      const hidden = yield* api.SetVersionFlags({ versionId, hidden: true })
      assert.isTrue(hidden.starred, "hiding leaves the star")
      assert.isTrue(hidden.hidden)
      const [listed] = yield* api.ListVersions({ slotId: mine.slotId })
      assert.isTrue(listed!.starred && listed!.hidden)
      yield* eventually(
        Effect.sync(() => events.some((e) => e._tag === "Version" && e.version.id === versionId && e.version.hidden))
      )
      const unstarred = yield* api.SetVersionFlags({ versionId, starred: false, hidden: false })
      assert.isFalse(unstarred.starred || unstarred.hidden)
      // Nothing the model is sent changes: the message is still in context.
      const [, entry] = (yield* api.ReadPath({
        chatId: chat.id,
        leafSlotId: mine.slotId,
        range: { _tag: "Bottom" },
        limit: 5
      })).entries
      assert.isTrue(entry!.inContext)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), fast)))
  )

  it.live("Regenerate with… records the model chosen on the new version", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const { entry: mine } = yield* started(api)
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: "Upstream",
          baseUrl: "http://127.0.0.1:9/v1",
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        },
        apiKey: "sk-test-key"
      })
      const model = yield* api.AddUserModel({ connectionId: connection.id, key: "big-model", overrides: {} })
      const swipe = yield* api.Regenerate({
        slotId: mine.slotId,
        expectedRowVersion: mine.rowVersion,
        model: { connection: connection.id, model: model.id }
      })
      assert.strictEqual(swipe.version.model, "Upstream · big-model")
      yield* settled(api, mine.slotId)
      const versions = yield* api.ListVersions({ slotId: mine.slotId })
      assert.deepStrictEqual(
        versions.map((v) => v.model),
        [null, "Upstream · big-model"]
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), fast)))
  )
})

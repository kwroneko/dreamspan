// Choosing the summary model (audit item 067): the account's in Settings → Chats and a chat's
// own from a position on, each taken off again; a deleted model reads as none. Synthetic
// cards and a local connection that is never called.
import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { Generator } from "../src/chat/Generator.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"

it.live("the account's and a chat's summary model are set and taken off", () =>
  Effect.gen(function* () {
    const api = yield* client()
    const local = (name: string) =>
      api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name,
          baseUrl: "http://127.0.0.1:9/v1",
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        }
      })
    const connection = yield* local("Local")
    const spare = yield* local("Spare")
    const cheap = yield* api.AddUserModel({ connectionId: spare.id, key: "cheap-model", overrides: {} })
    const other = yield* api.AddUserModel({ connectionId: connection.id, key: "other-model", overrides: {} })
    const choice = (on: { id: typeof connection.id }, id: typeof cheap.id) => ({ connection: on.id, model: id })

    // The account's, beside the fallback, which stays as it was.
    yield* api.ChangeGenerationDefaults({ change: { fallback: choice(connection, other.id) } })
    const set = yield* api.ChangeGenerationDefaults({ change: { summarizer: choice(spare, cheap.id) } })
    assert.deepStrictEqual(set.lcm?.summarizer, choice(spare, cheap.id))
    assert.deepStrictEqual(set.lcm?.fallback, choice(connection, other.id))

    // A chat's own, from a position on; the chat's model is untouched.
    const mira = yield* api.CreateCard({ label: "Mira", name: "Mira" })
    const chat = yield* api.CreateChat({ title: "Summary model" })
    yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: mira.entityId } })
    const own = yield* api.ChangeCast({
      chatId: chat.id,
      slotId: null,
      change: { _tag: "SummaryModel", model: choice(connection, other.id) }
    })
    assert.deepStrictEqual(own.summaryModel, choice(connection, other.id))
    assert.isNull(own.model)
    const followed = yield* api.ChangeCast({
      chatId: chat.id,
      slotId: null,
      change: { _tag: "SummaryModel", model: null }
    })
    assert.isUndefined(followed.summaryModel)

    // A deleted model reads as none; taking the account's off leaves the fallback.
    yield* api.DeleteConnection({ connectionId: spare.id })
    assert.isUndefined((yield* api.GetGenerationDefaults()).lcm?.summarizer)
    const cleared = yield* api.ChangeGenerationDefaults({ change: { summarizer: null } })
    assert.isUndefined(cleared.lcm?.summarizer)
    assert.deepStrictEqual(cleared.lcm?.fallback, choice(connection, other.id))
  }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
)

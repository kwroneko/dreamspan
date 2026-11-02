// Token counts with the chat model's own tokenizer (owner, 2026-11-02; ARCHITECTURE §6 "Text
// tokens"): OpenAI's models counted locally in the format worker, Claude through Anthropic's
// counting endpoint (a mock here), cached per model and text, and an approximation that says so
// when there's no model, no tokenizer for it, or its count fails. Synthetic text only.
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { type Recorded, startMockProvider } from "./support/mockProvider.ts"
import type { ServerResponse } from "node:http"

type Api = Effect.Success<ReturnType<typeof client>>

/** A connection and model of `kind`, made the model chats use. */
const useModel = (api: Api, kind: string, baseUrl: string, key: string) =>
  Effect.gen(function* () {
    const connection = yield* api.CreateConnection({
      kind,
      settings: { name: kind, baseUrl, compat: {}, cacheTtlS: null, maxConcurrent: null, presetOverrideRefId: null },
      apiKey: "synthetic-key"
    })
    const model = yield* api.AddUserModel({ connectionId: connection.id, key, overrides: {} })
    const defaults = yield* api.GetGenerationDefaults()
    yield* api.SetGenerationDefaults({
      defaults: { ...defaults, model: { connection: connection.id, model: model.id } }
    })
  })

const mock = (handler: (request: Recorded, res: ServerResponse) => void) =>
  Effect.acquireRelease(
    Effect.promise(() => startMockProvider(handler)),
    (m) => Effect.promise(() => m.close())
  )

/** Anthropic's count, made up: a message's framing is 7 tokens, a text one per word. */
const anthropicCount = (request: Recorded, res: ServerResponse) => {
  const messages = request.body?.messages as ReadonlyArray<{ content: string }>
  const words = messages[0]!.content.split(/\s+/).filter(Boolean).length
  res.writeHead(200, { "content-type": "application/json" })
  res.end(JSON.stringify({ input_tokens: 7 + words }))
}

describe("text token counts", () => {
  it.live("with no model chosen: o200k_base, saying it's an approximation", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const counted = yield* api.CountTokens({ texts: ["Hello world", ""] })
      assert.deepStrictEqual(counted.counts, [2, 0])
      assert.isFalse(counted.tokenizer.exact)
      assert.include(counted.tokenizer.label, "o200k_base")
      assert.include(counted.tokenizer.note ?? "", "No model is chosen")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("an OpenAI model's own encoding, on any host: here OpenRouter's openai/gpt-4o", () =>
    Effect.gen(function* () {
      const provider = yield* mock((_request, res) => res.writeHead(500).end())
      const api = yield* client()
      yield* useModel(api, "openrouter", `${provider.url}/api/v1`, "openai/gpt-4o")
      const counted = yield* api.CountTokens({ texts: ["Hello world", "The lamp is lit."] })
      assert.deepStrictEqual(counted.counts, [2, 5])
      assert.isTrue(counted.tokenizer.exact)
      assert.strictEqual(counted.tokenizer.id, "openai-encodings")
      assert.include(counted.tokenizer.label, "openai/gpt-4o's own tokenizer")
      // Counted here: the provider wasn't asked.
      assert.lengthOf(provider.requests(), 0)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("Claude through Anthropic's counting endpoint, each text once, framing taken out", () =>
    Effect.gen(function* () {
      const provider = yield* mock(anthropicCount)
      const api = yield* client()
      yield* useModel(api, "anthropic", provider.url, "claude-synthetic")
      const counted = yield* api.CountTokens({ texts: ["one two three", "", "four"] })
      // A text's count less a one-token text's, plus one: the framing drops out.
      assert.deepStrictEqual(counted.counts, [3, 0, 1])
      assert.strictEqual(counted.tokenizer.id, "anthropic-count-tokens")
      assert.isTrue(counted.tokenizer.exact)
      const asked = provider.requests().filter((r) => r.path === "/v1/messages/count_tokens")
      assert.lengthOf(asked, 3)
      assert.strictEqual(asked[0]!.headers["x-api-key"], "synthetic-key")
      // Typing in one field asks again only for that field's text.
      const again = yield* api.CountTokens({ texts: ["one two three", "four five"] })
      assert.deepStrictEqual(again.counts, [3, 2])
      assert.lengthOf(
        provider.requests().filter((r) => r.path === "/v1/messages/count_tokens"),
        asked.length + 2
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("a failed count falls back to o200k_base and says why; DeepSeek has no tokenizer here", () =>
    Effect.gen(function* () {
      const provider = yield* mock((_request, res) => res.writeHead(429).end("slow down"))
      const api = yield* client()
      yield* useModel(api, "anthropic", provider.url, "claude-synthetic")
      const failed = yield* api.CountTokens({ texts: ["Hello world"] })
      assert.deepStrictEqual(failed.counts, [2])
      assert.isFalse(failed.tokenizer.exact)
      assert.include(failed.tokenizer.note ?? "", "claude-synthetic's tokenizer failed")
      // It rests: the next count doesn't ask the provider again.
      const asked = provider.requests().length
      yield* api.CountTokens({ texts: ["Hello again"] })
      assert.lengthOf(provider.requests(), asked)

      yield* useModel(api, "deepseek", provider.url, "deepseek-chat")
      const none = yield* api.CountTokens({ texts: ["Hello world"] })
      assert.isFalse(none.tokenizer.exact)
      assert.include(none.tokenizer.note ?? "", "no tokenizer for deepseek-chat")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )
})

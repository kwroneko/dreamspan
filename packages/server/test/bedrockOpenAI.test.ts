// OpenAI's models on AWS Bedrock (providers/bedrockOpenAI.ts) through a mock Bedrock endpoint, in
// the shapes AWS documents (inference-responses-api.html, prompt-caching.html): the address, both
// kinds of auth, the explicit cache markers on GPT-5.6 and later only, the cache key, usage and
// errors. Nothing here has reached a real Bedrock account.
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { signV4 } from "../src/providers/bedrock.ts"
import { bedrockOpenAIModels } from "../src/providers/bedrockOpenAI.ts"
import { bestEffortCache, documentedCacheMinimum } from "../src/providers/cachePolicy.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { generateReply } from "./support/generation.ts"
import { completionChunks, sse, startMockProvider, type Handler, type Recorded } from "./support/mockProvider.ts"

const resource = (handler: Handler) =>
  Effect.acquireRelease(
    Effect.promise(() => startMockProvider(handler)),
    (m) => Effect.promise(() => m.close())
  )

const MODEL = "us.openai.gpt-5.6-luna"

const responsesReply =
  (usage: Record<string, unknown> = { input_tokens: 12, output_tokens: 5 }): Handler =>
  (_req, res) =>
    sse(res, [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "message", id: "msg_1", role: "assistant", content: [] }
      },
      { type: "response.output_text.delta", output_index: 0, delta: "The tide is out." },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "message",
          id: "msg_1",
          role: "assistant",
          content: [{ type: "output_text", text: "The tide is out." }]
        }
      },
      {
        type: "response.completed",
        response: { id: "r1", status: "completed", model: MODEL, output: [], usage }
      }
    ])

const header = (req: Recorded, name: string) => {
  const value = req.headers[name]
  return Array.isArray(value) ? value.join(",") : value
}

const breakpoints = (body: Record<string, unknown>) =>
  JSON.stringify(body).split('"prompt_cache_breakpoint"').length - 1

/** A long card, so the history is past the 1,024-token floor a marker needs. */
const long = { description: "Mira keeps the lighthouse log. ".repeat(400) }

describe("OpenAI on Bedrock", () => {
  it("lists closed GPT models by inference profile, and GPT OSS on Chat Completions only", () => {
    const keys = [
      "openai.gpt-5.6-luna",
      "us.openai.gpt-5.6-luna",
      "global.openai.gpt-6-sol",
      "openai.gpt-oss-120b-1:0",
      "us-gov.openai.gpt-oss-20b-1:0",
      "us.anthropic.claude-haiku-4-5-20251001-v1:0"
    ]
    assert.deepEqual(bedrockOpenAIModels(keys, true), ["us.openai.gpt-5.6-luna", "global.openai.gpt-6-sol"])
    assert.deepEqual(bedrockOpenAIModels(keys, false), [
      "us.openai.gpt-5.6-luna",
      "global.openai.gpt-6-sol",
      "openai.gpt-oss-120b-1:0",
      "us-gov.openai.gpt-oss-20b-1:0"
    ])
  })

  it("documents a 1,024-token floor, and a best-effort cache before GPT-5.6 and on Chat Completions", () => {
    const model = (id: string, api: string) => ({ model: id, provider: "amazon-bedrock", api })
    assert.strictEqual(documentedCacheMinimum(model(MODEL, "openai-responses")), 1024)
    assert.isFalse(bestEffortCache(model(MODEL, "openai-responses")))
    assert.isTrue(bestEffortCache(model(MODEL, "openai-completions")))
    assert.isTrue(bestEffortCache(model("global.openai.gpt-5.5", "openai-responses")))
  })

  it.live("sends OpenAI's Responses request to Bedrock's address with a Bedrock API key and cache markers", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* resource(
        responsesReply({
          input_tokens: 3000,
          output_tokens: 5,
          input_tokens_details: { cached_tokens: 2000, cache_write_tokens: 900 }
        })
      )
      const api = yield* client()
      const { chat, version } = yield* generateReply(api, {
        connection: {
          provider: "openai-bedrock",
          kind: "openai-responses-bedrock",
          baseUrl: `${mock.url}/openai/v1`,
          apiKey: "bedrock-api-key-synthetic"
        },
        modelKey: MODEL,
        model: {},
        mira: long
      })
      assert.strictEqual(version.status, "complete", JSON.stringify(version.error))
      assert.include(version.content, "The tide is out.")
      const sent = mock.requests().at(-1)!
      assert.strictEqual(sent.path, "/openai/v1/responses")
      assert.strictEqual(header(sent, "authorization"), "Bearer bedrock-api-key-synthetic")
      assert.isUndefined(header(sent, "x-stainless-lang"))
      const body = sent.body!
      assert.strictEqual(body.model, MODEL)
      assert.strictEqual(body.prompt_cache_key, chat.id)
      const marks = breakpoints(body)
      assert.isAtLeast(marks, 1)
      assert.isAtMost(marks, 3, "one of Bedrock's four writes is left for the automatic breakpoint")
      assert.include(JSON.stringify(body), '"prompt_cache_breakpoint":{"mode":"explicit"}')
      const ledger = yield* api.ListLlmRequests({ limit: 5, before: null })
      const request = ledger.find((r) => r.versionId === version.id)!
      assert.strictEqual(request.provider, "amazon-bedrock")
      assert.strictEqual(request.counts.cacheRead, 2000)
      assert.strictEqual(request.counts.cacheWrite, 900)
      assert.notInclude(JSON.stringify(ledger), "bedrock-api-key-synthetic")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("signs with an AWS access key for the connection's region", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* resource(responsesReply())
      const api = yield* client()
      const secret = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY"
      const { version } = yield* generateReply(api, {
        connection: {
          provider: "openai-bedrock",
          kind: "openai-responses-bedrock",
          baseUrl: `${mock.url}/openai/v1`,
          apiKey: `AKIDEXAMPLE:${secret}`,
          providerSettings: { auth: "aws-sigv4", region: "us-west-2" }
        },
        modelKey: MODEL,
        model: {}
      })
      assert.strictEqual(version.status, "complete", JSON.stringify(version.error))
      const sent = mock.requests().at(-1)!
      const date = header(sent, "x-amz-date")!
      const expected = signV4({
        method: "POST",
        url: new URL(`${mock.url}${sent.path}`),
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sent.body),
        credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: secret },
        region: "us-west-2",
        service: "bedrock",
        now: new Date(
          `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`
        )
      })
      assert.strictEqual(header(sent, "authorization"), expected.authorization)
      assert.include(header(sent, "authorization")!, "/us-west-2/bedrock/aws4_request")
      assert.notInclude(JSON.stringify(sent.headers), secret)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("sends no markers to GPT-5.5 and earlier, which Bedrock caches automatically", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* resource(responsesReply())
      const api = yield* client()
      const { version } = yield* generateReply(api, {
        connection: {
          provider: "openai-bedrock",
          kind: "openai-responses-bedrock",
          baseUrl: `${mock.url}/openai/v1`,
          apiKey: "bedrock-api-key-synthetic"
        },
        modelKey: "global.openai.gpt-5.5",
        model: {},
        mira: long
      })
      assert.strictEqual(version.status, "complete", JSON.stringify(version.error))
      assert.strictEqual(breakpoints(mock.requests().at(-1)!.body!), 0)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("sends no markers on Chat Completions", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* resource((_req, res) =>
        sse(res, completionChunks(["The tide is out."], { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }))
      )
      const api = yield* client()
      const { version } = yield* generateReply(api, {
        connection: {
          provider: "openai-bedrock",
          kind: "openai-chat-bedrock",
          baseUrl: `${mock.url}/openai/v1`,
          apiKey: "bedrock-api-key-synthetic"
        },
        modelKey: "openai.gpt-oss-120b-1:0",
        model: {},
        mira: long
      })
      assert.strictEqual(version.status, "complete", JSON.stringify(version.error))
      const sent = mock.requests().at(-1)!
      assert.strictEqual(sent.path, "/openai/v1/chat/completions")
      assert.strictEqual(breakpoints(sent.body!), 0)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("reads AWS's errors as OpenAI's", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* resource((_req, res) => {
        res.writeHead(403, {
          "content-type": "application/json",
          "x-amzn-errortype": "AccessDeniedException:http://internal.amazon.com/coral/com.amazon.bedrock/"
        })
        res.end(JSON.stringify({ message: "You don't have access to the model with the specified model ID." }))
      })
      const api = yield* client()
      const { version } = yield* generateReply(api, {
        connection: {
          provider: "openai-bedrock",
          kind: "openai-responses-bedrock",
          baseUrl: `${mock.url}/openai/v1`,
          apiKey: "bedrock-api-key-synthetic"
        },
        modelKey: MODEL,
        model: {}
      })
      assert.strictEqual(version.status, "failed")
      assert.strictEqual(version.error?.class, "auth")
      assert.include(version.error?.message, "access to the model")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})

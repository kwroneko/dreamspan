// Real SDK payloads, HTTP and worker ledger; synthetic requests only.
import { assert, it } from "@effect/vitest"
import { Effect, Fiber, Layer, Stream } from "effect"
import type { ServerResponse } from "node:http"
import type { AssembledRequest, ModelInput } from "../src/assembler/types.ts"
import { providerRequest } from "../src/assembler/wire.ts"
import * as Database from "../src/db/Database.ts"
import * as Network from "../src/net/Network.ts"
import * as Builtins from "../src/providers/builtins.ts"
import * as Providers from "../src/providers/Providers.ts"
import { ProviderRegistry } from "../src/providers/registry.ts"
import { makeSecrets, Secrets } from "../src/secrets.ts"
import { eventually } from "./support/generation.ts"
import { anthropicSse, sse, startMockProvider } from "./support/mockProvider.ts"
import { tempDir } from "./support/tempDir.ts"

const layer = () =>
  Providers.layer().pipe(
    Layer.provideMerge(Network.layer),
    Layer.provideMerge(Builtins.layer),
    Layer.provideMerge(
      Database.layer({ dataDir: tempDir("cache-identity"), readers: 1, allowNetworkFs: false, workers: "source" })
    ),
    Layer.provideMerge(Layer.succeed(Secrets)(makeSecrets("synthetic cache identity secret")))
  )
const request: AssembledRequest = {
  messages: [
    { role: "system", content: "Synthetic harbor instructions. ".repeat(200) },
    { role: "user", content: "Reply." }
  ],
  prefill: null,
  useSystemPrompt: true,
  names: { user: "", char: "", group: [] },
  breakpoints: [{ message: 0, reason: "prefix" }],
  samplers: {
    temperature: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
    top_p: 1,
    top_k: 0,
    top_a: 0,
    min_p: 0,
    repetition_penalty: 1,
    max_tokens: 32,
    seed: -1
  }
}
const setup = (kind: string) =>
  Effect.gen(function* () {
    const pending: Array<{ body: Record<string, unknown>; res: ServerResponse }> = []
    const server = yield* Effect.acquireRelease(
      Effect.promise(() =>
        startMockProvider((r, res) => {
          pending.push({ body: r.body!, res })
        })
      ),
      (server) => Effect.promise(() => server.close())
    )
    const providers = yield* Providers.Providers
    const reader = yield* Database.Reader
    const writer = yield* Database.Writer
    const userId = (yield* writer.EnsureUser({ handle: "synthetic-cache", displayName: "Cache" })).id
    const connection = yield* providers.createConnection({
      userId,
      kind,
      settings: {
        name: "Synthetic",
        baseUrl: server.url,
        compat: {},
        cacheTtlS: 300,
        maxConcurrent: null,
        presetOverrideRefId: null
      },
      apiKey: "synthetic-key"
    })
    const cacheBreakpoints = kind === "anthropic" ? "explicit" : "auto"
    const model = yield* writer.AddUserModel({
      userId,
      connectionId: connection.id,
      key: "mock-model",
      overrides: { cacheBreakpoints }
    })
    const api = (yield* ProviderRegistry).kinds.get(kind)!.api
    const input: ModelInput = {
      connectionId: connection.id,
      modelId: model.id,
      kind,
      api,
      key: model.key,
      cacheBreakpoints,
      cacheTtlS: 300,
      prefill: "none",
      context: null,
      presetOverride: null
    }
    const wire = providerRequest(request, input)
    const start = (extra: Providers.StreamRequest["options"] = {}) =>
      Effect.gen(function* () {
        const events: Providers.ProviderEvent[] = []
        const fiber = yield* providers
          .stream({
            userId,
            connectionId: connection.id,
            modelId: model.id,
            context: wire.context,
            inspection: { request, model: input },
            options: { payload: wire.payload, breakpoints: wire.breakpoints, ...extra },
            attribution: { purpose: "generation" }
          })
          .pipe(
            Stream.runForEach((e) =>
              Effect.sync(() => {
                events.push(e)
              })
            ),
            Effect.forkScoped
          )
        return { events, fiber }
      })
    return { pending, start, reader, userId }
  })
const held = (events: Providers.ProviderEvent[]) => events.some((e) => e.type === "waiting-cache" && e.waiting)
const tools = (name: string) => [
  { name, description: "Synthetic tool", input_schema: { type: "object", properties: {} } }
]
const cases: Array<{
  name: string
  kind: string
  a: Providers.StreamRequest["options"]
  b: Providers.StreamRequest["options"]
}> = [
  {
    name: "different tool definitions",
    kind: "anthropic",
    a: { payload: { tools: tools("first_tool") } },
    b: { payload: { tools: tools("second_tool") } }
  },
  {
    name: "different structured prefix blocks",
    kind: "anthropic",
    a: {
      payload: {
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/png", data: "c3ludGhldGljLWE=" } },
              { type: "text", text: "Reply.", cache_control: { type: "ephemeral" } }
            ]
          }
        ]
      }
    },
    b: {
      payload: {
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/png", data: "c3ludGhldGljLWI=" } },
              { type: "text", text: "Reply.", cache_control: { type: "ephemeral" } }
            ]
          }
        ]
      }
    }
  },
  {
    name: "different Responses session routes",
    kind: "openai-responses",
    a: { sessionId: "chat-one" },
    b: { sessionId: "chat-two" }
  },
  {
    name: "different final routing overrides",
    kind: "openai-responses",
    a: { sessionId: "same-session", payload: { prompt_cache_key: "route-one" } },
    b: { sessionId: "same-session", payload: { prompt_cache_key: "route-two" } }
  },
  { name: "disabled cache retention", kind: "anthropic", a: { cacheRetention: "none" }, b: { cacheRetention: "none" } },
  {
    name: "explicit payload without a breakpoint",
    kind: "anthropic",
    a: {
      payload: {
        system: [{ type: "text", text: request.messages[0]!.content }],
        messages: [{ role: "user", content: "Reply." }]
      }
    },
    b: {
      payload: {
        system: [{ type: "text", text: request.messages[0]!.content }],
        messages: [{ role: "user", content: "Reply." }]
      }
    }
  }
]
for (const c of cases)
  it.live(`${c.name} starts independently`, () =>
    Effect.gen(function* () {
      const f = yield* setup(c.kind)
      const a = yield* f.start(c.a)
      yield* eventually(() => f.pending.length === 1)
      const b = yield* f.start(c.b)
      yield* eventually(() => f.pending.length === 2 || held(b.events))
      assert.strictEqual(f.pending.length, 2, "the leader cannot warm this follower")
      assert.isFalse(held(b.events))
      if (c.kind === "openai-responses") {
        assert.strictEqual(f.pending[0]!.body.prompt_cache_key, c.a?.payload?.prompt_cache_key ?? c.a?.sessionId)
        assert.strictEqual(f.pending[1]!.body.prompt_cache_key, c.b?.payload?.prompt_cache_key ?? c.b?.sessionId)
      }
      if (c.name.includes("retention") || c.name.includes("without"))
        assert.isFalse(JSON.stringify(f.pending[0]!.body).includes("cache_control"))
      yield* Fiber.interrupt(b.fiber)
      yield* Fiber.interrupt(a.fiber)
    }).pipe(Effect.scoped, Effect.provide(layer()))
  )

// Warmth must use the same identity as the in-flight gate, even for callers without a rollout.
const finish = (kind: string, res: ServerResponse) => {
  if (kind === "anthropic")
    anthropicSse(res, [
      {
        type: "message_start",
        message: {
          id: "synthetic",
          type: "message",
          role: "assistant",
          content: [],
          model: "mock-model",
          usage: { input_tokens: 100, output_tokens: 0 }
        }
      },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } },
      { type: "message_stop" }
    ])
  else
    sse(
      res,
      [
        {
          type: "response.completed",
          response: {
            id: "synthetic",
            status: "completed",
            model: "mock-model",
            output: [],
            usage: { input_tokens: 100, output_tokens: 0, total_tokens: 100 }
          }
        }
      ],
      { done: false }
    )
}
for (const c of cases.slice(0, 4))
  it.live(`${c.name} also separates historical warmth`, () =>
    Effect.gen(function* () {
      const f = yield* setup(c.kind)
      const prime = yield* f.start(c.a)
      yield* eventually(() => f.pending.length === 1)
      finish(c.kind, f.pending[0]!.res)
      yield* Fiber.join(prime.fiber)
      assert.isTrue(prime.events.some((e) => e.type === "done"))

      const warmA = yield* f.start(c.a)
      yield* eventually(() => f.pending.length === 2)
      const warmB = yield* f.start(c.a)
      yield* eventually(() => f.pending.length === 3 || held(warmB.events))
      assert.strictEqual(f.pending.length, 3, "identical tools, content and routing are already covered")
      assert.isFalse(held(warmB.events))
      yield* Fiber.interrupt(warmA.fiber)
      yield* Fiber.interrupt(warmB.fiber)

      const cold = yield* f.start(c.b)
      yield* eventually(() => f.pending.length === 4)
      const follower = yield* f.start(c.b)
      yield* eventually(() => f.pending.length === 5 || held(follower.events))
      assert.strictEqual(f.pending.length, 4, "the old identity cannot warm a different request")
      assert.isTrue(held(follower.events))
      finish(c.kind, f.pending[3]!.res)
      yield* Fiber.join(cold.fiber)
      yield* eventually(() => f.pending.length === 5)
      finish(c.kind, f.pending[4]!.res)
      yield* Fiber.join(follower.fiber)
      const rows = yield* f.reader.ListLlmRequests({ userId: f.userId, limit: 10, before: null })
      assert.strictEqual(rows.filter((r) => r.cacheStagger).length, 1)
      assert.isFalse(JSON.stringify(rows).includes("first_tool"), "raw tool definitions never enter the ledger")
      assert.isFalse(JSON.stringify(rows).includes("c3ludGhldGlj"), "raw image blocks never enter the ledger")
    }).pipe(Effect.scoped, Effect.provide(layer()))
  )

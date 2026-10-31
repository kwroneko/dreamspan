// Real SDK payloads, HTTP and worker ledger; synthetic requests only.
import { assert, it } from "@effect/vitest"
import { Effect, Fiber, Layer, Stream } from "effect"
import type { IncomingHttpHeaders, ServerResponse } from "node:http"
import type { AssembledRequest, ModelInput } from "../src/assembler/types.ts"
import { assembleFixture, type AssemblyFixture } from "./support/assemblySources.ts"
import { cardDoc } from "./support/docs.ts"
import { importStPreset } from "../src/formats/preset.ts"
import { prefixChange } from "../src/assembler/warmth.ts"
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
import { testWorkers } from "./support/bundles.ts"

const layer = () =>
  Providers.layer().pipe(
    Layer.provideMerge(Network.layer),
    Layer.provideMerge(Builtins.layer),
    Layer.provideMerge(
      Database.layer({ dataDir: tempDir("cache-identity"), readers: 1, allowNetworkFs: false, ...testWorkers })
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
const setup = (
  kind: string,
  compat: Record<string, unknown> = {},
  policy: { provider?: string; modelKey?: string; cacheTtlOverride?: boolean } = {}
) =>
  Effect.gen(function* () {
    const pending: Array<{ body: Record<string, unknown>; headers: IncomingHttpHeaders; res: ServerResponse }> = []
    const server = yield* Effect.acquireRelease(
      Effect.promise(() =>
        startMockProvider((r, res) => {
          pending.push({ body: r.body!, headers: r.headers, res })
        })
      ),
      (server) => Effect.promise(() => server.close())
    )
    const registry = yield* ProviderRegistry
    if (policy.provider) yield* registry.kinds.register({ ...registry.kinds.get(kind)!, piProvider: policy.provider })
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
        compat,
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
      key: policy.modelKey ?? "mock-model",
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
      cacheTtlOverride: policy.cacheTtlOverride ?? true,
      prefill: "none",
      context: null,
      presetOverride: null
    }
    const start = (extra: Providers.StreamRequest["options"] = {}, assembled: AssembledRequest = request) =>
      Effect.gen(function* () {
        const wire = providerRequest(assembled, input)
        const events: Providers.ProviderEvent[] = []
        const fiber = yield* providers
          .stream({
            userId,
            connectionId: connection.id,
            modelId: model.id,
            context: wire.context,
            inspection: { request: assembled, model: input },
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
    return { pending, start, reader, userId, providers, connection, input }
  })
const held = (events: Providers.ProviderEvent[]) => events.some((e) => e.type === "waiting-cache" && e.waiting)
const tools = (name: string) => [
  { name, description: "Synthetic tool", input_schema: { type: "object", properties: {} } }
]
const cases: Array<{
  name: string
  assembled?: AssembledRequest
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
    assembled: { ...request, breakpoints: [{ message: 1, reason: "history" }] },
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
      const a = yield* f.start(c.a, c.assembled)
      yield* eventually(() => f.pending.length === 1)
      const b = yield* f.start(c.b, c.assembled)
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
const finish = (kind: string, res: ServerResponse, cacheRead?: number) => {
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
            usage: {
              input_tokens: 100,
              output_tokens: 0,
              total_tokens: 100,
              ...(cacheRead === undefined ? {} : { input_tokens_details: { cached_tokens: cacheRead } })
            }
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
      const prime = yield* f.start(c.a, c.assembled)
      yield* eventually(() => f.pending.length === 1)
      finish(c.kind, f.pending[0]!.res)
      yield* Fiber.join(prime.fiber)
      assert.isTrue(prime.events.some((e) => e.type === "done"))

      const warmA = yield* f.start(c.a, c.assembled)
      yield* eventually(() => f.pending.length === 2)
      const warmB = yield* f.start(c.a, c.assembled)
      yield* eventually(() => f.pending.length === 3 || held(warmB.events))
      assert.strictEqual(f.pending.length, 3, "identical tools, content and routing are already covered")
      assert.isFalse(held(warmB.events))
      yield* Fiber.interrupt(warmA.fiber)
      yield* Fiber.interrupt(warmB.fiber)

      const cold = yield* f.start(c.b, c.assembled)
      yield* eventually(() => f.pending.length === 4)
      const follower = yield* f.start(c.b, c.assembled)
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

const changedTail: AssembledRequest = {
  ...request,
  messages: [request.messages[0]!, { role: "user", content: "A different one-turn direction." }]
}

it.live("explicit trailing markers do not split a common cold reusable prefix", () =>
  Effect.gen(function* () {
    const f = yield* setup("anthropic")
    const a = yield* f.start()
    yield* eventually(() => f.pending.length === 1)
    const b = yield* f.start({}, changedTail)
    yield* eventually(() => f.pending.length === 2 || held(b.events))
    assert.strictEqual(f.pending.length, 1)
    assert.isTrue(held(b.events))
    finish("anthropic", f.pending[0]!.res)
    yield* Fiber.join(a.fiber)
    yield* eventually(() => f.pending.length === 2)
    assert.deepStrictEqual(f.pending[0]!.body.system, f.pending[1]!.body.system)
    assert.notDeepEqual(f.pending[0]!.body.messages, f.pending[1]!.body.messages)
    finish("anthropic", f.pending[1]!.res)
    yield* Fiber.join(b.fiber)
  }).pipe(Effect.scoped, Effect.provide(layer()))
)

for (const change of ["tail", "unused session"] as const)
  it.live(`a warm Anthropic reusable prefix stays warm with a changed ${change}`, () =>
    Effect.gen(function* () {
      const f = yield* setup("anthropic")
      const prime = yield* f.start({ sessionId: "chat-one" })
      yield* eventually(() => f.pending.length === 1)
      finish("anthropic", f.pending[0]!.res)
      yield* Fiber.join(prime.fiber)
      const options = { sessionId: change === "tail" ? "chat-one" : "chat-two" }
      const assembled = change === "tail" ? changedTail : request
      const a = yield* f.start(options, assembled)
      yield* eventually(() => f.pending.length === 2)
      const b = yield* f.start(options, assembled)
      yield* eventually(() => f.pending.length === 3 || held(b.events))
      assert.strictEqual(f.pending.length, 3)
      assert.isFalse(held(b.events))
      if (change === "unused session") {
        assert.deepStrictEqual(f.pending[0]!.body, f.pending[1]!.body)
        for (const p of f.pending)
          for (const header of ["x-session-affinity", "x-session-id", "session_id", "x-client-request-id"])
            assert.isUndefined(p.headers[header])
      }
      yield* Fiber.interrupt(a.fiber)
      yield* Fiber.interrupt(b.fiber)
    }).pipe(Effect.scoped, Effect.provide(layer()))
  )

it.live("Anthropic top-level automatic cache control coalesces and records warmth", () =>
  Effect.gen(function* () {
    const f = yield* setup("anthropic")
    const options = {
      payload: {
        cache_control: { type: "ephemeral" },
        system: [{ type: "text", text: request.messages[0]!.content }],
        messages: [{ role: "user", content: "Reply." }]
      }
    }
    const a = yield* f.start(options)
    yield* eventually(() => f.pending.length === 1)
    const b = yield* f.start(options)
    yield* eventually(() => f.pending.length === 2 || held(b.events))
    assert.strictEqual(f.pending.length, 1)
    assert.isTrue(held(b.events))
    assert.deepStrictEqual(f.pending[0]!.body.cache_control, { type: "ephemeral" })
    assert.notInclude(JSON.stringify(f.pending[0]!.body.system), "cache_control")
    assert.notInclude(JSON.stringify(f.pending[0]!.body.messages), "cache_control")
    finish("anthropic", f.pending[0]!.res)
    yield* Fiber.join(a.fiber)
    yield* eventually(() => f.pending.length === 2)
    finish("anthropic", f.pending[1]!.res)
    yield* Fiber.join(b.fiber)
    const warmA = yield* f.start(options)
    yield* eventually(() => f.pending.length === 3)
    const warmB = yield* f.start(options)
    yield* eventually(() => f.pending.length === 4 || held(warmB.events))
    assert.strictEqual(f.pending.length, 4, "top-level cache coverage survives the leader")
    assert.isFalse(held(warmB.events))
    yield* Fiber.interrupt(warmA.fiber)
    yield* Fiber.interrupt(warmB.fiber)
  }).pipe(Effect.scoped, Effect.provide(layer()))
)

for (const format of ["native", "openrouter"] as const)
  it.live(`actual Anthropic ${format} affinity headers separate gates and warmth`, () =>
    Effect.gen(function* () {
      const f = yield* setup("anthropic", {
        sendSessionAffinityHeaders: true,
        ...(format === "openrouter" ? { sessionAffinityFormat: "openrouter" } : {})
      })
      const a = yield* f.start({ sessionId: "chat-one" })
      yield* eventually(() => f.pending.length === 1)
      const b = yield* f.start({ sessionId: "chat-two" })
      yield* eventually(() => f.pending.length === 2 || held(b.events))
      assert.strictEqual(f.pending.length, 2)
      const header = format === "native" ? "x-session-affinity" : "x-session-id"
      assert.strictEqual(f.pending[0]!.headers[header], "chat-one")
      assert.strictEqual(f.pending[1]!.headers[header], "chat-two")
      finish("anthropic", f.pending[0]!.res)
      yield* Fiber.join(a.fiber)
      const follower = yield* f.start({ sessionId: "chat-two" })
      yield* eventually(() => held(follower.events) || f.pending.length === 3)
      assert.strictEqual(f.pending.length, 2, "chat-one's cached bytes cannot warm chat-two's route")
      assert.isTrue(held(follower.events))
      finish("anthropic", f.pending[1]!.res)
      yield* Fiber.join(b.fiber)
      yield* eventually(() => f.pending.length === 3)
      finish("anthropic", f.pending[2]!.res)
      yield* Fiber.join(follower.fiber)
    }).pipe(Effect.scoped, Effect.provide(layer()))
  )

it.live("an actual affinity header override preserves warmth across unused SDK session values", () =>
  Effect.gen(function* () {
    const f = yield* setup("anthropic", { sendSessionAffinityHeaders: true })
    yield* f.providers.setHeaders(
      f.userId,
      f.connection.id,
      { "x-session-affinity": "fixed-route" },
      f.connection.rowVersion
    )
    const prime = yield* f.start({ sessionId: "chat-one" })
    yield* eventually(() => f.pending.length === 1)
    finish("anthropic", f.pending[0]!.res)
    yield* Fiber.join(prime.fiber)
    const a = yield* f.start({ sessionId: "chat-two" })
    yield* eventually(() => f.pending.length === 2)
    const b = yield* f.start({ sessionId: "chat-three" })
    yield* eventually(() => f.pending.length === 3 || held(b.events))
    assert.strictEqual(f.pending.length, 3)
    assert.isTrue(f.pending.every((p) => p.headers["x-session-affinity"] === "fixed-route"))
    assert.isFalse(held(b.events))
    yield* Fiber.interrupt(a.fiber)
    yield* Fiber.interrupt(b.fiber)
  }).pipe(Effect.scoped, Effect.provide(layer()))
)

it.live("later explicit checkpoints remain available as historical coverage", () =>
  Effect.gen(function* () {
    const f = yield* setup("anthropic")
    const prime = yield* f.start()
    yield* eventually(() => f.pending.length === 1)
    finish("anthropic", f.pending[0]!.res)
    yield* Fiber.join(prime.fiber)
    const extended = { ...request, breakpoints: [{ message: 1, reason: "history" as const }] }
    const a = yield* f.start({}, extended)
    yield* eventually(() => f.pending.length === 2)
    const b = yield* f.start({}, extended)
    yield* eventually(() => f.pending.length === 3 || held(b.events))
    assert.strictEqual(f.pending.length, 3)
    assert.isFalse(held(b.events))
    yield* Fiber.interrupt(a.fiber)
    yield* Fiber.interrupt(b.fiber)
  }).pipe(Effect.scoped, Effect.provide(layer()))
)

for (const mode of ["documented", "unknown", "fixed-hit"] as const)
  it.live(`scheduling uses the final ${mode} cache lifetime`, () =>
    Effect.gen(function* () {
      const f = yield* setup(
        "openai-responses",
        {},
        {
          cacheTtlOverride: false,
          ...(mode === "documented" ? { modelKey: "gpt-5.6" } : {}),
          ...(mode === "fixed-hit" ? { provider: "cerebras" } : {})
        }
      )
      const prime = yield* f.start()
      yield* eventually(() => f.pending.length === 1)
      finish("openai-responses", f.pending[0]!.res, mode === "fixed-hit" ? 100 : 0)
      yield* Fiber.join(prime.fiber)
      const a = yield* f.start()
      yield* eventually(() => f.pending.length === 2)
      const b = yield* f.start()
      yield* eventually(() => f.pending.length === 3 || held(b.events))
      assert.strictEqual(f.pending.length, mode === "documented" ? 3 : 2)
      assert.strictEqual(held(b.events), mode !== "documented")
      yield* Fiber.interrupt(b.fiber)
      yield* Fiber.interrupt(a.fiber)
    }).pipe(Effect.scoped, Effect.provide(layer()))
  )

it.live("stagger hits use normalized Fireworks header counts", () =>
  Effect.gen(function* () {
    const f = yield* setup("openai-responses")
    const a = yield* f.start()
    yield* eventually(() => f.pending.length === 1)
    const b = yield* f.start()
    yield* eventually(() => held(b.events))
    finish("openai-responses", f.pending[0]!.res)
    yield* Fiber.join(a.fiber)
    yield* eventually(() => f.pending.length === 2)
    f.pending[1]!.res.setHeader("fireworks-cached-prompt-tokens", "75")
    finish("openai-responses", f.pending[1]!.res)
    yield* Fiber.join(b.fiber)
    const rows = yield* f.reader.ListLlmRequests({ userId: f.userId, limit: 10, before: null })
    const follower = rows.find((row) => row.cacheStagger !== null)!
    assert.strictEqual(follower.counts.cacheRead, 75)
    assert.isTrue(follower.cacheStagger!.hit)
  }).pipe(Effect.scoped, Effect.provide(layer()))
)

for (const layout of ["st", "concat", "swap_tail"] as const)
  it.live(`${layout}: a stepped cut starts a cold gate and subsequent swipes reuse its prefix`, () =>
    Effect.gen(function* () {
      const f = yield* setup("anthropic")
      const fixture: AssemblyFixture = {
        cards: [{ entity: "mira", doc: cardDoc("Mira") }],
        participants: ["mira"],
        model: { ...f.input, connectionRevision: 0 },
        preset: importStPreset(JSON.stringify({ openai_max_context: 400, openai_max_tokens: 40 })).document!,
        events:
          layout === "st"
            ? []
            : [{ depth: null, event: { scope: null, data: { key: "layout.cards", value: layout } } }],
        messages: []
      }
      let previous = yield* assembleFixture(fixture)
      let cut: typeof previous | undefined
      for (let count = 1; count < 60; count++) {
        const next = yield* assembleFixture({
          ...fixture,
          messages: Array.from({ length: count }, (_, i) => ({
            side: i % 2 ? "assistant" : "user",
            content: `Turn ${i}: ${"x".repeat(70)}`
          })),
          historyStart: previous.historyStart!
        })
        if (next.historyMove === "maximum") {
          cut = next
          break
        }
        previous = next
      }
      assert.isDefined(cut)
      assert.isAbove(cut!.historyStart!.depth, previous.historyStart!.depth)
      assert.match(prefixChange(previous, cut!, () => ({ label: "Message" }))!.reason, /context reached its maximum/)
      const prime = yield* f.start({}, previous.request)
      yield* eventually(() => f.pending.length === 1)
      finish("anthropic", f.pending[0]!.res)
      yield* Fiber.join(prime.fiber)
      const leader = yield* f.start({}, cut!.request)
      yield* eventually(() => f.pending.length === 2)
      const follower = yield* f.start({}, cut!.request)
      yield* eventually(() => f.pending.length === 3 || held(follower.events))
      assert.strictEqual(f.pending.length, 2, "the old history prefix cannot warm the cut")
      assert.isTrue(held(follower.events))
      finish("anthropic", f.pending[1]!.res)
      yield* Fiber.join(leader.fiber)
      yield* eventually(() => f.pending.length === 3)
      finish("anthropic", f.pending[2]!.res)
      yield* Fiber.join(follower.fiber)
      const warm = yield* f.start({}, cut!.request)
      yield* eventually(() => f.pending.length === 4)
      const concurrent = yield* f.start({}, cut!.request)
      yield* eventually(() => f.pending.length === 5 || held(concurrent.events))
      assert.strictEqual(f.pending.length, 5, "the recorded cut prefix bypasses the cold gate")
      assert.isFalse(held(warm.events) || held(concurrent.events))
      finish("anthropic", f.pending[3]!.res)
      finish("anthropic", f.pending[4]!.res)
      yield* Fiber.join(warm.fiber)
      yield* Fiber.join(concurrent.fiber)
    }).pipe(Effect.scoped, Effect.provide(layer()))
  )

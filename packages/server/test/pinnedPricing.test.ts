// A model pinned to one OpenRouter provider is priced by that provider's endpoint in OpenRouter's
// endpoint list (`GET /models/{author}/{slug}/endpoints`): parsing the documented shape, matching
// the pinned route to an endpoint, the fallback to the model's general price, and the stored list.
// Fixtures are synthetic and served by a mock; nothing here calls a live service.
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import {
  endpointsStale,
  matchEndpoints,
  type ModelEndpoints,
  type ModelUpstream,
  modelPrice,
  resolveModel,
  routedPrice
} from "@rp/shared/providers.ts"
import { endpointsPath } from "../src/providers/modelLists.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { json, startMockProvider, type Handler, type Recorded } from "./support/mockProvider.ts"

const resource = (handler: Handler) =>
  Effect.acquireRelease(
    Effect.promise(() => startMockProvider(handler)),
    (m) => Effect.promise(() => m.close())
  )

const KEY = "synthetic-lab/synthetic-flash"

/** The documented response: prices are decimal strings in USD per token. */
const endpointsBody = {
  data: {
    id: KEY,
    name: "Synthetic Flash",
    endpoints: [
      {
        name: "Together | synthetic-lab/synthetic-flash",
        model_id: KEY,
        provider_name: "Together",
        tag: "together",
        context_length: 128000,
        pricing: {
          prompt: "0.0000002",
          completion: "0.0000006",
          input_cache_read: "0.00000005",
          input_cache_write: "0"
        },
        quantization: "fp8",
        status: 0
      },
      {
        name: "DeepInfra | synthetic-lab/synthetic-flash",
        provider_name: "DeepInfra",
        tag: "deepinfra/fp8",
        context_length: 64000,
        pricing: { prompt: "0.0000001", completion: "0.0000003" }
      },
      {
        name: "DeepInfra | synthetic-lab/synthetic-flash",
        provider_name: "DeepInfra",
        tag: "deepinfra/turbo",
        context_length: 64000,
        pricing: { prompt: "0.0000004", completion: "0.0000008", discount: 0.5 }
      },
      {
        name: "Google Vertex | synthetic-lab/synthetic-flash",
        provider_name: "Google Vertex",
        tag: "google-vertex/us",
        context_length: 1000000,
        pricing: {
          prompt: "0.000001",
          completion: "0.000004",
          overrides: [
            { min_prompt_tokens: 200000, prompt: "0.000002", completion: "0.000006" },
            { utc_start: 100, utc_end: 400, prompt: "0.0000005" }
          ]
        }
      },
      { name: "Unpriced | x", provider_name: "Unpriced", tag: "unpriced", pricing: { prompt: "-1", completion: "-1" } }
    ]
  }
}

const upstreamWith = (endpoints: ModelEndpoints | undefined): ModelUpstream => ({
  price: { input: 50, output: 150 },
  ...(endpoints ? { endpoints } : {})
})

const stored = (endpoints: Array<ModelEndpoints["list"][number]>): ModelEndpoints => ({ fetchedAt: 1, list: endpoints })

const list: ModelEndpoints = stored([
  { tag: "together", name: "Together", price: { input: 0.2, output: 0.6, cacheRead: 0.05 } },
  { tag: "deepinfra/fp8", name: "DeepInfra", price: { input: 0.1, output: 0.3 } },
  { tag: "deepinfra/turbo", name: "DeepInfra", price: { input: 0.4, output: 0.8 } },
  { tag: "google-vertex/us", name: "Google Vertex", price: { input: 1, output: 4 } },
  { tag: "novita", name: "NovitaAI" }
])

describe("matching a pinned route to an endpoint", () => {
  const match = (routing: Record<string, unknown>) => matchEndpoints(list, routing).map((e) => e.tag)

  it("takes the provider by slug, in any case, from only or from order with fallbacks off", () => {
    assert.deepEqual(match({ only: ["Together"] }), ["together"])
    assert.deepEqual(match({ order: ["TOGETHER"], allow_fallbacks: false }), ["together"])
    assert.deepEqual(match({ order: ["together"] }), [])
    assert.deepEqual(match({ only: ["together", "deepinfra"] }), [])
  })

  it("a base slug matches every variant; a full slug only that endpoint", () => {
    assert.deepEqual(match({ only: ["deepinfra"] }), ["deepinfra/fp8", "deepinfra/turbo"])
    assert.deepEqual(match({ only: ["deepinfra/fp8"] }), ["deepinfra/fp8"])
    assert.deepEqual(match({ only: ["DeepInfra/Turbo"] }), ["deepinfra/turbo"])
    assert.deepEqual(match({ only: ["google-vertex"] }), ["google-vertex/us"])
  })

  it("falls back to the provider's name written as a slug", () => {
    assert.deepEqual(match({ only: ["novitaai"] }), ["novita"])
    assert.deepEqual(match({ only: ["googlevertex"] }), ["google-vertex/us"])
    assert.deepEqual(match({ only: ["Google Vertex"] }), ["google-vertex/us"])
    assert.deepEqual(match({ only: ["nobody"] }), [])
  })

  it("an ignored provider leaves the others pinned", () => {
    assert.deepEqual(match({ only: ["together", "deepinfra"], ignore: ["deepinfra"] }), ["together"])
  })
})

describe("the price a pinned model is billed by", () => {
  it("is the pinned provider's own, over the model's general price", () => {
    const upstream = upstreamWith(list)
    const routed = routedPrice(upstream, { only: ["together"] })
    assert.deepEqual(routed.price, { input: 0.2, output: 0.6, cacheRead: 0.05 })
    assert.deepEqual(routed.source, { state: "pinned", name: "Together", several: false })
    const model = resolveModel(KEY, upstream, { settings: { routing: { only: ["together"] } } })
    assert.deepEqual(model.price, { input: 0.2, output: 0.6, cacheRead: 0.05 })
    assert.strictEqual(model.priceSource?.state, "pinned")
  })

  it("is the dearest of several matching variants", () => {
    const routed = routedPrice(upstreamWith(list), { only: ["deepinfra"] })
    assert.deepEqual(routed.price, { input: 0.4, output: 0.8 })
    assert.deepEqual(routed.source, { state: "pinned", name: "DeepInfra", several: true })
  })

  it("is the general price when nothing is pinned, with no note", () => {
    const upstream = upstreamWith(list)
    assert.deepEqual(routedPrice(upstream, undefined), { price: { input: 50, output: 150 }, source: null })
    assert.deepEqual(routedPrice(upstream, { only: ["together", "deepinfra"] }).price, { input: 50, output: 150 })
    assert.isNull(routedPrice(upstream, { only: ["together", "deepinfra"] }).source)
  })

  it("falls back to the general price, saying why: unlisted, unpriced or a failed fetch", () => {
    const upstream = upstreamWith(list)
    const unlisted = routedPrice(upstream, { only: ["nobody"] })
    assert.deepEqual(unlisted.price, { input: 50, output: 150 })
    assert.deepEqual(unlisted.source, { state: "fallback", name: "Nobody", reason: "unlisted" })
    assert.strictEqual(routedPrice(upstream, { only: ["novita"] }).source?.state, "fallback")
    const failed = routedPrice(upstreamWith({ fetchedAt: 1, error: "http: 500", list: [] }), { only: ["together"] })
    assert.deepEqual(failed.price, { input: 50, output: 150 })
    assert.deepEqual(failed.source, { state: "fallback", name: "Together", reason: "failed" })
    // Not fetched yet: the general price, and nothing claimed.
    assert.deepEqual(routedPrice(upstreamWith(undefined), { only: ["together"] }), {
      price: { input: 50, output: 150 },
      source: null
    })
  })

  it("a stored model's price follows its routing as saved", () => {
    const upstream = upstreamWith(list)
    assert.deepEqual(modelPrice({ upstream, overrides: {} }), { input: 50, output: 150 })
    assert.deepEqual(modelPrice({ upstream, overrides: { settings: { routing: { only: ["google-vertex"] } } } }), {
      input: 1,
      output: 4
    })
  })

  it("a list is fetched again after a day, a failed one after ten minutes", () => {
    assert.isTrue(endpointsStale(undefined, 0))
    assert.isFalse(endpointsStale({ fetchedAt: 0, list: [] }, 23 * 3600_000))
    assert.isTrue(endpointsStale({ fetchedAt: 0, list: [] }, 25 * 3600_000))
    assert.isFalse(endpointsStale({ fetchedAt: 0, error: "x", list: [] }, 5 * 60_000))
    assert.isTrue(endpointsStale({ fetchedAt: 0, error: "x", list: [] }, 11 * 60_000))
  })
})

describe("the endpoint list's address", () => {
  it("is author and slug, and none for a variant or a malformed id", () => {
    assert.strictEqual(endpointsPath(KEY), "models/synthetic-lab/synthetic-flash/endpoints")
    assert.isNull(endpointsPath("synthetic-lab/synthetic-flash:free"))
    assert.isNull(endpointsPath("synthetic-flash"))
    assert.isNull(endpointsPath("a/b/c"))
  })
})

const connect = (url: string) =>
  Effect.gen(function* () {
    const api = yield* client()
    const connection = yield* api.CreateConnection({
      kind: "openrouter",
      settings: {
        name: "Router",
        baseUrl: `${url}/v1`,
        compat: {},
        cacheTtlS: null,
        maxConcurrent: null,
        presetOverrideRefId: null
      },
      apiKey: "sk-synthetic"
    })
    return { api, connection }
  })

describe("fetching and storing the endpoint list", () => {
  it.live("reads the documented shape with the models list's authentication and keeps it across a refresh", () => {
    const config = testConfig()
    const seen: Array<Recorded> = []
    return Effect.gen(function* () {
      const mock = yield* resource((req, res) => {
        seen.push(req)
        if (req.path.endsWith(`/models/${KEY}/endpoints`)) return json(res, 200, endpointsBody)
        if (req.path.endsWith("/models")) return json(res, 200, { data: [{ id: KEY, name: "Synthetic Flash" }] })
        return json(res, 404, {})
      })
      const { api, connection } = yield* connect(mock.url)
      const model = yield* api.AddUserModel({
        connectionId: connection.id,
        key: KEY,
        overrides: { settings: { routing: { only: ["google-vertex"] } } }
      })
      assert.isUndefined(model.upstream.endpoints)
      const fetched = yield* api.RefreshModelEndpoints({ modelId: model.id })
      const request = seen.find((r) => r.path.endsWith("/endpoints"))!
      assert.strictEqual(request.headers.authorization, "Bearer sk-synthetic")
      const endpoints = fetched.upstream.endpoints!
      assert.isUndefined(endpoints.error)
      assert.deepEqual(
        endpoints.list.map((e) => [e.tag, e.name]),
        [
          ["together", "Together"],
          ["deepinfra/fp8", "DeepInfra"],
          ["deepinfra/turbo", "DeepInfra"],
          ["google-vertex/us", "Google Vertex"],
          ["unpriced", "Unpriced"]
        ]
      )
      const together = endpoints.list[0]!
      assert.strictEqual(together.context, 128000)
      assert.closeTo(together.price!.input, 0.2, 1e-9)
      assert.closeTo(together.price!.output, 0.6, 1e-9)
      assert.closeTo(together.price!.cacheRead!, 0.05, 1e-9)
      assert.closeTo(together.price!.cacheWrite!, 0, 1e-9)
      // A discount scales the endpoint's prices.
      assert.closeTo(endpoints.list[2]!.price!.input, 0.2, 1e-9)
      assert.closeTo(endpoints.list[2]!.price!.output, 0.4, 1e-9)
      // A prompt-length override becomes a tier; a time-of-day one is left out.
      const vertex = endpoints.list[3]!.price!
      assert.deepEqual(
        vertex.tiers?.map((t) => [t.inputTokensAbove, t.input, t.output]),
        [[200000, 2, 6]]
      )
      // "-1" (varies) is no price.
      assert.isUndefined(endpoints.list[4]!.price)
      assert.deepEqual(modelPrice(fetched)?.input, 1)
      // A refresh of the models list keeps the fetched endpoints and the user's routing.
      yield* api.RefreshModels({ connectionId: connection.id })
      const [after] = (yield* api.ListModels({ connectionId: connection.id, includeHidden: true })).filter(
        (m) => m.key === KEY
      )
      assert.strictEqual(after!.upstream.endpoints?.list.length, 5)
      assert.strictEqual(after!.upstream.name, "Synthetic Flash")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("a failed fetch is stored as the reason, and the model's general price stays", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* resource((_req, res) => json(res, 404, { error: { message: "no such listing" } }))
      const { api, connection } = yield* connect(mock.url)
      const model = yield* api.AddUserModel({
        connectionId: connection.id,
        key: KEY,
        overrides: { settings: { routing: { only: ["together"] } } }
      })
      const failed = yield* api.RefreshModelEndpoints({ modelId: model.id })
      assert.match(failed.upstream.endpoints?.error ?? "", /not_found/)
      assert.deepEqual(failed.upstream.endpoints?.list, [])
      // Whatever the model's general price is, a failed list leaves it in force.
      assert.deepEqual(modelPrice(failed), failed.upstream.price ?? null)
      assert.strictEqual(routedPrice(failed.upstream, { only: ["together"] }).source?.state, "fallback")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("a failed refetch keeps the list fetched before, so the route keeps its own price", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* resource((req, res) =>
        req.path.endsWith(`/models/${KEY}/endpoints`) ? json(res, 200, endpointsBody) : json(res, 404, {})
      )
      const { api, connection } = yield* connect(mock.url)
      const model = yield* api.AddUserModel({
        connectionId: connection.id,
        key: KEY,
        overrides: { settings: { routing: { only: ["together"] } } }
      })
      const first = yield* api.RefreshModelEndpoints({ modelId: model.id })
      assert.closeTo(modelPrice(first)!.input, 0.2, 1e-9)
      mock.setHandler((_req, res) => json(res, 503, { error: { message: "busy" } }))
      const failed = yield* api.RefreshModelEndpoints({ modelId: model.id })
      assert.match(failed.upstream.endpoints?.error ?? "", /http/)
      assert.strictEqual(failed.upstream.endpoints?.list.length, 5)
      assert.closeTo(modelPrice(failed)!.input, 0.2, 1e-9)
      assert.strictEqual(routedPrice(failed.upstream, { only: ["together"] }).source?.state, "pinned")
      // Retried sooner than a good list, as any failure is.
      assert.isTrue(endpointsStale(failed.upstream.endpoints, Date.now() + 11 * 60 * 1000))
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("a variant id isn't asked for, and another kind's model is left alone", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const asked: Array<string> = []
      const mock = yield* resource((req, res) => {
        asked.push(req.path)
        return json(res, 200, endpointsBody)
      })
      const { api, connection } = yield* connect(mock.url)
      const variant = yield* api.AddUserModel({ connectionId: connection.id, key: `${KEY}:free`, overrides: {} })
      const refused = yield* api.RefreshModelEndpoints({ modelId: variant.id })
      assert.strictEqual(refused.upstream.endpoints?.list.length, 0)
      assert.strictEqual(asked.length, 0)
      const other = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: "Other",
          baseUrl: `${mock.url}/v1`,
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        },
        apiKey: "sk-synthetic"
      })
      const plain = yield* api.AddUserModel({ connectionId: other.id, key: KEY, overrides: {} })
      const same = yield* api.RefreshModelEndpoints({ modelId: plain.id })
      assert.isUndefined(same.upstream.endpoints)
      assert.strictEqual(asked.length, 0)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})

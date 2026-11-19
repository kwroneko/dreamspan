// The opt-in price endpoint (spec/PRICES.md §4): its parser, and that nothing is asked of a
// connection whose user didn't turn it on.
import type { Context as PiContext } from "@earendil-works/pi-ai"
import { assert, describe, it } from "@effect/vitest"
import type { UserId } from "@dreamspan/shared/domain.ts"
import type { ConnectionSettings, ModelId } from "@dreamspan/shared/providers.ts"
import { Effect, Layer, Stream } from "effect"
import * as Database from "../src/db/Database.ts"
import * as Network from "../src/net/Network.ts"
import * as ProviderBuiltins from "../src/providers/builtins.ts"
import { nextPriceFetch, parsePriceList, priceListUrl } from "../src/providers/priceEndpoint.ts"
import { builtinCostFormulas, costOf, emptyCapture } from "../src/providers/usage.ts"
import { unknownCounts } from "@dreamspan/shared/usage.ts"
import * as Providers from "../src/providers/Providers.ts"
import { makeSecrets, Secrets } from "../src/secrets.ts"
import { testWorkers } from "./support/bundles.ts"
import { completionChunks, json, sse, startMockProvider } from "./support/mockProvider.ts"
import { tempDir } from "./support/tempDir.ts"

describe("the price list format", () => {
  it("probes {base}/v1/prices with or without a trailing /v1", () => {
    assert.strictEqual(priceListUrl("https://gw.example/v1"), "https://gw.example/v1/prices")
    assert.strictEqual(priceListUrl("https://gw.example/v1/"), "https://gw.example/v1/prices")
    assert.strictEqual(priceListUrl("https://gw.example"), "https://gw.example/v1/prices")
  })

  it("accepts the base fields alone, as the existing implementation serves them", () => {
    const list = parsePriceList({
      object: "list",
      unit: "USD per 1M tokens",
      data: [
        {
          id: "m",
          available: true,
          served_by: "x",
          input: 3,
          output: 15,
          pct_of_list: 80,
          order: 0,
          routes: [{ target: "a", upstream: "b", input: 3, output: 15, list_input: 3.75, list_output: 18.75 }]
        }
      ]
    })!
    assert.strictEqual(list.currency, "USD")
    assert.deepStrictEqual(list.models.get("m"), {
      price: { input: 3, output: 15 },
      available: true,
      servedBy: "x",
      pctOfList: 80,
      routes: [{ target: "a", upstream: "b", price: { input: 3, output: 15 }, listInput: 3.75, listOutput: 18.75 }]
    })
  })

  it("reads the extension fields: currency, cache writes by TTL, per-request charges and tiers", () => {
    const list = parsePriceList({
      object: "list",
      unit: "USD per 1M tokens",
      currency: "EUR",
      valid_until: "2026-11-16T19:00:00Z",
      data: [
        {
          id: "m",
          input: 3,
          output: 15,
          cache_read: 0.3,
          cache_write: { "5m": 3.75, "1h": 6 },
          per_request: 0.001,
          tiers: [{ input_above: 200000, input: 6, cache_write: { "5m": 7.5 } }]
        },
        { id: "flat", input: 1, output: 2, cache_write: 1.5 }
      ]
    })!
    assert.strictEqual(list.currency, "EUR")
    assert.strictEqual(list.validUntil, Date.parse("2026-11-16T19:00:00Z"))
    assert.deepStrictEqual(list.models.get("m")!.price, {
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75,
      cacheWriteLong: 6,
      perRequest: 0.001,
      currency: "EUR",
      // "A field missing from a tier keeps the base rate."
      tiers: [{ inputTokensAbove: 200000, input: 6, output: 15, cacheRead: 0.3, cacheWrite: 7.5, cacheWriteLong: 6 }]
    })
    assert.deepStrictEqual(list.models.get("flat")!.price, {
      input: 1,
      output: 2,
      cacheWrite: 1.5,
      cacheWriteLong: 1.5,
      currency: "EUR"
    })
  })

  it("treats null, negative, non-finite and absurd rates as unknown, never zero; zero is free", () => {
    const list = parsePriceList({
      object: "list",
      unit: "USD per 1M tokens",
      data: [
        { id: "unknown-input", input: null, output: 1 },
        { id: "negative", input: -1, output: 1 },
        { id: "huge", input: 1e12, output: 1 },
        { id: "free", input: 0, output: 0 },
        { id: "bad-read", input: 1, output: 1, cache_read: "0.1" },
        { input: 1, output: 1 },
        "nonsense"
      ]
    })!
    assert.isNull(list.models.get("unknown-input")!.price)
    assert.isNull(list.models.get("negative")!.price)
    assert.isNull(list.models.get("huge")!.price)
    assert.deepStrictEqual(list.models.get("free")!.price, { input: 0, output: 0 })
    assert.deepStrictEqual(list.models.get("bad-read")!.price, { input: 1, output: 1 })
    assert.strictEqual(list.models.size, 5)
  })

  it("ignores a response it doesn't understand", () => {
    for (const body of [
      null,
      [],
      { object: "list", data: [] },
      { object: "list", unit: "USD per 1K tokens", data: [] },
      { object: "model", unit: "USD per 1M tokens", data: [] }
    ])
      assert.isNull(parsePriceList(body))
  })
})

const layer = (options: Providers.ProvidersOptions = {}) =>
  Providers.layer({ retry: { maxRetries: 0, baseDelayMs: 5, maxDelayMs: 100 }, priceTimerMs: 0, ...options }).pipe(
    Layer.provideMerge(Network.layer),
    Layer.provideMerge(ProviderBuiltins.layer),
    Layer.provideMerge(
      Database.layer({ dataDir: tempDir("price-endpoint"), readers: 1, allowNetworkFs: false, ...testWorkers })
    ),
    Layer.provideMerge(Layer.succeed(Secrets)(makeSecrets("a server secret for tests")))
  )

const mock = (handler: Parameters<typeof startMockProvider>[0]) =>
  Effect.acquireRelease(
    Effect.promise(() => startMockProvider(handler)),
    (server) => Effect.promise(() => server.close())
  )

const context: PiContext = {
  systemPrompt: "You are the narrator.",
  messages: [{ role: "user", content: "The harbor at dusk.", timestamp: 1 }]
}

const PRICES = "/v1/prices"

/** A gateway that lists two models and publishes prices for one of them. */
const gateway = () =>
  mock((request, res) =>
    request.path.endsWith("/models")
      ? json(res, 200, { data: [{ id: "m" }, { id: "other" }] })
      : request.path === PRICES
        ? json(res, 200, {
            object: "list",
            unit: "USD per 1M tokens",
            data: [{ id: "m", available: true, input: 2, output: 10 }]
          })
        : sse(res, completionChunks(["Hi."], { prompt_tokens: 1000, completion_tokens: 100 }))
  )

const connectWith = (baseUrl: string, priceEndpoint: boolean | undefined) =>
  Effect.gen(function* () {
    const writer = yield* Database.Writer
    const reader = yield* Database.Reader
    const providers = yield* Providers.Providers
    const userId = (yield* writer.EnsureUser({ handle: "ana", displayName: "Ana" })).id as UserId
    const settings: ConnectionSettings = {
      name: "Gateway",
      baseUrl,
      compat: {},
      cacheTtlS: null,
      maxConcurrent: null,
      presetOverrideRefId: null,
      ...(priceEndpoint === undefined ? {} : { providerSettings: { priceEndpoint } })
    }
    const connection = yield* providers.createConnection({
      userId,
      kind: "openai-chat",
      settings,
      apiKey: "sk-gw-0001"
    })
    yield* providers.refreshModels(userId, connection.id)
    const models = yield* reader.ListModels({ userId, connectionId: connection.id, includeHidden: true })
    const byKey = (key: string) => models.find((m) => m.key === key)!
    const reply = (key: string) =>
      Stream.runCollect(
        providers.stream({
          userId,
          connectionId: connection.id,
          modelId: byKey(key).id as ModelId,
          context,
          attribution: { purpose: "generation" }
        })
      ).pipe(Effect.map((events) => (events.at(-1) as { cost: { amount: number; formula: string } | null }).cost))
    const models_ = () => reader.ListModels({ userId, connectionId: connection.id, includeHidden: true })
    const feedOf = (key: string) => Effect.map(models_(), (all) => all.find((m) => m.key === key)!.upstream.priceFeed)
    return {
      byKey,
      reply,
      feedOf,
      state: providers.priceFeedState(userId, connection.id),
      refresh: providers.refreshModels(userId, connection.id),
      timer: providers.priceTimerRound
    }
  })

describe("asking a connection's server for its prices", () => {
  for (const setting of [undefined, false])
    it.live(`sends nothing to /v1/prices unless the user opted in (setting: ${String(setting)})`, () =>
      Effect.gen(function* () {
        const server = yield* gateway()
        const { byKey, reply } = yield* connectWith(server.url, setting)
        yield* reply("m")
        assert.deepStrictEqual(
          server.requests().filter((r) => r.path.endsWith("/prices")),
          []
        )
        assert.isUndefined(byKey("m").upstream.priceFeed)
      }).pipe(Effect.scoped, Effect.provide(layer()))
    )

  it.live("asks once per refresh when opted in, with the model list's key, and prices from it", () =>
    Effect.gen(function* () {
      const server = yield* gateway()
      const { byKey, reply } = yield* connectWith(`${server.url}/v1`, true)
      const asked = server.requests().filter((r) => r.path === PRICES)
      assert.strictEqual(asked.length, 1)
      assert.strictEqual(asked[0]!.headers.authorization, "Bearer sk-gw-0001")
      assert.deepStrictEqual(byKey("m").upstream.priceFeed!.price, { input: 2, output: 10 })
      // A model the price list doesn't name has no endpoint price.
      assert.isUndefined(byKey("other").upstream.priceFeed)
      const cost = (yield* reply("m"))!
      assert.match(cost.formula, /^endpoint:\d+$/)
      assert.closeTo(cost.amount, (1000 * 2 + 100 * 10) / 1e6, 1e-12)
    }).pipe(Effect.scoped, Effect.provide(layer()))
  )
})

describe("routes (PRICES §4.4, §5.2)", () => {
  const list = parsePriceList({
    object: "list",
    unit: "USD per 1M tokens",
    data: [
      {
        id: "m",
        input: 2,
        output: 10,
        cache_read: 0.2,
        served_by: "pool",
        pct_of_list: 80,
        routes: [
          { target: "fast", upstream: "Route-A", input: 4, list_input: 5, list_output: 20, pct_of_list: 80 },
          { target: "cheap", upstream: "route-b", input: 1, output: 5 },
          { input: 9, output: 9 },
          "nonsense"
        ]
      }
    ]
  })!
  const entry = list.models.get("m")!

  it("reads each route's rates over the model's own, and the display fields", () => {
    assert.strictEqual(entry.servedBy, "pool")
    assert.strictEqual(entry.pctOfList, 80)
    assert.deepStrictEqual(entry.routes, [
      {
        target: "fast",
        upstream: "Route-A",
        price: { input: 4, output: 10, cacheRead: 0.2 },
        listInput: 5,
        listOutput: 20,
        pctOfList: 80
      },
      { target: "cheap", upstream: "route-b", price: { input: 1, output: 5, cacheRead: 0.2 } }
    ])
  })

  const sources = {
    endpoint: {
      price: entry.price!,
      fetchedAt: 300,
      routes: entry.routes!.map((r) => ({
        ...(r.target ? { target: r.target } : {}),
        ...(r.upstream ? { upstream: r.upstream } : {}),
        price: r.price!
      }))
    },
    list: null,
    builtin: null
  }
  const counts = {
    ...unknownCounts,
    inputUncached: 1_000_000,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWriteLong: 0,
    output: 0
  }
  const priced = (upstream: string | null) =>
    costOf(
      builtinCostFormulas,
      { kind: "openai-chat", api: "openai-completions", model: "m" },
      { counts, capture: { ...emptyCapture(), upstream }, price: null, sources }
    )

  it("prices from a route only when the ledger captured which one served the request", () => {
    assert.deepStrictEqual(
      { amount: priced(null)!.amount, formula: priced(null)!.formula },
      { amount: 2, formula: "endpoint:300" }
    )
    assert.deepStrictEqual(
      { amount: priced("route-a")!.amount, formula: priced("route-a")!.formula },
      { amount: 4, formula: "endpoint:300:Route-A" }
    )
    // By target when no route names the upstream that way.
    assert.strictEqual(priced("cheap")!.formula, "endpoint:300:route-b")
    assert.strictEqual(priced("somewhere-else")!.formula, "endpoint:300")
  })

  it("bounds a request by its dearest route before dispatch", () => {
    const formula = builtinCostFormulas.find((f) => f.id === "endpoint")!
    const bound = formula.upperBound!({ inputTokens: 1_000_000, outputTokens: 0, price: null, sources } as never)
    // The dearest route's dearest input rate: route A's long cache writes, unknown, count at twice its input.
    assert.deepStrictEqual(bound, { amount: 8, currency: "USD" })
  })
})

describe("when prices are asked again (PRICES §4.5, §4.6)", () => {
  it("asks at valid_until or max-age, clamped to 5 minutes and a day, else hourly", () => {
    const minute = 60_000
    assert.strictEqual(nextPriceFetch(0, null), 60 * minute)
    assert.strictEqual(nextPriceFetch(0, 30 * minute), 30 * minute)
    assert.strictEqual(nextPriceFetch(0, minute), 5 * minute)
    assert.strictEqual(nextPriceFetch(0, 90 * 24 * 60 * minute), 24 * 60 * minute)
  })

  /** A clock the layer reads, moved by the test. */
  const clock = () => {
    let at = Date.now()
    return { now: () => at, advance: (ms: number) => (at += ms) }
  }

  it.live("keeps a server that doesn't publish prices unasked until models are refreshed", () => {
    const time = clock()
    return Effect.gen(function* () {
      const server = yield* mock((request, res) =>
        request.path.endsWith("/models")
          ? json(res, 200, { data: [{ id: "m" }] })
          : request.path === PRICES
            ? json(res, 404, { error: "not found" })
            : sse(res, completionChunks(["Hi."], { prompt_tokens: 10, completion_tokens: 1 }))
      )
      const asked = () => server.requests().filter((r) => r.path === PRICES).length
      const { reply, state, refresh, timer } = yield* connectWith(server.url, true)
      yield* reply("m")
      assert.strictEqual(asked(), 1)
      const first = (yield* state)!
      assert.strictEqual(first.state, "unsupported")
      assert.isNull(first.nextAt)
      time.advance(48 * 60 * 60_000)
      yield* timer
      assert.strictEqual(asked(), 1)
      yield* refresh
      assert.strictEqual(asked(), 2)
    }).pipe(Effect.scoped, Effect.provide(layer({ now: time.now })))
  })

  it.live("asks again when due, with the ETag; a 304 only moves fetchedAt", () => {
    const time = clock()
    return Effect.gen(function* () {
      const server = yield* mock((request, res) => {
        if (request.path.endsWith("/models")) {
          json(res, 200, { data: [{ id: "m" }] })
          return
        }
        if (request.path === PRICES) {
          if (request.headers["if-none-match"] === '"v1"') {
            res.writeHead(304, { etag: '"v1"', "cache-control": "max-age=600" })
            res.end()
            return
          }
          res.writeHead(200, { "content-type": "application/json", etag: '"v1"', "cache-control": "max-age=600" })
          res.end(
            JSON.stringify({ object: "list", unit: "USD per 1M tokens", data: [{ id: "m", input: 2, output: 10 }] })
          )
          return
        }
        sse(res, completionChunks(["Hi."], { prompt_tokens: 10, completion_tokens: 1 }))
      })
      const prices = () => server.requests().filter((r) => r.path === PRICES)
      const { reply, feedOf, state, timer } = yield* connectWith(server.url, true)
      yield* reply("m")
      const before = (yield* feedOf("m"))!
      assert.strictEqual(before.etag, '"v1"')
      assert.strictEqual(before.validUntil, before.fetchedAt + 600_000)
      assert.strictEqual((yield* state)!.nextAt, before.fetchedAt + 600_000)
      // Not due yet: nothing is sent.
      yield* timer
      assert.strictEqual(prices().length, 1)
      time.advance(11 * 60_000)
      yield* timer
      assert.strictEqual(prices().length, 2)
      assert.strictEqual(prices()[1]!.headers["if-none-match"], '"v1"')
      const after = (yield* feedOf("m"))!
      assert.strictEqual(after.fetchedAt, time.now())
      assert.deepStrictEqual(after.price, before.price)
      assert.strictEqual((yield* state)!.state, "supported")
    }).pipe(Effect.scoped, Effect.provide(layer({ now: time.now })))
  })

  it.live("retries a failure after ten minutes and keeps the last good prices", () => {
    const time = clock()
    let fail = false
    return Effect.gen(function* () {
      const server = yield* mock((request, res) =>
        request.path.endsWith("/models")
          ? json(res, 200, { data: [{ id: "m" }] })
          : request.path === PRICES
            ? fail
              ? json(res, 500, { error: "down" })
              : json(res, 200, { object: "list", unit: "USD per 1M tokens", data: [{ id: "m", input: 2, output: 10 }] })
            : sse(res, completionChunks(["Hi."], { prompt_tokens: 10, completion_tokens: 1 }))
      )
      const prices = () => server.requests().filter((r) => r.path === PRICES).length
      const { reply, feedOf, state, timer } = yield* connectWith(server.url, true)
      yield* reply("m")
      fail = true
      time.advance(61 * 60_000)
      yield* timer
      assert.strictEqual(prices(), 2)
      assert.strictEqual((yield* state)!.state, "failed")
      assert.deepStrictEqual((yield* feedOf("m"))!.price, { input: 2, output: 10 })
      time.advance(5 * 60_000)
      yield* timer
      assert.strictEqual(prices(), 2)
      time.advance(6 * 60_000)
      yield* timer
      assert.strictEqual(prices(), 3)
    }).pipe(Effect.scoped, Effect.provide(layer({ now: time.now })))
  })

  it.live("sends nothing for a connection not used in the last day", () => {
    const time = clock()
    return Effect.gen(function* () {
      const server = yield* gateway()
      const { timer } = yield* connectWith(server.url, true)
      time.advance(2 * 60 * 60_000)
      yield* timer
      assert.strictEqual(server.requests().filter((r) => r.path === PRICES).length, 1)
    }).pipe(Effect.scoped, Effect.provide(layer({ now: time.now })))
  })

  it.live("prices a reply from the route the server reports it took", () =>
    Effect.gen(function* () {
      const server = yield* mock((request, res) =>
        request.path.endsWith("/models")
          ? json(res, 200, { data: [{ id: "m" }] })
          : request.path === PRICES
            ? json(res, 200, {
                object: "list",
                unit: "USD per 1M tokens",
                data: [
                  { id: "m", input: 2, output: 10, routes: [{ target: "b", upstream: "route-b", input: 1, output: 5 }] }
                ]
              })
            : sse(
                res,
                completionChunks(["Hi."], { prompt_tokens: 1000, completion_tokens: 100 }, { provider: "route-b" })
              )
      )
      const { reply } = yield* connectWith(server.url, true)
      const cost = (yield* reply("m"))!
      assert.match(cost.formula, /^endpoint:\d+:route-b$/)
      assert.closeTo(cost.amount, (1000 * 1 + 100 * 5) / 1e6, 1e-12)
    }).pipe(Effect.scoped, Effect.provide(layer()))
  )
})

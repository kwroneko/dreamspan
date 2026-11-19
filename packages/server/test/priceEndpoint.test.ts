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
import { parsePriceList, priceListUrl } from "../src/providers/priceEndpoint.ts"
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
    assert.deepStrictEqual(list.models.get("m"), { price: { input: 3, output: 15 }, available: true })
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

const layer = () =>
  Providers.layer({ retry: { maxRetries: 0, baseDelayMs: 5, maxDelayMs: 100 } }).pipe(
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
    return { byKey, reply }
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

// The built-in price table and the order prices are chosen in (spec/PRICES.md §3.2, §5.1).
import { assert, describe, it } from "@effect/vitest"
import type { CostRule } from "@rp/shared/costFormulas.ts"
import type { Model, Price } from "@rp/shared/providers.ts"
import { unknownCounts } from "@rp/shared/usage.ts"
import { Effect } from "effect"
import { piCatalogs, withCatalog } from "../src/providers/catalog.ts"
import { priceSources } from "../src/providers/priceSources.ts"
import { readFileSync } from "node:fs"
import {
  BUILTIN_PRICE_VERSION,
  PI_AI_VERSION,
  supplementPrice,
  type PriceContext
} from "../src/providers/prices/index.ts"
import type { PriceSources, ProviderKindEntry } from "../src/providers/registry.ts"
import { builtinCostFormulas, costOf, emptyCapture, priceCost } from "../src/providers/usage.ts"
import type { UserPricing } from "../src/providers/userCosts.ts"

const now = Date.parse("2026-11-16T12:00:00Z")

/**
 * Every model of the major closed-source labs still available for inference on 2026-11-16, on
 * their first-party and cloud providers, by pi-ai provider id (owner, 2026-11-16: "we need prices
 * for every model that is still available for inference"). A pi-ai upgrade or a table edit that
 * leaves one without a price fails here. Bedrock IDs are from AWS's model cards.
 */
const MAIN_MODELS: Readonly<Record<string, ReadonlyArray<string>>> = {
  anthropic: [
    "claude-fable-5-2",
    "claude-mythos-5-2",
    "claude-fable-5-1",
    "claude-mythos-5-1",
    "claude-fable-5",
    "claude-mythos-5",
    "claude-opus-5-5",
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-opus-4-5-20251101",
    "claude-opus-4-5",
    "claude-sonnet-5-5",
    "claude-sonnet-5",
    "claude-sonnet-4-6",
    "claude-sonnet-4-5-20250929",
    "claude-sonnet-4-5",
    "claude-haiku-5-5",
    "claude-haiku-4-5-20251001",
    "claude-haiku-4-5"
  ],
  "amazon-bedrock": [
    "global.anthropic.claude-fable-5-2",
    "us.anthropic.claude-fable-5-2",
    "global.anthropic.claude-mythos-5-2",
    "us.anthropic.claude-mythos-5-2",
    ...["global", "us", "eu", "au", "jp", "ca"].map((p) => `${p}.anthropic.claude-haiku-5-5`),
    ...["global", "us", "eu", "au", "ca"].map((p) => `${p}.anthropic.claude-sonnet-5-5`),
    ...["global", "us", "eu", "au", "jp"].map((p) => `${p}.anthropic.claude-opus-5-5`),
    "global.anthropic.claude-fable-5-1",
    "us.anthropic.claude-fable-5-1",
    "global.anthropic.claude-mythos-5-1",
    "us.anthropic.claude-mythos-5-1",
    ...["global", "us", "eu", "au", "in"].map((p) => `${p}.anthropic.claude-opus-5`),
    ...["global", "us", "eu", "au", "in"].map((p) => `${p}.anthropic.claude-sonnet-5`),
    "anthropic.claude-mythos-5",
    "global.anthropic.claude-fable-5",
    "us.anthropic.claude-fable-5",
    ...["global", "us", "eu", "au", "jp"].map((p) => `${p}.anthropic.claude-opus-4-8`),
    ...["global", "us", "eu", "au", "jp"].map((p) => `${p}.anthropic.claude-opus-4-7`),
    ...["global", "us", "eu", "au"].map((p) => `${p}.anthropic.claude-opus-4-6-v1`),
    ...["global", "us", "eu", "au", "jp"].map((p) => `${p}.anthropic.claude-sonnet-4-6`),
    ...["global", "us", "eu", "au", "jp", "in"].map((p) => `${p}.anthropic.claude-haiku-4-5-20251001-v1:0`),
    ...["global", "us", "eu"].map((p) => `${p}.anthropic.claude-opus-4-5-20251101-v1:0`),
    ...["global", "us", "eu", "au", "jp"].map((p) => `${p}.anthropic.claude-sonnet-4-5-20250929-v1:0`),
    "us.anthropic.claude-opus-4-1-20250805-v1:0",
    "anthropic.claude-opus-4-1-20250805-v1:0",
    "us.anthropic.claude-3-haiku-20240307-v1:0"
  ],
  "google-vertex": [
    "claude-fable-5-2",
    "claude-haiku-5-5",
    "claude-sonnet-5-5",
    "claude-opus-5-5",
    "claude-opus-5",
    "claude-sonnet-5",
    "claude-fable-5-1",
    "claude-fable-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-opus-4-5@20251101",
    "claude-sonnet-4-6",
    "claude-sonnet-4-5@20250929",
    "claude-haiku-4-5@20251001"
  ],
  openai: [
    "gpt-6-astra",
    "gpt-6.1-sol",
    "gpt-6.1-terra",
    "gpt-6-luna",
    "gpt-6-sol",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
    "gpt-5.5-pro",
    "gpt-5.4",
    "gpt-5.4-pro",
    "gpt-5.4-mini",
    "gpt-5.4-nano",
    "gpt-5.2",
    "gpt-5.2-pro",
    "gpt-5.1",
    "gpt-5",
    "gpt-5-mini",
    "gpt-5-nano",
    "gpt-5-pro",
    "gpt-4.1",
    "gpt-4.1-mini",
    "gpt-4o",
    "gpt-4o-mini",
    "o3",
    "o3-pro",
    "chat-latest",
    "gpt-5.3-codex",
    "gpt-5-search-api",
    "gpt-6-astra-law",
    "gpt-6-cyber",
    "gpt-5.6-cyber",
    "gpt-5.5-cyber-preview",
    "gpt-6-rosalind",
    "gpt-rosalind-research",
    "gpt-rosalind-discovery"
  ],
  google: [
    "gemini-4-carbon",
    "gemini-4-argon",
    "gemini-4-hydrogen",
    "gemini-3.8-flash",
    "gemini-3.6-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
    "gemini-3.1-pro-preview",
    "gemini-3.1-pro-preview-customtools",
    "gemini-3-flash-preview",
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite"
  ],
  deepseek: ["deepseek-flash", "deepseek-v4-pro", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"]
}

/** The built-in price a model gets: the supplement, else pi-ai's catalog. */
const builtinPrice = async (provider: string, model: string): Promise<Price | null> => {
  const table = supplementPrice({ provider }, model, now)
  if (table) return table
  const load = piCatalogs[provider]
  const catalog = load ? await load() : {}
  const entry = Object.hasOwn(catalog, model) ? catalog[model] : undefined
  return entry ? { input: entry.cost.input, output: entry.cost.output } : null
}

const valid = (price: Price) =>
  [price, ...(price.tiers ?? [])].every((rates) =>
    Object.values(rates).every((v) => typeof v !== "number" || (Number.isFinite(v) && v >= 0))
  ) &&
  price.input > 0 &&
  price.output > 0

describe("main-models coverage", () => {
  for (const [provider, models] of Object.entries(MAIN_MODELS))
    it(`prices every still-available ${provider} model`, async () => {
      const missing: Array<string> = []
      for (const model of models) {
        const price = await builtinPrice(provider, model)
        if (price === null || !valid(price)) missing.push(model)
      }
      assert.deepStrictEqual(missing, [])
    })
})

const at = (context: PriceContext, model: string, time = now) => supplementPrice(context, model, time)

describe("the built-in table", () => {
  it("prices Bedrock by inference profile: global as listed, geo and in-region at 1.1x, GovCloud not at all", () => {
    const bedrock = { provider: "amazon-bedrock" }
    assert.deepStrictEqual(at(bedrock, "global.anthropic.claude-opus-5-5"), {
      input: 4,
      output: 20,
      cacheRead: 0.2,
      cacheWrite: 5,
      cacheWriteLong: 8
    })
    // The page's geo table: 4.4 / 22 / 5.5 / 8.8 / 0.22.
    assert.deepStrictEqual(at(bedrock, "eu.anthropic.claude-opus-5-5"), {
      input: 4.4,
      output: 22,
      cacheRead: 0.22,
      cacheWrite: 5.5,
      cacheWriteLong: 8.8
    })
    assert.deepStrictEqual(at(bedrock, "anthropic.claude-opus-5-5"), at(bedrock, "us.anthropic.claude-opus-5-5"))
    assert.isNull(at(bedrock, "us-gov.anthropic.claude-opus-5-5"))
    assert.isNull(at(bedrock, "global.anthropic.claude-mythos-5"))
    // The long-context tier keeps its threshold when the rates are scaled.
    assert.strictEqual(at(bedrock, "us.anthropic.claude-haiku-5-5")!.tiers![0]!.inputTokensAbove, 100_000)
    assert.strictEqual(at(bedrock, "us.anthropic.claude-haiku-5-5")!.tiers![0]!.output, 2.75)
    // Not Anthropic's: pi-ai's catalog keeps pricing it.
    assert.isNull(at(bedrock, "global.openai.gpt-6-sol"))
  })

  it("charges Vertex's regional and multi-region endpoints 1.1x the global price", () => {
    const global = at({ provider: "google-vertex" }, "claude-sonnet-4-5@20250929")!
    assert.deepStrictEqual(at({ provider: "google-vertex", region: "global" }, "claude-sonnet-4-5@20250929"), global)
    const regional = at({ provider: "google-vertex", region: "us-east5" }, "claude-sonnet-4-5@20250929")!
    assert.strictEqual(regional.input, 3.3)
    assert.strictEqual(regional.tiers![0]!.input, 6.6)
    assert.strictEqual(regional.tiers![0]!.output, 24.75)
    assert.strictEqual(regional.tiers![0]!.inputTokensAbove, 199_999)
  })

  it("applies announced price changes from their date", () => {
    const google = { provider: "google" }
    assert.strictEqual(at(google, "gemini-4-carbon", Date.parse("2026-11-30T23:59:59Z"))!.input, 2)
    assert.strictEqual(at(google, "gemini-4-carbon", Date.parse("2026-12-01T00:00:00Z"))!.input, 4)
    assert.strictEqual(at(google, "gemini-3.8-flash", Date.parse("2027-01-01T00:00:00Z"))!.output, 7.5)
  })

  it("halves DeepSeek's rates outside its weekday peak hours", () => {
    const deepseek = { provider: "deepseek" }
    // Tuesday 02:30 and 09:59 UTC are peak; 05:00 and 10:00 aren't; Saturday never is.
    assert.strictEqual(at(deepseek, "deepseek-flash", Date.parse("2026-11-17T02:30:00Z"))!.input, 0.3)
    assert.strictEqual(at(deepseek, "deepseek-flash", Date.parse("2026-11-17T09:59:00Z"))!.output, 1.2)
    assert.strictEqual(at(deepseek, "deepseek-flash", Date.parse("2026-11-17T05:00:00Z"))!.input, 0.15)
    assert.strictEqual(at(deepseek, "deepseek-flash", Date.parse("2026-11-17T10:00:00Z"))!.cacheRead, 0.003)
    assert.strictEqual(at(deepseek, "deepseek-v4-pro", Date.parse("2026-11-21T02:30:00Z"))!.output, 1.98)
  })

  it("never reads a model id through the object prototype", () => {
    for (const provider of Object.keys(MAIN_MODELS))
      for (const model of ["constructor", "__proto__", "toString"]) assert.isNull(at({ provider }, model))
  })

  it("prices long writes, tiers and per-request charges", () => {
    const counts = {
      ...unknownCounts,
      inputUncached: 1_000,
      cacheRead: 50_000,
      cacheWrite: 60_000,
      cacheWriteLong: 10_000,
      output: 1_000
    }
    // Haiku 5.5: 111,000 prompt tokens is over 100,000, so the whole request is at the higher rates.
    const haiku = at({ provider: "anthropic" }, "claude-haiku-5-5")!
    assert.closeTo(
      priceCost(counts, haiku)!,
      (1_000 * 0.5 + 50_000 * 0.05 + 50_000 * 0.625 + 10_000 * 1 + 1_000 * 2.5) / 1e6,
      1e-12
    )
    // Without a long-write rate, twice the input rate; a flat charge on top.
    assert.closeTo(
      priceCost(counts, { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25, perRequest: 0.01 })!,
      (1_000 + 5_000 + 62_500 + 20_000 + 2_000) / 1e6 + 0.01,
      1e-12
    )
  })
})

const counts = { ...unknownCounts, inputUncached: 1_000_000, cacheRead: 0, cacheWrite: 0, cacheWriteLong: 0, output: 0 }
const target = { kind: "openai-chat", api: "openai-completions", model: "m" }
const rule = (id: string, input: number, connectionId: string | null, kind: string | null = null): CostRule => ({
  id,
  name: id,
  kind,
  connectionId: connectionId as CostRule["connectionId"],
  model: "m",
  upstream: null,
  currency: "USD",
  rates: { input, read: 0, write: 0, writeLong: 0, output: 0 },
  tiers: []
})
const pricing = (rules: ReadonlyArray<CostRule>): UserPricing => ({
  settings: { revision: 7, rules },
  kind: "openai-chat",
  connectionId: "conn",
  model: "m"
})
const sources = (endpoint: boolean, list: boolean, builtin: boolean): PriceSources => ({
  endpoint: endpoint ? { price: { input: 3, output: 0 }, fetchedAt: 300 } : null,
  list: list ? { price: { input: 4, output: 0 }, fetchedAt: 400, endpoints: false } : null,
  builtin: builtin ? { price: { input: 6, output: 0 }, version: "v1" } : null
})
const winner = (s: PriceSources, rules: ReadonlyArray<CostRule> = [], reported: number | null = null) =>
  costOf(builtinCostFormulas, target, {
    counts,
    pricing: pricing(rules),
    capture: { ...emptyCapture(), reportedCost: reported },
    price: null,
    sources: s
  })

describe("precedence (PRICES §5.1)", () => {
  const own = rule("own", 1, "conn")
  const general = rule("general", 5, null)
  const typeWide = rule("type", 5, null, "openai-chat")

  it("puts the user's price naming this connection first, over the provider's own charge", () => {
    assert.deepStrictEqual(winner(sources(true, true, true), [general, own], 2), {
      amount: 1,
      currency: "USD",
      formula: "user:own:7"
    })
  })

  it("then the reported charge, over every table and the account-wide price", () => {
    assert.strictEqual(winner(sources(true, true, true), [general, typeWide], 2)!.formula, "reported")
  })

  it("then the price endpoint, then the list, both over account-wide and per-type prices", () => {
    assert.strictEqual(winner(sources(true, true, true), [general, typeWide])!.formula, "endpoint:300")
    assert.strictEqual(winner(sources(false, true, true), [general, typeWide])!.formula, "list:400")
  })

  it("then the account-wide or per-type price, over the built-in table", () => {
    assert.strictEqual(winner(sources(false, false, true), [general])!.formula, "user:general:7")
    assert.strictEqual(winner(sources(false, false, true), [typeWide])!.formula, "user:type:7")
    assert.deepStrictEqual(winner(sources(false, false, true)), { amount: 6, currency: "USD", formula: "builtin:v1" })
  })

  it("names another connection's price as not this one's", () => {
    assert.strictEqual(winner(sources(false, false, true), [rule("other", 1, "elsewhere")])!.formula, "builtin:v1")
  })

  it("records a pinned route's endpoint-list price as such", () => {
    const s = {
      ...sources(false, false, true),
      list: { price: { input: 4, output: 0 }, fetchedAt: 9, endpoints: true }
    }
    assert.strictEqual(winner(s)!.formula, "list:endpoints:9")
    assert.strictEqual(winner({ ...s, list: { ...s.list, fetchedAt: null, endpoints: false } })!.formula, "list")
  })

  it("has no price when no source has one", () => {
    assert.isNull(winner(sources(false, false, false)))
  })

  it("prices a caller that passes no sources with the built-in formula, as before", () => {
    const cost = costOf(builtinCostFormulas, target, {
      counts,
      capture: emptyCapture(),
      price: { input: 2, output: 0 }
    })
    assert.deepStrictEqual(cost, { amount: 2, currency: "USD", formula: "builtin" })
  })
})

const model = (upstream: Model["upstream"], key = "claude-sonnet-5-5"): Model =>
  ({ key, upstream, overrides: {}, fetchedAt: 1234 }) as unknown as Model

describe("price sources of a stored model", () => {
  it("replaces a stored catalog price with the supplement's, whole", () => {
    const s = priceSources({ provider: "anthropic" }, model({ price: { input: 2, output: 10, cacheRead: 0.2 } }), now)
    assert.isNull(s.list)
    assert.deepStrictEqual(s.builtin, {
      price: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, cacheWriteLong: 4 },
      version: BUILTIN_PRICE_VERSION
    })
  })

  it("keeps a list price the list's, with the time it was fetched", () => {
    const s = priceSources(
      { provider: "openrouter" },
      model({ price: { input: 9, output: 9 }, priceFrom: "list" }, "x/y"),
      now
    )
    assert.deepStrictEqual(s.list, { price: { input: 9, output: 9 }, fetchedAt: 1234, endpoints: false })
    assert.isNull(s.builtin)
  })

  it("falls back to the stored catalog price for a model the supplement lacks", () => {
    const s = priceSources({ provider: "openrouter" }, model({ price: { input: 1, output: 1 } }, "x/y"), now)
    assert.deepStrictEqual(s.builtin!.price, { input: 1, output: 1 })
  })

  it.effect("records on refresh whether a price came from the list or the built-in table", () =>
    Effect.gen(function* () {
      const kind = {
        piProvider: "anthropic",
        api: "anthropic-messages",
        catalog: piCatalogs.anthropic
      } as unknown as ProviderKindEntry
      const [fromTable, fromList] = yield* withCatalog(kind, [
        { key: "claude-sonnet-5-5", upstream: {} },
        { key: "claude-sonnet-5-5", upstream: { price: { input: 7, output: 7 } } }
      ])
      assert.strictEqual(fromTable!.upstream.priceFrom, "builtin")
      assert.strictEqual(fromTable!.upstream.price!.cacheRead, 0.1)
      assert.strictEqual(fromList!.upstream.priceFrom, "list")
      assert.deepStrictEqual(fromList!.upstream.price, { input: 7, output: 7 })
      // A model only the supplement knows still gets its price.
      const [haiku] = yield* withCatalog(kind, [{ key: "claude-haiku-5-5", upstream: {} }])
      assert.strictEqual(haiku!.upstream.price!.input, 0.1)
    })
  )
})

describe("the built-in table's version", () => {
  it("names the installed pi-ai", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../../../node_modules/@earendil-works/pi-ai/package.json", import.meta.url), "utf8")
    ) as { version: string }
    assert.strictEqual(PI_AI_VERSION, pkg.version)
    assert.match(BUILTIN_PRICE_VERSION, /^pi-ai@\d+\.\d+\.\d+\+[0-9a-f]{12}$/)
  })
})

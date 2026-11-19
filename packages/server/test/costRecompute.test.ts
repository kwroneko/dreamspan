// "Apply to past requests" (spec/PRICES.md §6.1): re-prices closed requests priced from rates, on
// request only, never a charge the provider reported; a price endpoint's row only through the
// user's price naming that connection (§8 Q2).
import type { Context as PiContext } from "@earendil-works/pi-ai"
import { assert, describe, it } from "@effect/vitest"
import type { CostRule } from "@dreamspan/shared/costFormulas.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import type { Connection, Model, ModelId } from "@dreamspan/shared/providers.ts"
import { unknownCounts } from "@dreamspan/shared/usage.ts"
import { Effect, Layer, Stream } from "effect"
import * as Database from "../src/db/Database.ts"
import * as Network from "../src/net/Network.ts"
import * as ProviderBuiltins from "../src/providers/builtins.ts"
import { BUILTIN_PRICE_VERSION } from "../src/providers/prices/index.ts"
import * as Providers from "../src/providers/Providers.ts"
import { recomputeCosts, repriceBuiltin } from "../src/providers/recompute.ts"
import { ProviderRegistry, type ProviderRegistryShape } from "../src/providers/registry.ts"
import { makeSecrets, Secrets } from "../src/secrets.ts"
import { testWorkers } from "./support/bundles.ts"
import { completionChunks, json, sse, startMockProvider } from "./support/mockProvider.ts"
import { tempDir } from "./support/tempDir.ts"

const layer = () =>
  Providers.layer({ retry: { maxRetries: 0, baseDelayMs: 5, maxDelayMs: 100 }, priceTimerMs: 0 }).pipe(
    Layer.provideMerge(Network.layer),
    Layer.provideMerge(ProviderBuiltins.layer),
    Layer.provideMerge(
      Database.layer({ dataDir: tempDir("cost-recompute"), readers: 1, allowNetworkFs: false, ...testWorkers })
    ),
    Layer.provideMerge(Layer.succeed(Secrets)(makeSecrets("a server secret for tests")))
  )

const context: PiContext = {
  systemPrompt: "You are the narrator.",
  messages: [{ role: "user", content: "The harbor at dusk.", timestamp: 1 }]
}

const rule = (id: string, input: number, connectionId: string | null): CostRule => ({
  id,
  name: id,
  kind: null,
  connectionId: connectionId as CostRule["connectionId"],
  model: "m",
  upstream: null,
  currency: "USD",
  rates: { input, read: 0, write: 0, writeLong: 0, output: 0 },
  tiers: []
})

describe("re-pricing past requests (PRICES §6.1)", () => {
  it.live("re-prices rows a saved price now covers, never a reported charge, only when applied", () =>
    Effect.gen(function* () {
      let reported = false
      let prices = false
      const server = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((request, res) =>
            request.path.endsWith("/models")
              ? json(res, 200, { data: [{ id: "m" }] })
              : request.path === "/v1/prices"
                ? prices
                  ? json(res, 200, {
                      object: "list",
                      unit: "USD per 1M tokens",
                      data: [{ id: "m", input: 3, output: 0 }]
                    })
                  : json(res, 404, {})
                : sse(
                    res,
                    completionChunks(["Hi."], {
                      prompt_tokens: 1_000_000,
                      completion_tokens: 0,
                      ...(reported ? { cost: 0.5 } : {})
                    })
                  )
          )
        ),
        (s) => Effect.promise(() => s.close())
      )
      const writer = yield* Database.Writer
      const reader = yield* Database.Reader
      const registry = yield* ProviderRegistry
      const providers = yield* Providers.Providers
      const userId = (yield* writer.EnsureUser({ handle: "ana", displayName: "Ana" })).id as UserId
      const connection = yield* providers.createConnection({
        userId,
        kind: "openai-chat",
        settings: {
          name: "Gateway",
          baseUrl: server.url,
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null,
          providerSettings: { priceEndpoint: true }
        },
        apiKey: "sk-gw-0001"
      })
      yield* providers.refreshModels(userId, connection.id)
      const [model] = yield* reader.ListModels({ userId, connectionId: connection.id, includeHidden: true })
      const reply = Stream.runCollect(
        providers.stream({
          userId,
          connectionId: connection.id,
          modelId: model!.id as ModelId,
          context,
          attribution: { purpose: "generation" }
        })
      )
      const setRules = (rules: ReadonlyArray<CostRule>) =>
        Effect.flatMap(reader.GetCostSettings({ userId }), (s) =>
          writer.SetCostSettings({ userId, expectedRevision: s.revision, rules })
        )
      const ledger = Effect.map(reader.ListLlmRequests({ userId, limit: 50, before: null }), (rows) =>
        rows
          .map((r) => r.cost)
          .filter((c) => c !== null)
          .map((c) => `${c.formula.replace(/:\d+$/, "")}=${c.amount}`)
          .sort()
      )
      const deps = { reader, writer, registry }

      // Two rows priced by an account-wide price, one reported charge.
      yield* setRules([rule("general", 1, null)])
      yield* reply
      yield* reply
      reported = true
      yield* reply
      reported = false
      // One row from the server's price list.
      prices = true
      yield* providers.refreshModels(userId, connection.id)
      yield* reply
      assert.deepStrictEqual(yield* ledger, ["endpoint=3", "reported=0.5", "user:general=1", "user:general=1"])

      // The account-wide price changes: its two rows can follow; not the reported or endpoint row.
      yield* setRules([rule("general", 2, null)])
      const preview = yield* recomputeCosts(deps, userId, { _tag: "Rule", ruleId: "general" }, false)
      assert.strictEqual(preview.count, 2)
      assert.isNumber(preview.from)
      assert.isAtMost(preview.from!, preview.to!)
      // A preview changes nothing.
      assert.deepStrictEqual(yield* ledger, ["endpoint=3", "reported=0.5", "user:general=1", "user:general=1"])
      const applied = yield* recomputeCosts(deps, userId, { _tag: "Rule", ruleId: "general" }, true)
      assert.strictEqual(applied.changed, 2)
      assert.deepStrictEqual(yield* ledger, ["endpoint=3", "reported=0.5", "user:general=2", "user:general=2"])
      assert.strictEqual((yield* recomputeCosts(deps, userId, { _tag: "Rule", ruleId: "general" }, false)).count, 0)

      // A price naming this connection replaces even the endpoint's row; still never the charge.
      yield* setRules([rule("general", 2, null), rule("own", 4, connection.id)])
      const own = yield* recomputeCosts(deps, userId, { _tag: "Rule", ruleId: "own" }, true)
      assert.strictEqual(own.changed, 3)
      assert.deepStrictEqual(yield* ledger, ["reported=0.5", "user:own=4", "user:own=4", "user:own=4"])

      // A rule that's gone re-prices nothing.
      assert.strictEqual((yield* recomputeCosts(deps, userId, { _tag: "Rule", ruleId: "missing" }, true)).changed, 0)
    }).pipe(Effect.scoped, Effect.provide(layer()))
  )

  it("re-prices a row from an older built-in table with today's, at the time it was sent", () => {
    const registry = { kinds: { get: () => ({ piProvider: "anthropic" }) } } as unknown as ProviderRegistryShape
    const connection = { kind: "anthropic", providerSettings: {} } as unknown as Connection
    const model = {
      key: "claude-sonnet-5-5",
      upstream: { price: { input: 9, output: 9 } },
      overrides: {},
      fetchedAt: 1
    } as unknown as Model
    const row = {
      ...unknownCounts,
      id: "r1",
      connectionId: "c" as Connection["id"],
      kind: "anthropic",
      modelId: "m1",
      modelKey: "claude-sonnet-5-5",
      upstream: null,
      startedAt: Date.now(),
      formula: "builtin:pi-ai@0.0.1+old",
      inputUncached: 1_000_000,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWriteLong: 0,
      output: 0
    }
    const update = repriceBuiltin(registry, connection, model, row)!
    assert.strictEqual(update.formula, `builtin:${BUILTIN_PRICE_VERSION}`)
    assert.strictEqual(update.expectFormula, "builtin:pi-ai@0.0.1+old")
    assert.strictEqual(update.cost, 2)
    assert.isNull(repriceBuiltin(registry, connection, model, { ...row, formula: `builtin:${BUILTIN_PRICE_VERSION}` }))
    assert.isNull(repriceBuiltin(registry, undefined, model, row))
  })
})

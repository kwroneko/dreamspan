// "Apply to past requests" (spec/PRICES.md §6.1, under the owner's decision that a past request
// keeps the price it was charged at): on the user's request only, re-prices closed requests that
// were priced from rates, with today's prices from the same source. Never a charge the provider
// reported (the ledger's trigger refuses it too). Reads in a reader worker, prices on the main
// thread, and writes each page in one writer transaction that skips rows changed since.
import type { CostSettings, RecomputePreview, RecomputeTarget } from "@dreamspan/shared/costFormulas.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import type { Connection, Model, ModelId } from "@dreamspan/shared/providers.ts"
import type { TokenCounts } from "@dreamspan/shared/usage.ts"
import { Effect } from "effect"
import type { Reader, Writer } from "../db/Database.ts"
import { BUILTIN_PRICE_VERSION } from "./prices/index.ts"
import { priceSources } from "./priceSources.ts"
import type { CostFormula, ProviderRegistryShape } from "./registry.ts"
import { emptyCapture, pricedCost } from "./usage.ts"
import { userCostFormula, userGeneralCostFormula } from "./userCosts.ts"

type Row = Effect.Success<ReturnType<Reader["Service"]["ListRecomputeRows"]>>[number]
type Update = Parameters<Writer["Service"]["RecomputeCosts"]>[0]["rows"][number]

const PAGE = 500

const countsOf = (row: Row): TokenCounts => ({
  inputUncached: row.inputUncached,
  cacheRead: row.cacheRead,
  cacheWrite: row.cacheWrite,
  cacheWriteLong: row.cacheWriteLong,
  output: row.output,
  reasoning: row.reasoning
})

/** The registered user formula by id (a plugin may replace it), else the built-in one. */
const formula = (registry: ProviderRegistryShape, fallback: CostFormula) => registry.costs.get(fallback.id) ?? fallback

/**
 * A row's new price under the user's prices as they are now, when the rule `ruleId` is what now
 * prices it: a rule naming the connection beats every table (and replaces even a price-endpoint
 * row, PRICES §8 Q2, recorded as the user's); an account-wide or per-type rule only replaces
 * built-in prices and other user prices, never a connection's own fetched or listed prices.
 */
const repriceByRule = (
  registry: ProviderRegistryShape,
  settings: CostSettings,
  ruleId: string,
  row: Row
): Update | null => {
  const input = {
    counts: countsOf(row),
    capture: { ...emptyCapture(), upstream: row.upstream },
    pricing: { settings, kind: row.kind, connectionId: row.connectionId, model: row.modelKey },
    price: null
  }
  const own = formula(registry, userCostFormula).cost(input)
  const fetched = /^(?:endpoint|list)(?::|$)/.test(row.formula)
  const cost = own ?? (fetched ? null : formula(registry, userGeneralCostFormula).cost(input))
  if (!cost?.formula?.startsWith(`user:${ruleId}:`) || cost.formula === row.formula || !cost.rates) return null
  return {
    id: row.id,
    expectFormula: row.formula,
    cost: cost.amount,
    currency: cost.currency,
    formula: cost.formula,
    rates: cost.rates
  }
}

/** A row priced from an older built-in table, priced from today's table at the time it was sent. */
export const repriceBuiltin = (
  registry: ProviderRegistryShape,
  connection: Connection | undefined,
  model: Model | null,
  row: Row
): Update | null => {
  if (!connection || !model || row.formula === `builtin:${BUILTIN_PRICE_VERSION}`) return null
  const kind = registry.kinds.get(connection.kind)
  if (!kind) return null
  const sources = priceSources(
    { provider: kind.piProvider, region: connection.providerSettings.region },
    model,
    row.startedAt
  )
  if (!sources.builtin) return null
  const priced = pricedCost(countsOf(row), sources.builtin.price)
  if (!priced) return null
  return {
    id: row.id,
    expectFormula: row.formula,
    cost: priced.amount,
    currency: sources.builtin.price.currency ?? "USD",
    formula: `builtin:${sources.builtin.version}`,
    rates: priced.rates
  }
}

/** Counts (and with `apply`, writes) the rows the target re-prices, page by page. */
export const recomputeCosts = (
  deps: {
    readonly reader: Reader["Service"]
    readonly writer: Writer["Service"]
    readonly registry: ProviderRegistryShape
  },
  userId: UserId,
  target: RecomputeTarget,
  apply: boolean
) =>
  Effect.gen(function* () {
    const { reader, writer, registry } = deps
    const settings = yield* reader.GetCostSettings({ userId })
    const rule = target._tag === "Rule" ? settings.rules.find((r) => r.id === target.ruleId) : undefined
    const preview: { -readonly [K in keyof RecomputePreview]: RecomputePreview[K] } = {
      count: 0,
      from: null,
      to: null
    }
    let changed = 0
    if (target._tag === "Rule" && !rule) return { ...preview, changed }
    const connections =
      target._tag === "Builtin"
        ? new Map((yield* reader.ListConnections({ userId })).map((c) => [c.id as string, c]))
        : new Map<string, Connection>()
    const models = new Map<string, Model | null>()
    const modelOf = (id: string | null) =>
      id === null
        ? Effect.succeed(null)
        : models.has(id)
          ? Effect.succeed(models.get(id)!)
          : reader.GetModel({ userId, modelId: id as ModelId }).pipe(
              Effect.orElseSucceed(() => null),
              Effect.tap((model) => Effect.sync(() => models.set(id, model)))
            )
    let afterAt = -1
    let afterId = ""
    for (;;) {
      const rows = yield* reader.ListRecomputeRows({
        userId,
        modelKey: rule?.model ?? null,
        formulaPrefix: target._tag === "Builtin" ? "builtin:" : null,
        exceptFormula: target._tag === "Builtin" ? `builtin:${BUILTIN_PRICE_VERSION}` : null,
        afterAt,
        afterId,
        limit: PAGE
      })
      if (rows.length === 0) break
      const updates: Update[] = []
      for (const row of rows) {
        const update =
          target._tag === "Rule"
            ? repriceByRule(registry, settings, target.ruleId, row)
            : repriceBuiltin(registry, connections.get(row.connectionId), yield* modelOf(row.modelId), row)
        if (!update) continue
        updates.push(update)
        preview.count++
        preview.from ??= row.startedAt
        preview.to = row.startedAt
      }
      if (apply && updates.length) changed += (yield* writer.RecomputeCosts({ userId, rows: updates })).changed
      const last = rows.at(-1)!
      afterAt = last.startedAt
      afterId = last.id
      if (rows.length < PAGE) break
    }
    return { ...preview, changed }
  })

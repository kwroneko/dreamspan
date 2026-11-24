import type { CostRule, CostSettings, CostRates } from "@dreamspan/shared/costFormulas.ts"
import { totalInputTokens } from "@dreamspan/shared/usage.ts"
import { priceBound } from "./priceSources.ts"
import type { CostFormula } from "./registry.ts"

export interface UserPricing {
  readonly settings: CostSettings
  readonly kind: string
  readonly connectionId: string
  readonly model: string
}

/**
 * Which of the user's rules a formula takes (PRICES §5.1, DESIGN §9): those naming this connection
 * beat every other price; account-wide and per-type rules never beat a connection's own fetched
 * prices, so they are a formula of their own, lower down.
 */
type Scope = "connection" | "general"

const matches = (rule: CostRule, pricing: UserPricing, scope: Scope) =>
  rule.model === pricing.model &&
  (rule.kind === null || rule.kind === pricing.kind) &&
  (scope === "connection" ? rule.connectionId === pricing.connectionId : rule.connectionId === null)
const specificity = (r: CostRule) =>
  (r.connectionId === null ? 0 : 4) + (r.kind === null ? 0 : 1) + (r.upstream === null ? 0 : 2)
const candidates = (pricing: UserPricing, scope: Scope) =>
  pricing.settings.rules
    .filter((r) => matches(r, pricing, scope))
    .map((rule, index) => ({ rule, index }))
    .sort((a, b) => specificity(b.rule) - specificity(a.rule) || b.index - a.index)
    .map((r) => r.rule)
const ratesAt = (rule: CostRule, input: number): CostRates =>
  rule.tiers
    .filter((t) => input > t.above)
    .reduce<{ above: number; rates: CostRates }>((best, t) => (t.above > best.above ? t : best), {
      above: -1,
      rates: rule.rates
    }).rates

/** Registered like built-in/plugin pricing; each request supplies its owner's snapshot. */
const userFormula = (id: string, scope: Scope): CostFormula => {
  const self: CostFormula = {
    id,
    appliesTo: () => true,
    reserves: ({ pricing }) => pricing !== undefined && candidates(pricing, scope).length > 0,
    estimate: (input) => {
      if (!input.pricing) return undefined
      const rules = candidates(input.pricing, scope)
      const generic = rules.findIndex((r) => r.upstream === null)
      const possible = generic < 0 ? rules : rules.slice(0, generic + 1)
      if (!possible.some((r) => r.upstream !== null)) return undefined
      const counts = input.counts
      const inputTokens = totalInputTokens(counts)
      if (inputTokens === null || counts.output === null) return null
      // No upstream has been selected yet. Quote the conservative route bound or unknown,
      // rather than a lower generic/catalog rate that the request may never receive.
      return self.upperBound!({
        pricing: input.pricing,
        inputTokens,
        outputTokens: counts.output,
        price: input.price,
        ...(input.sources ? { sources: input.sources } : {})
      })
    },
    cost: ({ counts, capture, pricing }) => {
      if (!pricing) return null
      const rule = candidates(pricing, scope).find((r) => r.upstream === null || r.upstream === capture.upstream)
      if (!rule) return null
      if (counts.inputUncached === null || counts.output === null) return null
      const read = counts.cacheRead ?? 0,
        write = counts.cacheWrite ?? 0
      const long = Math.min(counts.cacheWriteLong ?? 0, write)
      const rates = ratesAt(rule, counts.inputTotal ?? counts.inputUncached + read + write)
      return {
        amount:
          (counts.inputUncached * rates.input +
            read * rates.read +
            (write - long) * rates.write +
            long * rates.writeLong +
            counts.output * rates.output) /
            1e6 +
          (rule.perRequest ?? 0),
        currency: rule.currency,
        formula: `user:${rule.id}:${pricing.settings.revision}`,
        rates: {
          input: rates.input,
          read: rates.read,
          write: rates.write,
          writeLong: rates.writeLong,
          output: rates.output
        }
      }
    },
    upperBound: ({ inputTokens, outputTokens, pricing, price, sources }) => {
      if (!pricing) return null
      // The upstream and cache split are unknown before dispatch. Cover every possible route,
      // every reachable tier and built-in fallback, including a cheaper low-context tier.
      const rules = candidates(pricing, scope)
      if (!rules.length) return null
      const generic = rules.find((r) => r.upstream === null)
      const possible = generic ? rules.slice(0, rules.indexOf(generic) + 1) : rules
      const currencies = new Set(possible.map((r) => r.currency))
      const amounts = possible.map((rule) => {
        const rates = [rule.rates, ...rule.tiers.filter((t) => t.above < inputTokens).map((t) => t.rates)]
        return (
          (inputTokens * Math.max(...rates.flatMap((r) => [r.input, r.read, r.write, r.writeLong])) +
            outputTokens * Math.max(...rates.map((r) => r.output))) /
            1e6 +
          (rule.perRequest ?? 0)
        )
      })
      if (!generic) {
        // A route may have no override. No catalog price means no safe admission bound.
        const tables = price ? [price, ...(sources?.endpoint?.routes ?? []).map((route) => route.price)] : []
        const fallback =
          scope === "connection" && !sources?.endpoint && !sources?.list && candidates(pricing, "general").length > 0
            ? userGeneralCostFormula.upperBound!({ inputTokens, outputTokens, pricing, price })
            : priceBound(tables, inputTokens, outputTokens)
        if (fallback === null) return null
        currencies.add(fallback.currency)
        amounts.push(fallback.amount)
      }
      if (currencies.size !== 1) return null
      return { amount: Math.max(...amounts), currency: possible[0]!.currency }
    }
  }
  return self
}

/** The user's prices naming this connection: first of all formulas. */
export const userCostFormula = userFormula("user-pricing", "connection")
/** The user's account-wide and per-type prices: below the connection's own fetched and listed prices. */
export const userGeneralCostFormula = userFormula("user-pricing-general", "general")

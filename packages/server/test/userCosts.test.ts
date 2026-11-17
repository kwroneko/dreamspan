import { assert, it } from "@effect/vitest"
import type { CostRule } from "@rp/shared/costFormulas.ts"
import { CostRules } from "@rp/shared/costFormulas.ts"
import { type TokenCounts, unknownCounts } from "@rp/shared/usage.ts"
import { Schema } from "effect"
import { costOf, builtinCostFormulas, emptyCapture } from "../src/providers/usage.ts"
import { userCostFormula, userGeneralCostFormula, type UserPricing } from "../src/providers/userCosts.ts"

const rule: CostRule = {
  id: "contract",
  name: "Contract",
  kind: null,
  connectionId: null,
  model: "synthetic",
  upstream: null,
  currency: "credits",
  rates: { input: 1, read: 2, write: 3, writeLong: 4, output: 5 },
  tiers: []
}
const pricing: UserPricing = {
  settings: { revision: 3, rules: [rule] },
  kind: "openrouter",
  connectionId: "connection",
  model: "synthetic"
}
const counts = { ...unknownCounts, inputUncached: 10, cacheRead: 20, cacheWrite: 30, cacheWriteLong: 10, output: 40 }
const target = { kind: pricing.kind, api: "openai-completions", model: pricing.model }
const cost = (p = pricing, capture = emptyCapture(), input: TokenCounts = counts) =>
  costOf(builtinCostFormulas, target, {
    counts: input,
    capture,
    pricing: p,
    price: { input: 7, output: 8 }
  })
const bound = (p = pricing, inputTokens = 60) =>
  userGeneralCostFormula.upperBound!({ pricing: p, inputTokens, outputTokens: 40, price: { input: 7, output: 8 } })
it("prices the five normalized counts with an independent long-write rate and display label", () => {
  assert.deepEqual(cost(), {
    amount: 350 / 1e6,
    currency: "credits",
    formula: "user:contract:3",
    rates: { input: 1, read: 2, write: 3, writeLong: 4, output: 5 }
  })
})
it("adds a flat per-request amount, in the bound too", () => {
  const flat = { ...pricing, settings: { revision: 3, rules: [{ ...rule, perRequest: 0.5 }] } }
  assert.equal(cost(flat)!.amount, 350 / 1e6 + 0.5)
  assert.equal(bound(flat)!.amount, bound()!.amount + 0.5)
})
it("switches the whole request at the highest exceeded context threshold", () => {
  const p = {
    ...pricing,
    settings: {
      ...pricing.settings,
      rules: [
        {
          ...rule,
          tiers: [
            { above: 59, rates: { ...rule.rates, input: 10 } },
            { above: 60, rates: { ...rule.rates, input: 100 } }
          ]
        }
      ]
    }
  }
  assert.equal(cost(p)!.amount, 440 / 1e6)
  assert.equal(cost(p, emptyCapture(), { ...counts, inputUncached: 11 })!.amount, 1440 / 1e6)
})
it("matches exact model, provider, connection and routed upstream, with specific and last rules first", () => {
  const specific = {
    ...rule,
    id: "specific",
    connectionId: "connection" as CostRule["connectionId"],
    upstream: "route",
    rates: { ...rule.rates, output: 10 }
  }
  const p = { ...pricing, settings: { ...pricing.settings, rules: [specific, rule] } }
  assert.equal(cost(p, { ...emptyCapture(), upstream: "route" })!.formula, "user:specific:3")
  assert.equal(cost(p, { ...emptyCapture(), upstream: "other" })!.formula, "user:contract:3")
  for (const mismatch of [
    { model: "other" },
    { kind: "other" },
    { connectionId: "other" as CostRule["connectionId"] }
  ]) {
    const p = { ...pricing, settings: { revision: 4, rules: [{ ...rule, ...mismatch }] } }
    assert.equal(cost(p)!.formula, "builtin")
  }
  assert.equal(
    cost({ ...pricing, settings: { revision: 4, rules: [rule, { ...rule, id: "last" }] } })!.formula,
    "user:last:4"
  )
})
it("overrides provider-reported prices only for this connection, preserves unknown counts and falls back when no rule matches", () => {
  // An account-wide or per-type price is below the provider's own charge (PRICES §5.1).
  assert.equal(cost(pricing, { ...emptyCapture(), reportedCost: 9 })!.formula, "reported")
  const own = { ...rule, connectionId: "connection" as CostRule["connectionId"] }
  assert.equal(
    cost({ ...pricing, settings: { revision: 3, rules: [own] } }, { ...emptyCapture(), reportedCost: 9 })!.formula,
    "user:contract:3"
  )
  assert.isTrue(userCostFormula.reserves!({ pricing: { ...pricing, settings: { revision: 3, rules: [own] } } }))
  assert.isFalse(userCostFormula.reserves!({ pricing }))
  assert.isNull(cost(pricing, emptyCapture(), { ...counts, inputUncached: null }))
  assert.equal(
    cost({ ...pricing, settings: { revision: 0, rules: [] } }, { ...emptyCapture(), reportedCost: 9 })!.formula,
    "reported"
  )
})
it("bounds every cache split, reachable tier and route, including decreasing tiers", () => {
  const p = {
    ...pricing,
    settings: {
      revision: 1,
      rules: [{ ...rule, tiers: [{ above: 10, rates: { input: 0, read: 0, write: 0, writeLong: 0, output: 0 } }] }]
    }
  }
  assert.equal(bound(p)!.amount, 440 / 1e6)
  for (let i = 0; i <= 60; i++) {
    const actual = cost(p, emptyCapture(), {
      ...counts,
      inputUncached: i,
      cacheRead: 0,
      cacheWrite: 60 - i,
      cacheWriteLong: 60 - i
    })!
    assert.isAtMost(actual.amount, bound(p)!.amount)
  }
  const routes = {
    ...pricing,
    settings: {
      revision: 1,
      rules: [{ ...rule, currency: "USD", upstream: "route", rates: { ...rule.rates, writeLong: 100 } }]
    }
  }
  assert.equal(bound(routes)!.amount, 6200 / 1e6)
  assert.isTrue(userGeneralCostFormula.reserves!({ pricing: routes }))
  assert.isNull(bound({ ...routes, settings: { revision: 1, rules: [{ ...rule, upstream: "route" }] } }))
  assert.isNull(userGeneralCostFormula.upperBound!({ pricing: routes, inputTokens: 60, outputTokens: 40, price: null }))
})
it("rejects code, non-finite or negative rates, duplicate ids and oversized expressions", () => {
  for (const rules of [
    [{ ...rule, rates: { ...rule.rates, input: -1 } }],
    [{ ...rule, rates: { ...rule.rates, input: Infinity } }],
    [{ ...rule, rates: "process.exit()" }],
    [rule, rule],
    Array.from({ length: 101 }, (_, i) => ({ ...rule, id: String(i) })),
    [{ ...rule, tiers: Array.from({ length: 17 }, () => ({ above: 0, rates: rule.rates })) }]
  ])
    assert.equal(Schema.decodeUnknownExit(CostRules)(rules)._tag, "Failure")
})

it("estimates unknown upstream routes conservatively, and refuses mixed labels", () => {
  const route = { ...rule, id: "route", upstream: "route", rates: { ...rule.rates, input: 100 } }
  const p = { ...pricing, settings: { revision: 1, rules: [rule, route] } }
  const estimate = costOf(
    builtinCostFormulas,
    target,
    { counts, pricing: p, capture: emptyCapture(), price: { input: 1, output: 1 } },
    true
  )
  assert.equal(estimate!.amount, 6200 / 1e6)
  assert.equal(estimate!.currency, "credits")
  const mixed = { ...p, settings: { revision: 2, rules: [{ ...rule, currency: "USD" }, route] } }
  assert.isNull(
    costOf(
      builtinCostFormulas,
      target,
      { counts, pricing: mixed, capture: emptyCapture(), price: { input: 1, output: 1 } },
      true
    )
  )
})

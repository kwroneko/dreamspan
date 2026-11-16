// Declarative token pricing: bounded, non-negative, and never executable code.
import { Schema } from "effect"
import { ConnectionId } from "./providers.ts"
const Rate = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1e9))
const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160))
export const CostRates = Schema.Struct({ input: Rate, read: Rate, write: Rate, writeLong: Rate, output: Rate })
export type CostRates = typeof CostRates.Type
export const CostRule = Schema.Struct({
  id: Text,
  name: Text,
  kind: Schema.NullOr(Text),
  connectionId: Schema.NullOr(ConnectionId),
  model: Text,
  upstream: Schema.NullOr(Text),
  currency: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16)),
  rates: CostRates,
  /** A flat amount per request, in `currency`, on top of the token rates. */
  perRequest: Schema.optionalKey(Rate),
  tiers: Schema.Array(
    Schema.Struct({
      above: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1e9)),
      rates: CostRates
    })
  ).check(
    Schema.isMaxLength(16),
    Schema.makeFilter(
      (tiers) => new Set(tiers.map((t) => t.above)).size === tiers.length || "Context tier thresholds must be unique"
    )
  )
})
export type CostRule = typeof CostRule.Type
export const CostRules = Schema.Array(CostRule).check(
  Schema.isMaxLength(100),
  Schema.makeFilter((rules) => new Set(rules.map((r) => r.id)).size === rules.length || "Formula ids must be unique")
)
export const CostSettings = Schema.Struct({ revision: Schema.Int, rules: CostRules })
export type CostSettings = typeof CostSettings.Type

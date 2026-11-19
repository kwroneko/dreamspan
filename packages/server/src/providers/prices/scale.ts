import type { Price } from "@dreamspan/shared/providers.ts"

/** Every rate of a price (tiers included, thresholds not) multiplied, rounded to 1e-9. */
export const scalePrice = (price: Price, by: number): Price => {
  if (by === 1) return price
  const r = (n: number) => Math.round(n * by * 1e9) / 1e9
  const rates = <T extends Price | NonNullable<Price["tiers"]>[number]>(p: T): T =>
    Object.fromEntries(
      Object.entries(p).map(([k, v]) => [k, typeof v === "number" && k !== "inputTokensAbove" ? r(v) : v])
    ) as T
  return { ...rates(price), ...(price.tiers ? { tiers: price.tiers.map(rates) } : {}) }
}

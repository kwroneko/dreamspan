// Which prices a request's model has, by source (spec/PRICES.md §3.1, §5.1). The formulas
// (usage.ts, userCosts.ts) pick among them in the owner's order.
import { type Model, routedPrice } from "@dreamspan/shared/providers.ts"
import { BUILTIN_PRICE_VERSION, type PriceContext, supplementPrice } from "./prices/index.ts"
import type { PriceSources } from "./registry.ts"

type PricedModel = Pick<Model, "key" | "upstream" | "overrides" | "fetchedAt">

/**
 * A stored model's prices for its routing as saved, at a moment (the built-in table has dated
 * changes and off-peak hours). The supplement replaces the stored catalog price whole; a list
 * price stays the list's.
 */
export const priceSources = (
  context: PriceContext & { readonly priceEndpoint?: boolean | undefined },
  model: PricedModel,
  at: number
): PriceSources => {
  const upstream = model.upstream
  const routing = { ...upstream.settings, ...model.overrides.settings }.routing
  const routed = routedPrice(upstream, routing)
  const pinned = routed.source?.state === "pinned" && routed.price !== null && upstream.endpoints !== undefined
  const fromList = upstream.priceFrom === "list" && upstream.price !== undefined
  const list = pinned
    ? { price: routed.price!, fetchedAt: upstream.endpoints!.fetchedAt, endpoints: true }
    : fromList
      ? { price: upstream.price!, fetchedAt: model.fetchedAt, endpoints: false }
      : null
  const table = supplementPrice(context, model.key, at)
  const stored = upstream.priceFrom !== "list" ? (upstream.price ?? null) : null
  const builtin = table ?? stored
  // The endpoint's price counts only while the user has it on (turning it off restores the rest
  // without a refresh, PRICES §3.1); a rate it leaves unknown comes from the next source (§4.3).
  const feed = context.priceEndpoint === true ? upstream.priceFeed : undefined
  const next = list?.price ?? builtin
  const endpoint =
    feed?.price && feed.available !== false
      ? {
          price: {
            ...(next?.cacheRead === undefined ? {} : { cacheRead: next.cacheRead }),
            ...(next?.cacheWrite === undefined ? {} : { cacheWrite: next.cacheWrite }),
            ...(next?.cacheWriteLong === undefined ? {} : { cacheWriteLong: next.cacheWriteLong }),
            ...feed.price
          },
          fetchedAt: feed.fetchedAt
        }
      : null
  return {
    endpoint,
    list,
    builtin: builtin === null ? null : { price: builtin, version: BUILTIN_PRICE_VERSION }
  }
}

/** The first known price, for formulas that take one rate table. */
export const firstPrice = (sources: PriceSources) =>
  sources.endpoint?.price ?? sources.list?.price ?? sources.builtin?.price ?? null

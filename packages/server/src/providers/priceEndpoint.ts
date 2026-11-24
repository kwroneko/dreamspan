// The opt-in price endpoint (spec/PRICES.md §4): `GET {base}/v1/prices` on a connection whose
// user turned on `priceEndpoint`. Nothing here runs for any other connection.
import type { Price, PriceFeed, PriceFeedRoute } from "@dreamspan/shared/providers.ts"
import { Predicate } from "effect"

/** `{base}` without a trailing `/v1`, so `https://gw.example/v1` and `https://gw.example` both probe the same path. */
export const priceListUrl = (baseUrl: string) => `${baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "")}/v1/prices`

/** The `CostRule` bound: a rate outside it is unknown, not the whole response wrong. */
const MAX_RATE = 1e9
const rate = (value: unknown): number | undefined =>
  Predicate.isNumber(value) && Number.isFinite(value) && value >= 0 && value <= MAX_RATE ? value : undefined

const ttlSeconds = (key: string): number | null => {
  const m = /^(\d+)([smh])$/.exec(key)
  return m ? Number(m[1]) * { s: 1, m: 60, h: 3600 }[m[2] as "s" | "m" | "h"] : null
}

/**
 * `cache_write`: one rate for every TTL, or rates by TTL. The short rate is `5m` (else the
 * shortest), the long rate `1h` (else the longest TTL of an hour or more).
 */
const cacheWrites = (value: unknown): Pick<Price, "cacheWrite" | "cacheWriteLong"> => {
  const one = rate(value)
  if (one !== undefined) return { cacheWrite: one, cacheWriteLong: one }
  if (!Predicate.isObject(value)) return {}
  const ttls = Object.entries(value as Record<string, unknown>)
    .map(([key, v]) => ({ s: ttlSeconds(key), v: rate(v) }))
    .filter((t): t is { s: number; v: number } => t.s !== null && t.v !== undefined)
    .sort((a, b) => a.s - b.s)
  const short = ttls.find((t) => t.s === 300) ?? ttls[0]
  const long = ttls.find((t) => t.s === 3600) ?? ttls.filter((t) => t.s >= 3600).at(-1)
  return {
    ...(short ? { cacheWrite: short.v } : {}),
    ...(long ? { cacheWriteLong: long.v } : {})
  }
}

type Rates = Pick<Price, "input" | "output" | "cacheRead" | "cacheWrite" | "cacheWriteLong" | "reasoning">

/** The known rates of one entry or tier; an absent, null or out-of-range rate is left out (unknown). */
const ratesOf = (entry: Record<string, unknown>): Partial<Rates> => {
  const input = rate(entry.input)
  const output = rate(entry.output)
  const read = rate(entry.cache_read)
  const reasoning = rate(entry.reasoning)
  return {
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(read === undefined ? {} : { cacheRead: read }),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...cacheWrites(entry.cache_write)
  }
}

/**
 * One model's (or route's) price from its entry: null when `input` or `output` is unknown
 * (§4.3). `under` is what a route's unknown fields fall back to: its model's own rates.
 */
const priceOf = (
  entry: Record<string, unknown>,
  currency: string,
  { perRequest: underPerRequest, ...under }: Partial<Rates> & { readonly perRequest?: number } = {}
): Price | null => {
  const base = { ...under, ...ratesOf(entry) }
  if (base.input === undefined || base.output === undefined) return null
  const perRequest = rate(entry.per_request) ?? underPerRequest
  const tiers = Array.isArray(entry.tiers)
    ? entry.tiers.flatMap((tier: unknown) => {
        if (!Predicate.isObject(tier)) return []
        const t = tier as Record<string, unknown>
        const above = rate(t.input_above)
        const fee = rate(t.per_request)
        // "A field missing from a tier keeps the base rate."
        return above === undefined
          ? []
          : [
              {
                ...base,
                ...ratesOf(t),
                inputTokensAbove: above,
                ...(fee === undefined ? {} : { perRequest: fee })
              } as NonNullable<Price["tiers"]>[number]
            ]
      })
    : []
  return {
    ...(base as Rates),
    ...(perRequest === undefined ? {} : { perRequest }),
    ...(currency === "USD" ? {} : { currency }),
    ...(tiers.length ? { tiers } : {})
  }
}

interface PriceListEntry {
  readonly price: Price | null
  readonly available?: boolean
  readonly servedBy?: string
  readonly pctOfList?: number
  readonly routes?: ReadonlyArray<PriceFeedRoute>
}

export interface PriceList {
  readonly currency: string
  readonly validUntil: number | null
  readonly models: ReadonlyMap<string, PriceListEntry>
}

const label = (value: unknown) =>
  Predicate.isString(value) && value.length > 0 && value.length <= 256 ? value : undefined
const percent = (value: unknown) =>
  Predicate.isNumber(value) && Number.isFinite(value) && value >= 0 && value <= 1e6 ? value : undefined

/** The model's routes (§4.4): each route's rates over the model's own, at most 64. */
const routesOf = (entry: Record<string, unknown>, currency: string): ReadonlyArray<PriceFeedRoute> => {
  if (!Array.isArray(entry.routes)) return []
  const perRequest = rate(entry.per_request)
  const under = { ...ratesOf(entry), ...(perRequest === undefined ? {} : { perRequest }) }
  return entry.routes.slice(0, 64).flatMap((item: unknown): PriceFeedRoute[] => {
    if (!Predicate.isObject(item)) return []
    const route = item as Record<string, unknown>
    const target = label(route.target)
    const upstream = label(route.upstream)
    if (target === undefined && upstream === undefined) return []
    const listInput = rate(route.list_input)
    const listOutput = rate(route.list_output)
    const pctOfList = percent(route.pct_of_list)
    return [
      {
        ...(target === undefined ? {} : { target }),
        ...(upstream === undefined ? {} : { upstream }),
        // A route's own tiers only; the model's tiers are the model's.
        price: priceOf(route, currency, under),
        ...(listInput === undefined ? {} : { listInput }),
        ...(listOutput === undefined ? {} : { listOutput }),
        ...(pctOfList === undefined ? {} : { pctOfList })
      }
    ]
  })
}

const UNIT = /^(\S{1,16}) per 1M tokens$/

/**
 * A `/v1/prices` body (§4.2), or null when it isn't one this client understands: not a list, or a
 * `unit` other than "<currency> per 1M tokens". Bad entries are skipped, not fatal.
 */
export const parsePriceList = (body: unknown): PriceList | null => {
  if (!Predicate.isObject(body)) return null
  const b = body as Record<string, unknown>
  if (b.object !== "list" || !Array.isArray(b.data) || !Predicate.isString(b.unit)) return null
  const unit = UNIT.exec(b.unit)
  if (!unit) return null
  const currency =
    Predicate.isString(b.currency) && b.currency.length > 0 && b.currency.length <= 16 ? b.currency : unit[1]!
  const until = Predicate.isString(b.valid_until) ? Date.parse(b.valid_until) : NaN
  const models = new Map<string, { price: Price | null; available?: boolean }>()
  for (const item of b.data) {
    if (!Predicate.isObject(item)) continue
    const entry = item as Record<string, unknown>
    if (!Predicate.isString(entry.id) || entry.id.length === 0 || entry.id.length > 512) continue
    const servedBy = label(entry.served_by)
    const pctOfList = percent(entry.pct_of_list)
    const routes = routesOf(entry, currency)
    models.set(entry.id, {
      price: priceOf(entry, currency),
      ...(Predicate.isBoolean(entry.available) ? { available: entry.available } : {}),
      ...(servedBy === undefined ? {} : { servedBy }),
      ...(pctOfList === undefined ? {} : { pctOfList }),
      ...(routes.length ? { routes } : {})
    })
  }
  return { currency, validUntil: Number.isFinite(until) ? until : null, models }
}

/** `Cache-Control: max-age`, in milliseconds; null when absent. */
const maxAgeMs = (header: string | null) => {
  const match = /(?:^|,)\s*max-age\s*=\s*"?(\d{1,10})"?\s*(?:,|$)/i.exec(header ?? "")
  return match ? Number(match[1]) * 1000 : null
}

/** What one probe found (§4.5). `maxAgeMs` is the response's `Cache-Control: max-age`. */
export type PriceProbe =
  | {
      readonly state: "supported"
      readonly list: PriceList
      readonly etag: string | null
      readonly maxAgeMs: number | null
    }
  | { readonly state: "unchanged"; readonly maxAgeMs: number | null }
  | { readonly state: "unsupported" | "denied" | "failed"; readonly detail: string }

/** Asks the connection's own server for its price list, with the headers `/v1/models` gets. */
export const fetchPriceList = async (
  fetch: typeof globalThis.fetch,
  baseUrl: string,
  headers: Readonly<Record<string, string>>,
  etag: string | null,
  signal?: AbortSignal
): Promise<PriceProbe> => {
  let response: Response
  try {
    response = await fetch(priceListUrl(baseUrl), {
      method: "GET",
      headers: { accept: "application/json", ...headers, ...(etag ? { "if-none-match": etag } : {}) },
      ...(signal ? { signal } : {})
    })
  } catch (error) {
    return { state: "failed", detail: error instanceof Error ? error.message : String(error) }
  }
  if (response.status === 304) {
    await response.body?.cancel()
    return { state: "unchanged", maxAgeMs: maxAgeMs(response.headers.get("cache-control")) }
  }
  if (!response.ok) await response.body?.cancel().catch(() => {})
  if ([404, 405, 501].includes(response.status))
    return { state: "unsupported", detail: `This server doesn't publish prices (${response.status})` }
  if (response.status === 401 || response.status === 403)
    return { state: "denied", detail: `The key isn't accepted for prices (${response.status})` }
  if (!response.ok) return { state: "failed", detail: `HTTP ${response.status}` }
  const list = parsePriceList(await response.json().catch(() => null))
  if (list === null) return { state: "failed", detail: "not a price list this app understands" }
  return {
    state: "supported",
    list,
    etag: response.headers.get("etag"),
    maxAgeMs: maxAgeMs(response.headers.get("cache-control"))
  }
}

/**
 * The feed to store for each of the connection's models: null for one the price list doesn't name,
 * whose price is then unknown to the endpoint (§4.3). A model only the price list names isn't
 * created (§4.7).
 */
export const feedsFor = (
  keys: ReadonlyArray<string>,
  probe: Extract<PriceProbe, { state: "supported" }>,
  fetchedAt: number
): ReadonlyArray<{ readonly key: string; readonly feed: PriceFeed | null }> =>
  keys.map((key) => {
    const found = probe.list.models.get(key)
    if (!found) return { key, feed: null }
    const validUntil = probe.list.validUntil ?? (probe.maxAgeMs === null ? null : fetchedAt + probe.maxAgeMs)
    const feed: PriceFeed = {
      fetchedAt,
      currency: probe.list.currency,
      price: found.price,
      ...(validUntil === null ? {} : { validUntil }),
      ...(probe.etag === null ? {} : { etag: probe.etag.slice(0, 256) }),
      ...(found.available === undefined ? {} : { available: found.available }),
      ...(found.servedBy === undefined ? {} : { servedBy: found.servedBy }),
      ...(found.pctOfList === undefined ? {} : { pctOfList: found.pctOfList }),
      ...(found.routes ? { routes: found.routes } : {})
    }
    return { key, feed }
  })

const MINUTE = 60_000
/** Prices are asked for again at `valid_until` (or `max-age`), clamped to 5 minutes to a day; else hourly (§4.6). */
const PRICE_REFRESH_MS = 60 * MINUTE
const PRICE_REFRESH_MIN_MS = 5 * MINUTE
const PRICE_REFRESH_MAX_MS = 24 * 60 * MINUTE
/** A failure is asked about again after ten minutes, as the endpoint lists are (ENDPOINTS_RETRY_MS). */
export const PRICE_RETRY_MS = 10 * MINUTE

/** When to ask again after a fetch at `at` that the server says is good until `validUntil`. */
export const nextPriceFetch = (at: number, validUntil: number | null | undefined) =>
  at +
  Math.min(
    PRICE_REFRESH_MAX_MS,
    Math.max(PRICE_REFRESH_MIN_MS, validUntil === null || validUntil === undefined ? PRICE_REFRESH_MS : validUntil - at)
  )

// The cardex adapter (spec/CARD-SOURCES.md §11 phase 4): cardex is a public card archive run by
// a third party, read through its public API v1 (https://cardex.zip/docs/api; frozen, additive
// only). Anonymous, 10 requests/s with a burst of 60 per address, 429 with Retry-After.
//
// What v1 gives and how it maps:
// - `/api/v1/capabilities` describes the filters by name, type and allowed values, with no
//   labels; this adapter offers the ones that suit a character browser, labelled here, and
//   only those the archive still lists.
// - `/api/v1/search` pages two ways: text search (`mode=fts`) with an opaque `next_cursor`,
//   semantic search with page numbers (240 results at most, no cursor, no sort). The page token
//   handed out is `c:<cursor>` or `p:<n>`, so the client never needs to know which.
// - A card is fetched as `/api/v1/cards/batch?ids=<slug>` (its summary and file hash) and then
//   `/api/v1/download/<sha256>` as the archive's mirrored PNG (the card in its `chara`/`ccv3`
//   chunks, its portrait the image itself); a card whose original is CHARX has no derived PNG
//   and is fetched as that original.
// - Batches are sent sorted and without duplicates, comma-joined as `%2C`: cardex's canonical
//   form, which it otherwise answers with a 308.
// - Pictures are `/t/<sha256>.512.webp` and `/i/<sha256>.<ext>` on cardex.zip, given as paths.
// Registered only where FAKE_CARD_SOURCE is unset (runMain.ts). Tests and the development
// instance point this same adapter at the fake archive's origin instead
// (test/support/fakeArchive.ts, `dev/fakeCardSource.ts`), so it never reaches cardex.zip there.
import { CARDEX_SITE_LABELS, SourceFailed } from "@rp/shared/cardSources.ts"
import type { SourceCapabilities, SourceFilter, SourceQuery } from "@rp/shared/cardSources.ts"
import { Effect } from "effect"
import type { AdapterSummary, CardSourceAdapter, SourceHttp, SourceResponse } from "./adapter.ts"

export const CARDEX_ORIGIN = "https://cardex.zip"
/** Results per page: a multiple of the grid's usual 2 to 6 columns. */
const PAGE_SIZE = 48
/** cardex's batch limit. */
const BATCH_MAX = 100

/** v1's `CardSummary` (frozen); unknown fields are ignored. */
interface Summary {
  readonly slug: string
  readonly url?: string | null
  readonly name?: string | null
  readonly tagline?: string | null
  readonly creator?: {
    readonly name?: string | null
    readonly source?: string | null
    readonly handle?: string | null
  } | null
  readonly tags?: ReadonlyArray<string> | null
  readonly nsfw?: boolean | null
  readonly token_count?: number | null
  readonly stats?: { readonly popularity?: number | null } | null
  readonly thumbnail_url?: string | null
  readonly image_url?: string | null
  readonly version?: string | null
  readonly updated_at?: string | null
  readonly superseded_by?: string | null
}

/** v1's capabilities: each filter by its parameter name. */
interface Capabilities {
  readonly filters: ReadonlyArray<{
    readonly name: string
    readonly type: string
    readonly allowed_values?: ReadonlyArray<string> | null
    readonly default?: unknown
    readonly min?: number | null
    readonly max?: number | null
  }>
  readonly sorts: ReadonlyArray<string>
  readonly modes?: ReadonlyArray<{ readonly name: string }> | null
}

const ID = "cardex"
const bad = (message = "cardex sent something this app can't read") =>
  new SourceFailed({ sourceId: ID, reason: "bad_response", message })

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** A URL cardex gave (absolute, or a path on its origin), kept only when it is on that origin. */
const onOrigin = (origin: string, raw: string | null | undefined) => {
  if (!raw) return undefined
  const url = URL.canParse(raw, origin) ? new URL(raw, origin) : null
  return url && url.origin === origin ? url.href : undefined
}

/** A creator as the `author` filter takes it: `source/handle`. */
const authorOf = (creator: Summary["creator"]) =>
  creator?.source && creator.handle ? `${creator.source}/${creator.handle}` : undefined

/** A v1 `CardSummary` as ours, its pictures and page resolved against `origin`; null when it has no slug. */
export const summaryOf = (item: Summary, origin = CARDEX_ORIGIN): AdapterSummary | null => {
  if (typeof item?.slug !== "string" || item.slug === "") return null
  const updated = item.updated_at ? Date.parse(item.updated_at) : Number.NaN
  const thumb = onOrigin(origin, item.thumbnail_url)
  const image = onOrigin(origin, item.image_url)
  const url = onOrigin(origin, item.url ?? `/c/${encodeURIComponent(item.slug)}`)
  const author = authorOf(item.creator)
  const popularity = item.stats?.popularity
  return {
    remoteId: item.slug,
    name: item.name?.trim() || item.slug,
    ...(item.creator?.name ? { creator: item.creator.name } : {}),
    ...(author ? { creatorQuery: author } : {}),
    ...(item.tagline ? { tagline: item.tagline } : {}),
    tags: Array.isArray(item.tags) ? item.tags.filter((t): t is string => typeof t === "string") : [],
    ...(item.nsfw ? { rating: "Mature" } : {}),
    ...(typeof item.token_count === "number" ? { tokens: item.token_count } : {}),
    ...(thumb ? { thumb } : {}),
    ...(image ? { image } : {}),
    version: {
      id: item.version ?? "",
      ...(Number.isNaN(updated) ? {} : { updatedAt: updated }),
      ...(item.superseded_by ? { supersededBy: item.superseded_by } : {})
    },
    ...(url ? { url } : {}),
    ...(typeof popularity === "number" ? { stats: { popularity } } : {})
  }
}

const summaries = (items: unknown, origin: string) =>
  Array.isArray(items) ? items.flatMap((item) => summaryOf(item as Summary, origin) ?? []) : null

/** The page token handed out: `c:<cursor>` (text search) or `p:<n>` (semantic search). */
const pageOf = (token: string | null): { readonly cursor: string } | { readonly page: number } | null => {
  if (token?.startsWith("c:") && token.length > 2) return { cursor: token.slice(2) }
  const page = token?.startsWith("p:") ? Number(token.slice(2)) : Number.NaN
  return Number.isInteger(page) && page >= 1 ? { page } : null
}

// The labels cardex's descriptors don't carry. A filter it no longer lists is left out.
const RATING_LABELS: Record<string, string> = { exclude: "Safe", include: "Everything", only: "Mature only" }
const MODE_LABELS: Record<string, string> = { fts: "Words", semantic: "Meaning" }
const SORTS: ReadonlyArray<{ readonly id: string; readonly label: string; readonly needs: ReadonlyArray<string> }> = [
  { id: "popular", label: "Popular", needs: ["popular"] },
  { id: "newest", label: "Newest", needs: ["newest", "oldest"] },
  { id: "name", label: "Name", needs: ["name"] },
  { id: "tokens", label: "Tokens", needs: ["tokens_desc", "tokens_asc"] },
  { id: "relevance", label: "Best match", needs: ["relevance"] }
]
/** Our sort and direction as cardex's sort; null leaves it to cardex. */
const sortParam = (query: SourceQuery) => {
  switch (query.sort) {
    case "popular":
      return "popular"
    case "name":
      return "name"
    case "newest":
      return query.reverse ? "oldest" : "newest"
    case "tokens":
      return query.reverse ? "tokens_asc" : "tokens_desc"
    // Best match ranks by the words; with none, cardex's own order for it is popularity.
    case "relevance":
      return query.text.trim() ? "relevance" : "popular"
    default:
      return null
  }
}

export const capabilitiesOf = (raw: unknown): SourceCapabilities => {
  if (!isRecord(raw) || !Array.isArray(raw.filters) || !Array.isArray(raw.sorts)) throw bad()
  const body = raw as unknown as Capabilities
  const named = new Map(body.filters.filter(isRecord).map((f) => [f.name, f]))
  const allowed = (name: string) => (named.get(name)?.allowed_values ?? []).filter((v) => typeof v === "string")
  const filters: Array<SourceFilter> = []
  const ratings = allowed("nsfw").filter((v) => v in RATING_LABELS)
  if (ratings.length) {
    filters.push({
      id: "nsfw",
      label: "Rating",
      kind: "choice",
      multi: false,
      options: ["exclude", "include", "only"]
        .filter((v) => ratings.includes(v))
        .map((value) => ({ value, label: RATING_LABELS[value]! }))
    })
  }
  const modes = (body.modes ?? []).map((m) => m?.name).filter((m): m is string => !!m && m in MODE_LABELS)
  if (modes.length > 1) {
    filters.push({
      id: "mode",
      label: "Match",
      kind: "choice",
      multi: false,
      options: modes.map((value) => ({ value, label: MODE_LABELS[value]! })),
      about:
        "Words finds cards that contain your words; Meaning finds cards about what you describe. Meaning shows up to 240 cards and uses its own order."
    })
  }
  if (named.has("min_tokens") && named.has("max_tokens")) {
    const max = named.get("max_tokens")?.max
    filters.push({
      id: "tokens",
      label: "Tokens",
      kind: "range",
      unit: "tokens",
      min: 0,
      ...(typeof max === "number" ? { max } : {}),
      about: "cardex leaves out characters under 30 tokens unless you set a minimum."
    })
  }
  if (named.has("exclude_forks")) filters.push({ id: "exclude_forks", label: "Leave out forks", kind: "toggle" })
  const sites = allowed("source")
  if (sites.length) {
    filters.push({
      id: "source",
      label: "Site",
      kind: "choice",
      multi: true,
      options: sites.map((value) => ({ value, label: CARDEX_SITE_LABELS[value] ?? value })),
      about: "Only cards cardex found on these sites."
    })
  }
  if (named.has("author")) {
    filters.push({
      id: "author",
      label: "Creator",
      kind: "text",
      about: "One creator's cards, written as site/name, for example chub/someone."
    })
  }
  const nsfwDefault = named.get("nsfw")?.default
  return {
    text: true,
    tags: { include: named.has("tags"), exclude: named.has("not_tags"), suggest: true },
    filters,
    sorts: SORTS.filter((s) => s.needs.every((n) => body.sorts.includes(n))).map((s) => ({
      id: s.id,
      label: s.label,
      reversible: s.needs.length > 1
    })),
    ...(ratings.length
      ? { ratings: { filterId: "nsfw", default: typeof nsfwDefault === "string" ? nsfwDefault : null } }
      : {}),
    paging: "cursor",
    stats: [{ id: "popularity", label: "popularity" }]
  }
}

/** The query as cardex's search parameters. Only what the user chose is sent (§5.3). */
export const searchParams = (query: SourceQuery, token: string | null) => {
  const params = new URLSearchParams()
  const semantic = query.filters.mode === "semantic"
  const text = query.text.trim()
  if (text) params.set("q", text)
  if (query.tags.length) params.set("tags", [...new Set(query.tags)].slice(0, 20).join(","))
  if (query.excludeTags.length) params.set("not_tags", [...new Set(query.excludeTags)].slice(0, 20).join(","))
  params.set("kind", "character")
  for (const [id, value] of Object.entries(query.filters)) {
    if (id === "tokens") {
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        const range = value as { readonly min?: number; readonly max?: number }
        if (range.min !== undefined) params.set("min_tokens", String(Math.max(0, Math.round(range.min))))
        if (range.max !== undefined) params.set("max_tokens", String(Math.max(0, Math.round(range.max))))
      }
    } else if (id === "mode") {
      if (value === "semantic" || value === "fts") params.set("mode", value)
    } else if (id === "nsfw" || id === "author") {
      if (typeof value === "string" && value.trim()) params.set(id, value.trim())
    } else if (id === "source") {
      const sites = Array.isArray(value) ? value : typeof value === "string" ? [value] : []
      if (sites.length) params.set("source", [...new Set(sites)].sort().join(","))
    } else if (id === "exclude_forks") {
      if (value === true) params.set("exclude_forks", "true")
    }
  }
  const sort = semantic ? null : sortParam(query)
  if (sort) params.set("sort", sort)
  params.set("limit", String(PAGE_SIZE))
  const page = pageOf(token)
  if (page && "cursor" in page && !semantic) params.set("cursor", page.cursor)
  if (page && "page" in page) params.set("page", String(page.page))
  return params
}

/** cardex's batch URL in its canonical form: sorted, without duplicates, joined by `%2C`. */
export const batchUrl = (ids: ReadonlyArray<string>, origin = CARDEX_ORIGIN) => {
  const url = new URL("/api/v1/cards/batch", origin)
  url.search = new URLSearchParams({ ids: [...new Set(ids)].sort().join(",") }).toString()
  return url
}

const json = (response: SourceResponse) => Effect.try({ try: () => response.json(), catch: () => bad() })

const getJson = (http: SourceHttp, url: URL) => Effect.flatMap(http.get(url, "json"), json)

/** A file name from `Content-Disposition`, else the slug with the type's extension. */
const fileNameOf = (response: SourceResponse, slug: string) => {
  const disposition = response.headers.get("content-disposition") ?? ""
  const named = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1]
  if (named) {
    try {
      const decoded = decodeURIComponent(named).replace(/[\\/]/g, "_").trim()
      if (decoded) return decoded
    } catch {
      /* the slug's name below */
    }
  }
  const type = response.headers.get("content-type") ?? ""
  return `${slug}.${type.includes("png") ? "png" : type.includes("json") ? "json" : "charx"}`
}

/**
 * Which card sources a server started from `main.ts` registers, by `FAKE_CARD_SOURCE`: unset,
 * the real cardex adapter (production); `off`, none; anything else, the fake archive in its
 * place. Only an unset variable reaches cardex.zip, so the development instance and the tests,
 * which set it, never do.
 */
export const cardSourceSetup = (setting: string | undefined): "cardex" | "none" | "fake" =>
  setting === undefined ? "cardex" : setting === "off" ? "none" : "fake"

export interface CardexOptions {
  /** Where its API is: cardex.zip, or the fake archive's origin in tests and on the development instance. */
  readonly origin?: string
}

export const cardexAdapter = (options: CardexOptions = {}): CardSourceAdapter => {
  const base = new URL(options.origin ?? CARDEX_ORIGIN)
  const origin = base.origin
  const plain = base.protocol === "http:"
  const api = (path: string, params?: URLSearchParams) => {
    const url = new URL(`/api/v1${path}`, origin)
    if (params) url.search = params.toString()
    return url
  }
  return {
    id: ID,
    name: "cardex",
    hosts: [base.host],
    scheme: plain ? "http" : "https",
    // Plain http is only ever the fake archive on this machine.
    ...(plain ? { local: true } : {}),
    key: "none",
    rate: { perSecond: 10, burst: 60 },
    capabilities: (http) =>
      Effect.flatMap(getJson(http, api("/capabilities")), (raw) =>
        Effect.try({ try: () => capabilitiesOf(raw), catch: () => bad() })
      ),
    search: (http, query, token) =>
      Effect.gen(function* () {
        const semantic = query.filters.mode === "semantic"
        const page = pageOf(token)
        const raw = yield* getJson(http, api("/search", searchParams(query, token))).pipe(
          // A cursor cardex no longer takes (expired, or a deployment changed) restarts the
          // search, as its docs ask; the client drops the cards it already shows.
          Effect.catchIf(
            (failure) => failure.reason === "bad_response" && page !== null && "cursor" in page,
            () => getJson(http, api("/search", searchParams(query, null)))
          )
        )
        if (!isRecord(raw)) return yield* bad()
        const items = summaries(raw.items, origin)
        if (items === null) return yield* bad()
        const total = typeof raw.total === "number" ? raw.total : undefined
        const current = page && "page" in page ? page.page : 1
        const next = semantic
          ? items.length === PAGE_SIZE && (total === undefined || current * PAGE_SIZE < total)
            ? `p:${current + 1}`
            : null
          : typeof raw.next_cursor === "string" && raw.next_cursor
            ? `c:${raw.next_cursor}`
            : null
        return {
          items,
          next,
          ...(total === undefined ? {} : { total }),
          ...(raw.total_is_estimate === true ? { totalEstimated: true } : {})
        }
      }),
    tags: (http, prefix) =>
      Effect.gen(function* () {
        const params = new URLSearchParams({ limit: "10" })
        if (prefix.trim()) params.set("q", prefix.trim())
        const raw = yield* getJson(http, api("/tags", params))
        const tags = isRecord(raw) && Array.isArray(raw.tags) ? raw.tags : null
        if (tags === null) return yield* bad()
        return tags
          .filter(isRecord)
          .filter((t) => typeof t.slug === "string")
          .slice(0, 10)
          .map((t) => ({
            tag: t.slug as string,
            ...(typeof t.label === "string" ? { label: t.label } : {}),
            ...(typeof t.card_count === "number" ? { count: t.card_count } : {})
          }))
      }),
    card: (http, remoteId) =>
      Effect.gen(function* () {
        const raw = yield* getJson(http, batchUrl([remoteId], origin))
        const item =
          isRecord(raw) && Array.isArray(raw.items)
            ? (raw.items as Array<Summary>).find((c) => c?.slug === remoteId)
            : undefined
        if (!item) return yield* new SourceFailed({ sourceId: ID, reason: "not_found", message: "not on cardex" })
        const summary = summaryOf(item, origin)
        const sha = (item as { file_sha256?: unknown }).file_sha256 ?? item.version
        if (!summary || typeof sha !== "string" || !/^[0-9a-f]{64}$/.test(sha)) return yield* bad()
        const download = (mode: string) => http.get(api(`/download/${sha}`, new URLSearchParams({ mode })), "card")
        // The mirrored PNG holds the card and its portrait; a CHARX original has none.
        const file = yield* download("mirrored").pipe(
          Effect.catchIf(
            (failure) => failure.reason === "not_found",
            () => download("original")
          )
        )
        return { bytes: file.bytes, fileName: fileNameOf(file, remoteId), summary }
      }),
    image: (http, ref) =>
      Effect.suspend(() => {
        const href = onOrigin(origin, ref)
        return href ? Effect.map(http.get(new URL(href), "image"), (response) => response.bytes) : Effect.fail(bad())
      }),
    versions: (http, ids) =>
      Effect.gen(function* () {
        const unique = [...new Set(ids)].sort()
        const out: Array<{ remoteId: string; version: AdapterSummary["version"] }> = []
        for (let start = 0; start < unique.length; start += BATCH_MAX) {
          const raw = yield* getJson(http, batchUrl(unique.slice(start, start + BATCH_MAX), origin))
          const items = isRecord(raw) ? summaries(raw.items, origin) : null
          if (items === null) return yield* bad()
          for (const item of items) out.push({ remoteId: item.remoteId, version: item.version })
        }
        return out
      })
  }
}

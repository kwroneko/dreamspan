// The cardex adapter (spec/CARD-SOURCES.md §11 phase 4): cardex is a public card archive run by
// a third party, read through its public API v1 (https://cardex.zip/docs/api; frozen, additive
// only). Anonymous, 10 requests/s with a burst of 60 per address, 429 with Retry-After.
//
// What v1 gives and how it maps:
// - `/api/v1/capabilities` describes the filters by name, type and allowed values, with no
//   labels on older replies; this adapter uses the labels when present, and offers
//   every card criterion the archive lists.
// - `/api/v1/search` pages two ways: text search (`mode=fts`) with an opaque `next_cursor`,
//   semantic search with page numbers (240 results at most, no cursor, no sort). The page token
//   handed out is `c:<cursor>` or `p:<n>`, so the client never needs to know which. A cursor
//   cardex no longer takes answers 400 `invalid_cursor` (`bad_request` before cardex named it),
//   and the search starts again from its first page; any other misuse (`bad_request`) is an error.
// - A card is fetched as `/api/v1/cards/batch?ids=<slug>` (its summary and file hash) and then
//   `/api/v1/download/<sha256>` as the archive's mirrored PNG (the card in its `chara`/`ccv3`
//   chunks, its portrait the image itself). A card whose original is CHARX has no mirrored or
//   self-contained file (404) and is fetched as `mode=json`, which every card has: its V2/V3
//   JSON with the `extensions.cardex` block. A summary's `download_modes` (the modes that answer
//   200, in the order mirrored, self-contained, json, original; a CHARX card's are json and
//   original) picks the mode instead, with no 404 to learn it; an empty list means cardex
//   refuses downloads of the card, and none is tried. A response cached from before cardex
//   listed them (up to 30 minutes) lacks the field, and the fallback above applies.
// - Batches are sent sorted and without duplicates, comma-joined as `%2C`: cardex's canonical
//   form, which it otherwise answers with a 308.
// - Pictures are `/t/<sha256>.512.webp` and `/i/<sha256>.<ext>` on cardex.zip, given as paths.
// Registered only where FAKE_CARD_SOURCE is unset (runMain.ts). Tests and the development
// instance point this same adapter at the fake archive's origin instead
// (test/support/fakeCardex.ts, `dev/fakeCardSource.ts`), so it never reaches cardex.zip there.
import { CARDEX_SITE_LABELS, SourceFailed } from "@dreamspan/shared/cardSources.ts"
import type {
  RemoteCreator,
  RemoteRelative,
  SourceCapabilities,
  SourceFilter,
  SourceQuery
} from "@dreamspan/shared/cardSources.ts"
import { Effect, Schema } from "effect"
import type { AdapterSummary, CardSourceAdapter, SourceHttp, SourceResponse, SourceVersion } from "./adapter.ts"

export const CARDEX_ORIGIN = "https://cardex.zip"
/** Results per page: a multiple of the grid's usual 2 to 6 columns. */
const PAGE_SIZE = 48
/** cardex's batch limit. */
const BATCH_MAX = 100

/** v1's `CardSummary` (frozen); unknown fields are ignored. */
const nullableText = Schema.optionalKey(Schema.NullOr(Schema.String))
const SummaryShape = Schema.Struct({
  slug: Schema.String.check(Schema.isMaxLength(500)),
  /** `character` or `lorebook` (a standalone book, §3.9). */
  kind: nullableText,
  url: nullableText,
  name: nullableText,
  tagline: nullableText,
  creator: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ name: nullableText, source: nullableText, handle: nullableText }))
  ),
  // Invalid tag values are omitted in the projection below.
  tags: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.Unknown))),
  nsfw: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  token_count: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  stats: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ popularity: Schema.optionalKey(Schema.NullOr(Schema.Number)) }))
  ),
  thumbnail_url: nullableText,
  image_url: nullableText,
  version: nullableText,
  updated_at: nullableText,
  superseded_by: nullableText,
  download_modes: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String)))
})
type Summary = typeof SummaryShape.Type
const isSummary = Schema.is(SummaryShape)

/** v1's capabilities: each filter by its parameter name. */
interface Capabilities {
  readonly filters: ReadonlyArray<{
    readonly name: string
    readonly label?: string
    readonly description?: string
    readonly allowed_value_labels?: ReadonlyArray<{ readonly value: string; readonly label: string }>
    readonly type: string
    readonly allowed_values?: ReadonlyArray<string> | null
    readonly default?: unknown
    readonly min?: number | null
    readonly max?: number | null
  }>
  readonly sorts: ReadonlyArray<string>
  readonly modes?: ReadonlyArray<{ readonly name: string }> | null
}

/** v1's result kinds, in the order the Kind choice offers them (§3.9). */
const KIND_ORDER = ["both", "character", "character_lorebook", "lorebook"] as const
const KIND_LABELS: Readonly<Record<string, string>> = {
  both: "All",
  character: "Characters",
  character_lorebook: "Characters with a lorebook",
  lorebook: "Lorebooks"
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
export const summaryOf = (item: unknown, origin = CARDEX_ORIGIN): AdapterSummary | null => {
  if (!isSummary(item) || item.slug === "") return null
  const updated = item.updated_at ? Date.parse(item.updated_at) : Number.NaN
  const thumb = onOrigin(origin, item.thumbnail_url)
  const image = onOrigin(origin, item.image_url)
  const url = onOrigin(origin, item.url ?? `/c/${encodeURIComponent(item.slug)}`)
  const author = authorOf(item.creator)
  const popularity = item.stats?.popularity
  return {
    remoteId: item.slug,
    ...(item.kind === "lorebook" ? { kind: "lorebook" as const } : {}),
    name: item.name?.trim() || item.slug,
    ...(item.creator?.name ? { creator: item.creator.name } : {}),
    ...(author ? { creatorQuery: author } : {}),
    ...(item.tagline ? { tagline: item.tagline } : {}),
    tags: Array.isArray(item.tags) ? item.tags.filter((t): t is string => typeof t === "string") : [],
    ...(item.nsfw ? { rating: "NSFW" } : {}),
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

/** Optional detail metadata; never use the envelope's character text as an import. */
export const detailMetadata = (
  raw: unknown,
  origin = CARDEX_ORIGIN
): Pick<AdapterSummary, "tokenCounts" | "earlierOrigins"> => {
  if (!isRecord(raw)) return {}
  const counts = isRecord(raw.card) && isRecord(raw.card.token_counts) ? raw.card.token_counts : null
  const number = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0
  const fields =
    counts && isRecord(counts.fields)
      ? (Object.fromEntries(Object.entries(counts.fields).filter(([, value]) => number(value))) as Record<
          string,
          number
        >)
      : {}
  if (counts && number(counts.mes_example)) fields.mes_example = counts.mes_example
  const earlierOrigins = Array.isArray(raw.earlier_origins)
    ? raw.earlier_origins.filter(isRecord).flatMap((entry) => {
        const listing = isRecord(entry.listing) ? entry.listing : null
        const ref =
          listing &&
          (typeof listing.url === "string"
            ? listing.url
            : typeof listing.path === "string"
              ? listing.path
              : typeof listing.slug === "string"
                ? `/c/${encodeURIComponent(listing.slug)}`
                : undefined)
        const url = onOrigin(origin, ref)
        if (!url) return []
        const site =
          typeof listing?.source_label === "string"
            ? listing.source_label
            : typeof listing?.source === "string"
              ? (CARDEX_SITE_LABELS[listing.source] ?? listing.source)
              : "archive"
        return [{ label: `Earlier listing on ${site}`, url }]
      })
    : []
  return {
    ...(counts && typeof counts.model === "string"
      ? {
          tokenCounts: {
            model: counts.model,
            fields,
            greetings: Array.isArray(counts.greetings) ? counts.greetings.filter(number) : []
          }
        }
      : {}),
    ...(earlierOrigins.length ? { earlierOrigins } : {})
  }
}

const summaries = (items: unknown, origin: string) =>
  Array.isArray(items) ? items.flatMap((item) => summaryOf(item as Summary, origin) ?? []) : null

/** The download modes this adapter takes, best first: the PNG holds the portrait, the JSON doesn't. */
const DOWNLOAD_MODES = ["mirrored", "json"] as const

/**
 * The download mode for a card: the best one its summary lists; `refused` when it lists none
 * (cardex won't give the card), null when it lists none of ours; with no list, undefined (try
 * `mirrored`, then `json` on its 404).
 */
export const downloadModeOf = (listed: unknown): (typeof DOWNLOAD_MODES)[number] | "refused" | null | undefined => {
  if (!Array.isArray(listed)) return undefined
  if (listed.length === 0) return "refused"
  return DOWNLOAD_MODES.find((mode) => listed.includes(mode)) ?? null
}

/** A refusal that means the cursor is no longer good (expired, or another query's): `invalid_cursor`. */
export const cursorRefused = (failure: SourceFailed) =>
  failure.reason === "bad_response" && failure.code === "invalid_cursor"

/** Page tokens: `c:<cursor>`, `s:<encoded sort/cursor>` after substitution, or semantic `p:<n>`. */
const pageOf = (
  token: string | null
): { readonly cursor: string; readonly sort?: string } | { readonly page: number } | null => {
  if (token?.startsWith("s:")) {
    try {
      const value: unknown = JSON.parse(Buffer.from(token.slice(2), "base64url").toString("utf8"))
      if (
        isRecord(value) &&
        typeof value.sort === "string" &&
        /^[a-z_]{1,50}$/.test(value.sort) &&
        typeof value.cursor === "string" &&
        value.cursor.length > 0
      )
        return { cursor: value.cursor, sort: value.sort }
    } catch {
      /* Not a continuation issued by this adapter. */
    }
  }
  if (token?.startsWith("c:") && token.length > 2) return { cursor: token.slice(2) }
  const page = token?.startsWith("p:") ? Number(token.slice(2)) : Number.NaN
  return Number.isInteger(page) && page >= 1 ? { page } : null
}

// cardex's own labels (its search page's wording), for replies whose descriptors carry none. A
// filter it no longer lists is left out.
const RATING_LABELS: Record<string, string> = { exclude: "Hide NSFW", include: "Show NSFW", only: "Only NSFW" }
const MODE_LABELS: Record<string, string> = { fts: "Text", semantic: "Semantic" }
const SORTS: ReadonlyArray<{
  readonly id: string
  readonly label: string
  readonly needs: ReadonlyArray<string>
  readonly defaultOrder: string
}> = [
  { id: "popular", label: "Popular", needs: ["popular"], defaultOrder: "popular cards" },
  { id: "newest", label: "Newest added", needs: ["newest", "oldest"], defaultOrder: "newest first" },
  {
    id: "created",
    label: "Newest created",
    needs: ["created_desc", "created_asc"],
    defaultOrder: "newest created first"
  },
  { id: "name", label: "Name, A to Z", needs: ["name", "name_desc"], defaultOrder: "A to Z" },
  { id: "tokens", label: "Most tokens", needs: ["tokens_desc", "tokens_asc"], defaultOrder: "most tokens first" },
  { id: "relevance", label: "Relevance", needs: ["relevance"], defaultOrder: "best matches" }
]
/** Our sort and direction as cardex's sort; null leaves it to cardex. */
const sortParam = (query: SourceQuery) => {
  switch (query.sort) {
    case "popular":
      return "popular"
    case "name":
      return query.reverse ? "name_desc" : "name"
    case "created":
      return query.reverse ? "created_asc" : "created_desc"
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

const FILTER_LABELS: Record<string, string> = {
  fields: "Search in",
  kind: "Kind",
  not_source: "Exclude sources",
  any_tags: "Any of these tags",
  any_author: "Any of these authors",
  not_author: "Not by these authors",
  picture: "Picture",
  added_after: "Added after",
  added_before: "Added before",
  created_after: "Created after",
  created_before: "Created before",
  deleted_from_source: "Deleted from all sources",
  deleted_from_any_source: "Deleted from a source",
  chub_verified: "Chub verified",
  chub_recommended: "Chub recommended"
}
const FILTER_HELP: Record<string, string> = {
  any_tags:
    "Use | between alternatives and commas between required groups: fantasy|magic,adventure|mystery. Up to 20 groups.",
  any_author: "Separate site/name creators with commas. A backslash escapes a comma in a name. Up to 20 creators.",
  not_author: "Separate site/name creators with commas. A backslash escapes a comma in a name. Up to 20 creators.",
  picture: "The picture's SHA-256: 64 hexadecimal characters. Finds cards sharing that picture.",
  added_after: "When this version of the card was added to cardex. Both dates count.",
  added_before: "Cards cardex added before this day.",
  created_after:
    "When the card was first published, as far as cardex can tell: the site's own date, its first listing, an earlier version, or when cardex first saw it. Once a date is set, cards with no known date are left out.",
  created_before: "Cards their creator made before this day, as far as cardex knows.",
  // What each panel and checkbox explains behind its (i), as the archive's own page does.
  author:
    "By any of: cards by any of the authors you add. Not by any of: cards by none of them. An author is one account on one site. The number beside a name is how many of their cards cardex has.",
  source:
    "The sites a card is listed on. Include: cards on any of the ticked sites. Exclude: cards on none of them. Chub verified and Chub recommended work when Chub is the only site included.",
  kind: "Characters, only characters whose card has a lorebook (its own or one the site attaches), standalone lorebooks, or all of them.",
  nsfw: "NSFW as marked by a site the card is listed on or, where the site doesn't say, by cardex's own check.",
  exclude_forks: "Leaves out cards that one of their sites marks as a fork: a changed copy of another card.",
  deleted_from_source: "Only cards deleted from every site they were listed on.",
  deleted_from_any_source:
    "Only cards deleted from at least one site they are listed on. With sites included, only deletions from those sites count."
}
/**
 * Where each criterion sits in the filter bar, modeled on the archive's public search page: one
 * panel each for creators, sites, kind, rating, tokens and the two date ranges, in that order;
 * which parts the words are looked for in and how they're matched beside the search box; the
 * checkboxes after the panels; the picture only through a card's own link.
 */
const PLACEMENT: Record<string, { readonly group?: string; readonly place?: "search" | "switches" | "none" }> = {
  author: { group: "Authors" },
  any_author: { group: "Authors" },
  not_author: { group: "Authors" },
  source: { group: "Sources" },
  not_source: { group: "Sources" },
  chub_verified: { group: "Sources" },
  chub_recommended: { group: "Sources" },
  kind: { group: "Kind" },
  nsfw: { group: "NSFW" },
  tokens: { group: "Tokens" },
  added_after: { group: "Added" },
  added_before: { group: "Added" },
  created_after: { group: "Created" },
  created_before: { group: "Created" },
  fields: { place: "search" },
  mode: { place: "search" },
  exclude_forks: { place: "switches" },
  has_cover: { place: "switches" },
  deleted_from_source: { place: "switches" },
  deleted_from_any_source: { place: "switches" },
  any_tags: { place: "none" },
  picture: { place: "none" }
}
const PLACED = Object.keys(PLACEMENT)
/** The parameters read elsewhere: the words, the tags (the tag field) and the token range (one panel). */
const READ_ELSEWHERE = ["q", "tags", "not_tags", "min_tokens", "max_tokens"]
/**
 * The archive's parameters no control of ours stands for. Each is left out of the bar (a
 * parameter never becomes a button of its own), and the adapter logs them so a new one is noticed.
 */
export const unmappedParameters = (raw: unknown): ReadonlyArray<string> =>
  !isRecord(raw) || !Array.isArray(raw.filters)
    ? []
    : raw.filters
        .filter(isRecord)
        .map((f) => f.name)
        .filter(
          (name): name is string => typeof name === "string" && !READ_ELSEWHERE.includes(name) && !PLACED.includes(name)
        )
const placedAt = (id: string) => (PLACED.includes(id) ? PLACED.indexOf(id) : PLACED.length)
const EXTRA_LISTS = new Set(["fields", "not_source"])
const EXTRA_TEXT = new Set([
  "any_tags",
  "any_author",
  "not_author",
  "picture",
  "added_after",
  "added_before",
  "created_after",
  "created_before"
])
const EXTRA_FLAGS = new Set(["deleted_from_source", "deleted_from_any_source", "chub_verified", "chub_recommended"])

export const capabilitiesOf = (raw: unknown): SourceCapabilities => {
  if (!isRecord(raw) || !Array.isArray(raw.filters) || !Array.isArray(raw.sorts)) throw bad()
  const body = raw as unknown as Capabilities
  const named = new Map(body.filters.filter(isRecord).map((f) => [f.name, f]))
  const allowed = (name: string) => (named.get(name)?.allowed_values ?? []).filter((v) => typeof v === "string")
  /** cardex's own label for a value of a filter, when its capabilities carry one. */
  const valueLabel = (name: string, value: string) =>
    named.get(name)?.allowed_value_labels?.find((v) => v.value === value)?.label
  const filters: Array<SourceFilter> = []
  const ratings = allowed("nsfw").filter((v) => v in RATING_LABELS)
  if (ratings.length) {
    filters.push({
      id: "nsfw",
      label: named.get("nsfw")?.label ?? "NSFW",
      kind: "choice",
      multi: false,
      about: FILTER_HELP.nsfw!,
      options: ["exclude", "include", "only"]
        .filter((v) => ratings.includes(v))
        .map((value) => ({ value, label: valueLabel("nsfw", value) ?? RATING_LABELS[value]! }))
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
        "Text finds cards that contain your words; Semantic finds cards about what you describe. Semantic shows up to 240 cards and uses its own order."
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
      scaleMax: 100_000,
      about: `About how many tokens of the model's context the card takes up (an estimate). Characters under ${typeof named.get("min_tokens")?.default === "number" ? named.get("min_tokens")!.default : 300} tokens are hidden by default, since most are stubs; lorebooks never are.`
    })
  }
  if (named.has("exclude_forks"))
    filters.push({ id: "exclude_forks", label: "Hide forks", kind: "toggle", about: FILTER_HELP.exclude_forks! })
  const sites = allowed("source")
  if (sites.length) {
    filters.push({
      id: "source",
      label: named.get("source")?.label ?? "Sources",
      kind: "choice",
      multi: true,
      options: sites.map((value) => ({
        value,
        label: valueLabel("source", value) ?? CARDEX_SITE_LABELS[value] ?? value
      })),
      about: FILTER_HELP.source!
    })
  }
  if (named.has("author")) {
    filters.push({
      id: "author",
      label: named.get("author")?.label ?? "Author",
      kind: "text",
      suggestions: { kind: "creators", multiple: false },
      about: FILTER_HELP.author!
    })
  }
  // The remaining v1 criteria the bar places (PLACEMENT), as choices, text fields and switches.
  // A criterion it doesn't know is left out, never shown as a generic control named after the
  // parameter (owner, 2026-11-23: a "Created after" popover over a "Created after" field).
  // Standalone lorebooks come back beside characters (§3.9) and open in the lorebook editor,
  // never in a character's draft chat.
  const handled = new Set([
    "q",
    "tags",
    "not_tags",
    "nsfw",
    "min_tokens",
    "max_tokens",
    "exclude_forks",
    "source",
    "author"
  ])
  for (const descriptor of named.values()) {
    const { name, type, label, description } = descriptor
    if (handled.has(name) || !PLACED.includes(name)) continue
    const common = {
      id: name,
      label: label ?? FILTER_LABELS[name] ?? name,
      ...(description ? { about: description } : {})
    }
    if (name === "kind") {
      const options = KIND_ORDER.filter((value) => allowed(name).includes(value))
      if (options.length > 1)
        filters.push({
          ...common,
          kind: "choice",
          multi: false,
          about: FILTER_HELP.kind!,
          options: options.map((value) => ({ value, label: valueLabel(name, value) ?? KIND_LABELS[value]! }))
        })
    } else if (name === "has_cover") {
      filters.push({
        ...common,
        label: label ?? "Only cards with a cover",
        kind: "choice",
        multi: false,
        options: [
          { value: "true", label: "Yes" },
          { value: "false", label: "No" }
        ],
        about: "Leaves out characters without a cover image. On by default; lorebooks are never left out."
      })
    } else if (type === "boolean") {
      filters.push({
        ...common,
        kind: "toggle",
        ...(name.startsWith("chub_")
          ? {
              requires: {
                filterId: "source",
                values: ["chub"],
                about: "Choose Chub as the only included source first."
              },
              about: "Available when Chub is the only source selected."
            }
          : FILTER_HELP[name]
            ? { about: FILTER_HELP[name] }
            : {})
      })
    } else if ((type === "list" || type === "enum") && allowed(name).length) {
      filters.push({
        ...common,
        kind: "choice",
        multi: type === "list",
        options: allowed(name).map((value) => ({
          value,
          label:
            descriptor.allowed_value_labels?.find((v) => v.value === value)?.label ?? CARDEX_SITE_LABELS[value] ?? value
        }))
      })
    } else if (type === "date") {
      filters.push({ ...common, kind: "text", format: "date", about: FILTER_HELP[name] ?? "A calendar date." })
    } else {
      filters.push({
        ...common,
        kind: "text",
        ...(["any_author", "not_author"].includes(name)
          ? { suggestions: { kind: "creators" as const, multiple: true } }
          : {}),
        about: FILTER_HELP[name] ?? description ?? `Filters by ${common.label.toLowerCase()}.`
      })
    }
  }
  const nsfwDefault = named.get("nsfw")?.default
  const has = (id: string) => filters.some((f) => f.id === id)
  // What cardex leaves out unless asked: characters under its token minimum, and characters
  // without a cover. Lorebooks are never left out for either.
  const floor = named.get("min_tokens")?.default
  const hidden: Array<NonNullable<SourceCapabilities["hiddenByDefault"]>[number]> = []
  if (typeof floor === "number" && floor > 0 && has("tokens"))
    hidden.push({
      id: "token-floor",
      label: `Characters under ${floor} tokens`,
      about:
        "The archive leaves these out unless you set a minimum, since most are stubs. Remove this to include them.",
      filterId: "tokens",
      off: { min: 0 },
      unless: [{ filterId: "tokens" }, ...(has("kind") ? [{ filterId: "kind", values: ["lorebook"] }] : [])],
      min: floor
    })
  if (named.get("has_cover")?.default === true && has("has_cover"))
    hidden.push({
      id: "cover",
      label: "Cards without a cover",
      about: "The archive leaves these out unless you ask for them. Remove this to include them.",
      filterId: "has_cover",
      off: "false",
      unless: [{ filterId: "has_cover" }, ...(has("kind") ? [{ filterId: "kind", values: ["lorebook"] }] : [])],
      toggle: "Only cards with a cover"
    })
  return {
    text: true,
    tags: {
      include: named.has("tags"),
      exclude: named.has("not_tags"),
      suggest: true,
      ...(has("any_tags") ? { anyFilterId: "any_tags" } : {})
    },
    // In the bar's order: the placed criteria as listed above, then the switches. Sites left
    // out are the same list as the sites included, each site either.
    filters: filters
      .map((filter) => ({
        ...filter,
        ...PLACEMENT[filter.id],
        ...(filter.id === "source" && has("not_source") ? { excludeId: "not_source" } : {})
      }))
      .sort((a, b) => placedAt(a.id) - placedAt(b.id)),
    ...(hidden.length ? { hiddenByDefault: hidden } : {}),
    sorts: SORTS.filter((s) => s.needs.every((n) => body.sorts.includes(n))).map((s) => ({
      id: s.id,
      label: s.label,
      reversible: s.needs.length > 1
    })),
    ...(ratings.length
      ? {
          ratings: {
            filterId: "nsfw",
            default: typeof nsfwDefault === "string" ? nsfwDefault : null,
            ...(ratings.includes("exclude") ? { safe: "exclude" } : {})
          }
        }
      : {}),
    paging: "cursor",
    stats: [{ id: "popularity", label: "popularity" }],
    families: true,
    ...(named.has("author")
      ? {
          creators: {
            filterId: "author",
            ...(named.has("not_author") ? { excludeFilterId: "not_author" } : {}),
            ...(named.has("any_author") ? { anyFilterId: "any_author" } : {}),
            profiles: true
          }
        }
      : {})
  }
}

/** A date cardex gave, as ms; undefined when it isn't one. */
const dateOf = (value: unknown) => {
  const at = typeof value === "string" ? Date.parse(value) : Number.NaN
  return Number.isNaN(at) ? undefined : at
}
const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined

/** v1's `/authors/<site>/<handle>` envelope's `author` as a creator profile; the avatar stays a path. */
export const creatorOf = (raw: unknown, query: string, origin = CARDEX_ORIGIN): RemoteCreator => {
  const author = isRecord(raw) && isRecord(raw.author) ? raw.author : null
  if (
    author === null ||
    typeof author.source !== "string" ||
    typeof author.handle !== "string" ||
    `${author.source}/${author.handle}` !== query
  )
    throw bad()
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined)
  const avatar = isRecord(author.avatar)
    ? onOrigin(origin, text(author.avatar.thumb_url) ?? text(author.avatar.url))
    : onOrigin(origin, text(author.avatar))
  const site = text(author.source_label) ?? (text(author.source) && CARDEX_SITE_LABELS[text(author.source)!])
  const url = onOrigin(origin, text(author.path))
  const cards = count(author.card_count)
  const lorebooks = count(author.lorebook_count)
  const firstSeen = dateOf(author.first_seen_at)
  const lastSeen = dateOf(author.last_seen_at)
  const bio = text(author.bio)
  return {
    query,
    name: (text(author.display_name) ?? text(author.handle) ?? query).slice(0, 300),
    ...(site ? { site } : {}),
    ...(bio ? { bio: bio.slice(0, 4000) } : {}),
    ...(avatar ? { avatar } : {}),
    ...(cards === undefined ? {} : { cards }),
    ...(lorebooks === undefined ? {} : { lorebooks }),
    ...(firstSeen === undefined ? {} : { firstSeen }),
    ...(lastSeen === undefined ? {} : { lastSeen }),
    ...(url ? { url } : {})
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
  // Unchosen, characters and standalone lorebooks both (§3.9: "returned with characters").
  params.set("kind", "both")
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
    } else if (id === "kind") {
      if (typeof value === "string" && (KIND_ORDER as ReadonlyArray<string>).includes(value)) params.set(id, value)
    } else if (id === "has_cover") {
      if (value === "true" || value === "false" || typeof value === "boolean") params.set(id, String(value))
    } else if (EXTRA_TEXT.has(id)) {
      if (typeof value === "string" && value.trim()) params.set(id, value.trim())
    } else if (id === "source" || EXTRA_LISTS.has(id)) {
      const sites = Array.isArray(value) ? value : typeof value === "string" ? [value] : []
      if (sites.length) params.set(id, [...new Set(sites)].sort().join(","))
    } else if (id === "exclude_forks" || EXTRA_FLAGS.has(id)) {
      if (value === true) params.set(id, "true")
    }
  }
  const page = pageOf(token)
  const sort = semantic ? null : page && "cursor" in page && page.sort ? page.sort : sortParam(query)
  if (sort) params.set("sort", sort)
  params.set("limit", String(PAGE_SIZE))
  if (page && "cursor" in page && !semantic) params.set("cursor", page.cursor)
  if (page && "page" in page) params.set("page", String(page.page))
  return params
}

/**
 * The cardex cards a card names: `cardex:<slug>` entries and pages `<origin>/c/<slug>` (the
 * adapter's origin: cardex.zip, or the fake archive's in tests), each slug once.
 */
const recognizeCardex = (links: ReadonlyArray<string>, origin = CARDEX_ORIGIN): ReadonlyArray<string> => {
  const slugs = new Set<string>()
  for (const link of links) {
    const id = /^cardex:(.+)$/.exec(link.trim())?.[1]?.trim()
    if (id) {
      slugs.add(id)
      continue
    }
    if (!URL.canParse(link)) continue
    const url = new URL(link)
    if (url.origin !== origin) continue
    const [kind, slug] = url.pathname.split("/").filter(Boolean)
    if (kind !== "c" || !slug) continue
    try {
      slugs.add(decodeURIComponent(slug))
    } catch {
      slugs.add(slug)
    }
  }
  return [...slugs].filter((slug) => slug.length <= 500)
}

/** At most this many relatives in a family, and the origins whose versions and forks are read. */
const FAMILY_MAX = 60
const FAMILY_ORIGINS = 3

const textOf = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined)

/** A creator's `site/handle` from v1's creator path, `/u/<site>/<handle>`. */
const creatorQueryOf = (creator: unknown) => {
  if (!isRecord(creator)) return undefined
  const handle = textOf(creator.handle)
  const site = textOf(creator.source)
  if (site && handle) return `${site}/${handle}`
  const path = /^\/u\/([^/]+)\/(.+)$/.exec(textOf(creator.path) ?? "")
  if (!path) return undefined
  try {
    return `${decodeURIComponent(path[1]!)}/${decodeURIComponent(path[2]!)}`
  } catch {
    return undefined
  }
}

/** One relative from v1's family shapes; null without a slug. */
const relativeOf = (
  relation: RemoteRelative["relation"],
  fields: {
    readonly slug: unknown
    readonly name: unknown
    readonly creator?: unknown
    readonly site?: unknown
    readonly at?: unknown
    readonly thumb?: unknown
    readonly current?: unknown
    readonly versionLabel?: unknown
  },
  origin: string
): RemoteRelative | null => {
  const slug = textOf(fields.slug)
  if (!slug || slug.length > 500) return null
  const creator = isRecord(fields.creator)
    ? (textOf(fields.creator.name) ?? textOf(fields.creator.display_name))
    : undefined
  const creatorQuery = creatorQueryOf(fields.creator)
  const siteName = textOf(fields.site)
  const at = dateOf(fields.at)
  const thumb = onOrigin(origin, textOf(fields.thumb))
  const label = textOf(fields.versionLabel)
  return {
    relation,
    remoteId: slug,
    name: (textOf(fields.name) ?? slug).slice(0, 300),
    ...(creator ? { creator: creator.slice(0, 200) } : {}),
    ...(creatorQuery ? { creatorQuery } : {}),
    ...(siteName ? { site: CARDEX_SITE_LABELS[siteName] ?? siteName } : {}),
    ...(label ? { versionLabel: label.slice(0, 40) } : {}),
    ...(at === undefined ? {} : { at }),
    ...(typeof fields.current === "boolean" ? { current: fields.current } : {}),
    ...(thumb ? { thumb } : {})
  }
}

/**
 * A card's family from v1: its detail envelope's origins (the card each was forked from) and
 * earlier listings (each now another card's), then `/versions` and `/forks` of each origin (the
 * first three). The card itself is left out, and each other card is listed once, in that order.
 */
export const familyOf = (
  remoteId: string,
  detail: unknown,
  lists: ReadonlyArray<{ readonly versions: unknown; readonly forks: unknown; readonly site: string }>,
  origin = CARDEX_ORIGIN
): { readonly items: ReadonlyArray<RemoteRelative>; readonly more: boolean } => {
  if (
    !isRecord(detail) ||
    !isRecord(detail.card) ||
    detail.card.slug !== remoteId ||
    !Array.isArray(detail.origins) ||
    !detail.origins.every(isRecord) ||
    !Array.isArray(detail.earlier_origins) ||
    !detail.earlier_origins.every(isRecord)
  )
    throw bad()
  for (const { versions, forks } of lists) {
    if (
      versions !== null &&
      (!isRecord(versions) ||
        !Array.isArray(versions.items) ||
        !versions.items.every(
          (item) => isRecord(item) && isRecord(item.version) && typeof item.version.slug === "string"
        ))
    )
      throw bad()
    if (
      forks !== null &&
      (!isRecord(forks) ||
        !Array.isArray(forks.children) ||
        !forks.children.every(isRecord) ||
        (forks.parent !== null && !isRecord(forks.parent)))
    )
      throw bad()
  }
  const name =
    (isRecord(detail.top) && isRecord(detail.top.name) ? textOf(detail.top.name.value) : undefined) ?? remoteId
  const items: Array<RemoteRelative> = []
  const seen = new Set([remoteId])
  let more = detail.origins.length > FAMILY_ORIGINS
  const add = (item: RemoteRelative | null) => {
    if (item === null) return
    if (seen.has(item.remoteId)) {
      const at = items.findIndex((previous) => previous.remoteId === item.remoteId)
      if (at >= 0) {
        const previous = items[at]!
        // Detail origins can name only a slug; forks/versions often have the missing facts.
        items[at] = { ...item, ...previous, name: previous.name === previous.remoteId ? item.name : previous.name }
      }
      return
    }
    if (items.length >= FAMILY_MAX) {
      more = true
      return
    }
    seen.add(item.remoteId)
    items.push(item)
  }
  const origins = Array.isArray(detail.origins) ? detail.origins.filter(isRecord) : []
  for (const listed of origins) {
    const fork = isRecord(listed.fork) ? listed.fork : null
    const from = fork && isRecord(fork.forked_from) ? fork.forked_from : null
    if (from)
      add(relativeOf("parent", { slug: from.card_slug, name: from.name ?? from.card_slug, site: from.source }, origin))
  }
  for (const entry of Array.isArray(detail.earlier_origins) ? detail.earlier_origins.filter(isRecord) : []) {
    const listing = isRecord(entry.listing) ? entry.listing : null
    const was = isRecord(entry.origin) ? entry.origin : null
    add(
      relativeOf(
        "earlier",
        {
          slug: was?.card_slug ?? listing?.card_slug,
          name: listing?.name,
          creator: listing?.author,
          site: listing?.source ?? was?.source,
          at: entry.active_from,
          thumb: isRecord(listing?.cover) ? listing.cover.thumb_url : undefined
        },
        origin
      )
    )
  }
  for (const { versions, forks, site } of lists) {
    if (isRecord(versions) && Array.isArray(versions.items)) {
      if (typeof versions.next === "string" && versions.next) more = true
      for (const item of versions.items.filter(isRecord)) {
        const version = isRecord(item.version) ? item.version : null
        add(
          relativeOf(
            "version",
            {
              slug: version?.slug,
              name,
              site,
              at: version?.active_from,
              current: version?.is_current,
              versionLabel: isRecord(version?.meta) ? version.meta.character_version : undefined,
              thumb: item.cover_thumb_url
            },
            origin
          )
        )
      }
    }
    if (isRecord(forks)) {
      if (typeof forks.next === "string" && forks.next) more = true
      const entries = [
        ...(isRecord(forks.parent) ? [["parent", forks.parent] as const] : []),
        ...(Array.isArray(forks.children) ? forks.children.filter(isRecord).map((c) => ["fork", c] as const) : [])
      ]
      for (const [relation, entry] of entries) {
        const card = isRecord(entry.card) ? entry.card : null
        if (card === null) continue
        const created = isRecord(card.estimated_creation) ? card.estimated_creation.at : card.earliest_known
        add(
          relativeOf(
            relation,
            { slug: card.slug, name: card.name, creator: card.creator, site, at: created, thumb: card.thumb_url },
            origin
          )
        )
      }
    }
  }
  return { items, more }
}

/** Stable listing keys come from metadata, never by fetching its path or source_url. */
const originLocator = (detail: unknown): string | undefined => {
  if (!isRecord(detail)) return undefined
  const origins = Array.isArray(detail.origins) ? detail.origins.filter(isRecord) : []
  const main = isRecord(detail.main_origin) ? detail.main_origin : null
  const earlier = Array.isArray(detail.earlier_origins)
    ? detail.earlier_origins
        .filter(isRecord)
        .sort((a, b) => String(b.active_to ?? "").localeCompare(String(a.active_to ?? "")))
    : []
  const candidates = [
    origins.find((o) => main && o.path === main.path),
    ...origins,
    ...earlier.flatMap((e) => [e.origin, e.listing])
  ]
  for (const entry of candidates) {
    if (
      !isRecord(entry) ||
      typeof entry.source !== "string" ||
      !/^[a-z0-9_]{1,40}$/.test(entry.source) ||
      typeof entry.external_id !== "string" ||
      !entry.external_id ||
      entry.external_id.length > 500
    )
      continue
    return JSON.stringify([entry.source, entry.external_id])
  }
  return undefined
}
const locatorParts = (locator: string): readonly [string, string] => {
  const pair: unknown = JSON.parse(locator)
  if (
    !Array.isArray(pair) ||
    pair.length !== 2 ||
    typeof pair[0] !== "string" ||
    !/^[a-z0-9_]{1,40}$/.test(pair[0]) ||
    typeof pair[1] !== "string" ||
    !pair[1] ||
    pair[1].length > 500
  )
    throw bad()
  return [pair[0], pair[1]]
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
      Effect.flatMap(getJson(http, api("/capabilities")), (raw) => {
        const unmapped = unmappedParameters(raw)
        return Effect.try({ try: () => capabilitiesOf(raw), catch: () => bad() }).pipe(
          Effect.tap(() =>
            unmapped.length
              ? Effect.logWarning(`cardex: parameters with no control, left out: ${unmapped.join(", ")}`)
              : Effect.void
          )
        )
      }),
    search: (http, query, token) =>
      Effect.gen(function* () {
        const semantic = query.filters.mode === "semantic"
        const page = pageOf(token)
        let restarted = false
        const params = searchParams(query, token)
        const defaultSort = query.text.trim() ? "relevance" : "popular"
        const requested = sortParam(query)
        let substituted = page !== null && "cursor" in page && page.sort !== undefined
        const retryable = (failure: SourceFailed) =>
          failure.retryAfterMs !== undefined && (failure.reason === "rate_limited" || failure.status === 503)
        // Timers may round down a millisecond; retry after the limiter's deadline.
        const wait = (failure: SourceFailed) => Effect.sleep(Math.ceil(failure.retryAfterMs ?? 0) + 1)
        const request = () =>
          getJson(http, api("/search", params)).pipe(
            Effect.catchIf(retryable, (failure) =>
              wait(failure).pipe(Effect.andThen(getJson(http, api("/search", params))))
            )
          )
        const raw = yield* request().pipe(
          Effect.catchIf(
            (failure) => page !== null && "cursor" in page && cursorRefused(failure),
            () => {
              restarted = true
              params.delete("cursor")
              return request()
            }
          ),
          Effect.catchIf(
            (failure) =>
              token === null &&
              !semantic &&
              requested !== null &&
              requested !== defaultSort &&
              [500, 502, 503, 504].includes(failure.status ?? 0),
            (failure) =>
              Effect.gen(function* () {
                // A reversed order can use its ordinary direction; otherwise use best match.
                // This policy applies to every sort, without a list of broken upstream orders.
                const descriptor = SORTS.find((sort) => sort.id === query.sort)
                const substitute =
                  query.reverse && descriptor && descriptor.needs.length > 1 ? descriptor.needs[0]! : defaultSort
                params.set("sort", substitute)
                substituted = true
                if (failure.retryAfterMs !== undefined) yield* wait(failure)
                return yield* getJson(http, api("/search", params))
              })
          )
        )
        if (!isRecord(raw)) return yield* bad()
        const items = summaries(raw.items, origin)
        if (items === null) return yield* bad()
        let total = typeof raw.total === "number" ? raw.total : undefined
        let totalCapped = false
        if (!semantic && (token === null || restarted)) {
          const params = searchParams(query, null)
          for (const name of ["sort", "limit", "page", "cursor"]) params.delete(name)
          const count = yield* getJson(http, api("/search/count", params))
          if (!isRecord(count) || typeof count.total !== "number" || !Number.isFinite(count.total) || count.total < 0)
            return yield* bad()
          total = count.total
          totalCapped = count.capped === true || count.timed_out === true
        }
        const current = page && "page" in page ? page.page : 1
        const next = semantic
          ? items.length === PAGE_SIZE && (total === undefined || current * PAGE_SIZE < total)
            ? `p:${current + 1}`
            : null
          : typeof raw.next_cursor === "string" && raw.next_cursor
            ? substituted
              ? `s:${Buffer.from(JSON.stringify({ sort: params.get("sort"), cursor: raw.next_cursor })).toString("base64url")}`
              : `c:${raw.next_cursor}`
            : null
        return {
          items,
          next,
          ...(substituted
            ? {
                notice: `cardex couldn't use ${SORTS.find((sort) => sort.id === query.sort)?.label.toLowerCase() ?? "the requested"} order just now. Showing ${params.get("sort") === defaultSort ? (query.text.trim() ? "best matches" : "popular cards") : (SORTS.find((sort) => sort.needs.includes(params.get("sort") ?? ""))?.defaultOrder ?? "another order")}.`
              }
            : {}),
          ...(restarted ? { reset: true } : {}),
          ...(total === undefined ? {} : { total }),
          ...(!semantic && (token === null || restarted) ? { totalCapped } : {}),
          ...(semantic && raw.total_is_estimate === true ? { totalEstimated: true } : {}),
          // What its defaults left out (no cover, under its token floor), for "N more are hidden".
          ...(isRecord(raw.defaults) && typeof raw.defaults.hidden === "number" && raw.defaults.hidden >= 0
            ? { hidden: raw.defaults.hidden, hiddenCapped: raw.defaults.hidden_capped === true }
            : {})
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
    suggestions: (http, kind, prefix, page) =>
      Effect.gen(function* () {
        const params = new URLSearchParams({ limit: "10" })
        if (prefix.trim()) params.set("q", prefix.trim())
        if (page) params.set("cursor", page)
        let reset = false
        const raw = yield* getJson(http, api(kind === "tags" ? "/tags" : "/search/authors", params)).pipe(
          Effect.catchIf(
            (failure) => page !== null && cursorRefused(failure),
            () => {
              reset = true
              params.delete("cursor")
              return getJson(http, api(kind === "tags" ? "/tags" : "/search/authors", params))
            }
          )
        )
        if (!isRecord(raw)) return yield* bad()
        const entries = kind === "tags" ? raw.tags : raw.authors
        if (!Array.isArray(entries)) return yield* bad()
        const items = entries.filter(isRecord).flatMap((entry) => {
          const value =
            kind === "tags"
              ? entry.slug
              : typeof entry.source === "string" && typeof entry.handle === "string"
                ? `${entry.source}/${entry.handle}`
                : undefined
          if (typeof value !== "string") return []
          const label = kind === "tags" ? entry.label : entry.display_name
          return [
            {
              value,
              label: typeof label === "string" ? label : value,
              ...(typeof entry.card_count === "number" ? { count: entry.card_count } : {})
            }
          ]
        })
        return {
          items,
          next: typeof raw.next === "string" && raw.next ? raw.next : null,
          ...(reset ? { reset: true } : {})
        }
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
        const listed = downloadModeOf(item.download_modes)
        if (listed === "refused")
          return yield* new SourceFailed({
            sourceId: ID,
            reason: "refused",
            message: "cardex doesn't allow downloading this card."
          })
        if (listed === null) return yield* bad("cardex offers this card in no form this app reads")
        // The mirrored PNG holds the card and its portrait; a CHARX original has none, but every
        // card has its JSON.
        // A standalone lorebook's every mode is JSON; its original is the creator's file as
        // published, which its version names (§3.9).
        const original =
          item.kind === "lorebook" && Array.isArray(item.download_modes) && item.download_modes.includes("original")
        const file = yield* original
          ? download("original")
          : listed
            ? download(listed)
            : download("mirrored").pipe(
                Effect.catchIf(
                  (failure) => failure.reason === "not_found",
                  () => download("json")
                )
              )
        const detail = yield* getJson(http, api(`/cards/${encodeURIComponent(remoteId)}`))
        return {
          bytes: file.bytes,
          fileName: fileNameOf(file, remoteId),
          summary: { ...summary, ...detailMetadata(detail, origin) },
          ...(originLocator(detail) ? { locator: originLocator(detail)! } : {})
        }
      }),
    recognize: (links) => recognizeCardex(links, origin),
    family: (http, remoteId) =>
      Effect.gen(function* () {
        const detail = yield* getJson(http, api(`/cards/${encodeURIComponent(remoteId)}`))
        const origins = isRecord(detail) && Array.isArray(detail.origins) ? detail.origins.filter(isRecord) : []
        const listed = origins
          .flatMap((o): Array<readonly [string, string]> => {
            const site = textOf(o.source)
            const external = textOf(o.external_id)
            return site && external ? [[site, external]] : []
          })
          .slice(0, FAMILY_ORIGINS)
        // An origin cardex no longer has versions or forks of is simply left out.
        const orNone = <A>(effect: Effect.Effect<A, SourceFailed>) =>
          effect.pipe(
            Effect.catchIf(
              (failure) => failure.reason === "not_found",
              () => Effect.succeed(null)
            )
          )
        const lists = yield* Effect.forEach(listed, ([site, external]) =>
          Effect.gen(function* () {
            const path = `${encodeURIComponent(site)}/${encodeURIComponent(external)}`
            const versions = yield* orNone(getJson(http, api(`/versions/${path}`)))
            const forks = yield* orNone(getJson(http, api(`/forks/${path}`)))
            return { versions, forks, site }
          })
        )
        return yield* Effect.try({ try: () => familyOf(remoteId, detail, lists, origin), catch: () => bad() })
      }),
    creator: (http, query) =>
      Effect.gen(function* () {
        // `site/handle`, as the author filter takes it; a handle may itself hold a slash.
        const at = query.indexOf("/")
        const site = at > 0 ? query.slice(0, at) : ""
        const handle = at > 0 ? query.slice(at + 1) : ""
        if (!/^[a-z0-9_]{1,40}$/.test(site) || handle === "")
          return yield* new SourceFailed({ sourceId: ID, reason: "not_found", message: "no such creator" })
        // The envelope also lists a page of the creator's cards, which the search lists instead.
        const raw = yield* getJson(http, api(`/authors/${encodeURIComponent(site)}/${encodeURIComponent(handle)}`))
        return yield* Effect.try({ try: () => creatorOf(raw, query, origin), catch: () => bad() })
      }),
    image: (http, ref) =>
      Effect.suspend(() => {
        const href = onOrigin(origin, ref)
        return href ? Effect.map(http.get(new URL(href), "image"), (response) => response.bytes) : Effect.fail(bad())
      }),
    versions: (http, ids, locators = {}) =>
      Effect.gen(function* () {
        // One budget covers this entire check, including bootstrap, batches and fallback hops.
        let requests = 0
        const bounded: SourceHttp = {
          ...http,
          get: (url, kind, headers) =>
            ++requests > 8
              ? Effect.fail(bad("cardex's version lookup exceeded its request budget"))
              : http.get(url, kind, headers)
        }
        const read = (url: URL) =>
          getJson(bounded, url).pipe(
            Effect.catchIf(
              (failure) => failure.reason === "not_found" || failure.reason === "region_unavailable",
              () => Effect.succeed(null)
            )
          )
        const unique = [...new Set(ids)].sort()
        const absent = (id: string): SourceVersion => ({
          remoteId: id,
          currentId: id,
          version: { id: "" },
          available: false
        })
        if (unique.length === 1) {
          const id = unique[0]!
          let locator = locators[id]
          if (!locator) locator = originLocator(yield* read(api(`/cards/${encodeURIComponent(id)}`)))
          if (locator) {
            const [site, external] = yield* Effect.try({ try: () => locatorParts(locator!), catch: () => bad() })
            const detail = yield* read(api(`/origins/${encodeURIComponent(site)}/${encodeURIComponent(external)}`))
            if (detail === null) return [absent(id)]
            if (
              !isRecord(detail) ||
              !isRecord(detail.card) ||
              typeof detail.card.slug !== "string" ||
              !detail.card.slug ||
              detail.card.slug.length > 500 ||
              !Array.isArray(detail.files)
            )
              return yield* bad()
            const currentId = detail.card.slug
            // A card's current file may be one cardex built from the site's data rather than an
            // original (provenance "source_build"); it counts, but an original wins when both exist.
            const current = detail.files
              .filter(isRecord)
              .filter((f) => f.current !== false && typeof f.sha256 === "string" && /^[0-9a-f]{64}$/.test(f.sha256))
            const originals = current.filter((f) => f.is_original === true)
            const files = originals.length > 0 ? originals : current
            if (detail.card.hidden === true || files.length === 0) return [absent(id)]
            if (files.length === 1) {
              const file = files[0]!
              const mode = downloadModeOf(file.download_modes)
              if (file.hidden === true || mode === "refused" || mode === null) return [absent(id)]
              return [{ remoteId: id, currentId, locator, version: { id: file.sha256 as string }, available: true }]
            }
            // With several such files, batch lookup is the archive's canonical file choice.
            const raw = yield* read(batchUrl([currentId], origin))
            const items = isRecord(raw) ? summaries(raw.items, origin) : null
            const item = items?.find((item) => item.remoteId === currentId)
            if (!item) return [absent(id)]
            return [
              {
                remoteId: id,
                currentId,
                locator,
                version: item.version,
                available:
                  downloadModeOf(
                    (isRecord(raw) && Array.isArray(raw.items) ? raw.items : []).find(
                      (v) => isRecord(v) && v.slug === currentId
                    )?.download_modes
                  ) !== "refused"
              }
            ]
          }
        }
        const lookup = (wanted: ReadonlyArray<string>) =>
          Effect.gen(function* () {
            const found = new Map<string, AdapterSummary>()
            for (let offset = 0; offset < wanted.length; offset += BATCH_MAX) {
              const raw = yield* read(batchUrl(wanted.slice(offset, offset + BATCH_MAX), origin))
              if (raw === null) continue
              const items = isRecord(raw) ? summaries(raw.items, origin) : null
              if (items === null) return yield* bad()
              for (const item of items) found.set(item.remoteId, item)
            }
            return found
          })
        const first = yield* lookup(unique)
        const resolved = new Map<string, { item: AdapterSummary; seen: Set<string>; missing: boolean }>()
        for (const id of unique) {
          const item = first.get(id)
          if (item) resolved.set(id, { item, seen: new Set([id]), missing: false })
        }
        for (let hop = 0; ; hop++) {
          const pending = [...resolved.values()].filter((e) => !e.missing && e.item.version.supersededBy)
          if (!pending.length) break
          if (hop >= 4) return yield* bad("cardex listed too many successive versions")
          for (const e of pending) {
            const target = e.item.version.supersededBy!
            if (target.length > 500 || e.seen.has(target)) return yield* bad("cardex listed a version cycle")
            e.seen.add(target)
          }
          const next = yield* lookup([...new Set(pending.map((e) => e.item.version.supersededBy!))].sort())
          for (const e of pending) {
            const item = next.get(e.item.version.supersededBy!)
            if (item) e.item = item
            else e.missing = true
          }
        }
        return unique
          .filter((id) => resolved.has(id))
          .map((remoteId): SourceVersion => {
            const e = resolved.get(remoteId)
            return !e || e.missing
              ? absent(remoteId)
              : { remoteId, currentId: e.item.remoteId, version: e.item.version, available: true }
          })
      })
  }
}

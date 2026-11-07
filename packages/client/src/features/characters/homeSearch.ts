import type { CardBrowse } from "./cardBrowse.tsx"
import type { SourceFilterValue } from "@rp/shared/cardSources.ts"

/** The characters' filters, in their order (`cardBrowse.tsx`), here so the URL's parsing needs no UI. */
export const CARD_FILTERS = ["all", "used", "unused", "favourites", "personas", "groups", "archived"] as const

/**
 * Home's own params; retained only on home, independently of the sidebar's scope. A card source
 * shown (`show=src.cardex`, spec/CARD-SOURCES.md §3.2) has its query in keys of its own, so
 * switching back to All finds the local search untouched.
 */
export const homeSearch = [
  "show",
  "sort",
  "reverse",
  "personas",
  "q",
  "pinsSort",
  "sq",
  "stags",
  "sxtags",
  "sf",
  "ssort",
  "sreverse"
] as const

/** What the user asked a card source for; the URL keeps it, so a search can be linked. */
export interface RemoteBrowse {
  readonly text: string
  readonly tags: ReadonlyArray<string>
  readonly excludeTags: ReadonlyArray<string>
  readonly filters: Readonly<Record<string, SourceFilterValue>>
  readonly sort: string | null
  readonly reverse: boolean
}

export interface HomeBrowse extends CardBrowse {
  readonly search: string
  readonly pinsSort: "recent" | "created" | "name"
  /** The card source shown instead of the user's cards, or null. */
  readonly source: string | null
  readonly remote: RemoteBrowse
}

const SOURCE_SHOW = /^src\.([a-z0-9][a-z0-9-]{0,39})$/
const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string").slice(0, 50) : []
const filtersOf = (value: unknown): Record<string, SourceFilterValue> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {}
  const out: Record<string, SourceFilterValue> = {}
  for (const [id, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string" || typeof v === "boolean") out[id] = v
    else if (Array.isArray(v)) out[id] = strings(v)
    else if (typeof v === "object" && v !== null) {
      const { min, max } = v as { min?: unknown; max?: unknown }
      out[id] = {
        ...(typeof min === "number" ? { min } : {}),
        ...(typeof max === "number" ? { max } : {})
      }
    }
  }
  return out
}

export const readHomeSearch = (search: Record<string, unknown>): HomeBrowse => {
  const source = typeof search.show === "string" ? (SOURCE_SHOW.exec(search.show)?.[1] ?? null) : null
  return {
    filter: CARD_FILTERS.find((v) => v === search.show) ?? "all",
    sort: (["recent", "created", "added", "name"] as const).find((v) => v === search.sort) ?? "recent",
    reversed: search.reverse === true,
    withPersonas: search.personas === true,
    search: typeof search.q === "string" ? search.q : "",
    pinsSort: (["recent", "created", "name"] as const).find((v) => v === search.pinsSort) ?? "recent",
    source,
    remote: {
      text: typeof search.sq === "string" ? search.sq : "",
      tags: strings(search.stags),
      excludeTags: strings(search.sxtags),
      filters: filtersOf(search.sf),
      sort: typeof search.ssort === "string" ? search.ssort : null,
      reverse: search.sreverse === true
    }
  }
}

/** Explicit undefined clears retained keys; defaults never need query parameters. */
export const writeHomeSearch = (state: HomeBrowse) => ({
  show: state.source !== null ? `src.${state.source}` : state.filter === "all" ? undefined : state.filter,
  sort: state.sort === "recent" ? undefined : state.sort,
  reverse: state.reversed || undefined,
  personas: state.withPersonas || undefined,
  q: state.search || undefined,
  pinsSort: state.pinsSort === "recent" ? undefined : state.pinsSort,
  sq: state.remote.text || undefined,
  stags: state.remote.tags.length ? state.remote.tags : undefined,
  sxtags: state.remote.excludeTags.length ? state.remote.excludeTags : undefined,
  sf: Object.keys(state.remote.filters).length ? state.remote.filters : undefined,
  ssort: state.remote.sort ?? undefined,
  sreverse: state.remote.reverse || undefined
})

export const changeHomeBrowse = (state: HomeBrowse, change: Partial<HomeBrowse>): HomeBrowse => ({
  ...state,
  ...(change.sort !== undefined && change.sort !== state.sort ? { reversed: false } : {}),
  // Choosing one of the user's own filters leaves the source; choosing a source keeps the filter.
  ...(change.filter !== undefined && change.source === undefined ? { source: null } : {}),
  ...change
})

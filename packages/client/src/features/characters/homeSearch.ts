import type { CardBrowse } from "./cardBrowse.tsx"

/** Home's own params; retained only on home, independently of the sidebar's scope. */
export const homeSearch = ["show", "sort", "reverse", "q", "pinsSort"] as const

export interface HomeBrowse extends CardBrowse {
  readonly search: string
  readonly pinsSort: "recent" | "created" | "name"
}

export const readHomeSearch = (search: Record<string, unknown>): HomeBrowse => ({
  filter: (["all", "used", "unused", "favourites", "groups"] as const).find((v) => v === search.show) ?? "all",
  sort: (["recent", "created", "added", "name"] as const).find((v) => v === search.sort) ?? "recent",
  reversed: search.reverse === true,
  search: typeof search.q === "string" ? search.q : "",
  pinsSort: (["recent", "created", "name"] as const).find((v) => v === search.pinsSort) ?? "recent"
})

/** Explicit undefined clears retained keys; defaults never need query parameters. */
export const writeHomeSearch = (state: HomeBrowse) => ({
  show: state.filter === "all" ? undefined : state.filter,
  sort: state.sort === "recent" ? undefined : state.sort,
  reverse: state.reversed || undefined,
  q: state.search || undefined,
  pinsSort: state.pinsSort === "recent" ? undefined : state.pinsSort
})

export const changeHomeBrowse = (state: HomeBrowse, change: Partial<HomeBrowse>): HomeBrowse => ({
  ...state,
  ...(change.sort !== undefined && change.sort !== state.sort ? { reversed: false } : {}),
  ...change
})

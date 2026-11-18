import { useMemo } from "react"
import { useNavigate, useSearch } from "@tanstack/react-router"
import { readCardSort } from "./cardBrowse.tsx"
import { changeHomeBrowse, homeSearch, readHomeSearch, writeHomeSearch, type HomeBrowse } from "./homeSearch.ts"
import { useLayoutParam, writeLayoutParams } from "../../tabLayoutParams.ts"

const key = (name: string) => `side${name[0]!.toUpperCase()}${name.slice(1)}`

/**
 * The left panel's sort, direction, Include personas and Group forks: layout params of this
 * browser tab (owner, 2026-11-18), carried over all its navigation, absent at the defaults. The
 * rest of its browse state (filter, search, family, source) is in its retained params
 * (sidebarSearch.ts).
 */
export const SIDEBAR_BROWSE_PARAMS = {
  sort: "sideSort",
  reversed: "sideReverse",
  withPersonas: "sidePersonas",
  grouped: "sideGroup"
} as const
const layout = new Set<string>(Object.values(SIDEBAR_BROWSE_PARAMS))

const read = (search: Record<string, unknown>) =>
  readHomeSearch(Object.fromEntries(homeSearch.map((k) => [k, search[key(k)]])))
const write = (state: HomeBrowse) =>
  Object.fromEntries(
    Object.entries(writeHomeSearch(state))
      .map(([k, v]) => [key(k), v] as const)
      .filter(([k]) => !layout.has(k))
  )

export function useSidebarBrowse() {
  const encoded = useSearch({
    strict: false,
    select: (s: Record<string, unknown>) =>
      JSON.stringify(Object.fromEntries(homeSearch.map((k) => [key(k), s[key(k)]])))
  })
  const sort = readCardSort(useLayoutParam(SIDEBAR_BROWSE_PARAMS.sort))
  const reversed = useLayoutParam(SIDEBAR_BROWSE_PARAMS.reversed) === "on"
  const withPersonas = useLayoutParam(SIDEBAR_BROWSE_PARAMS.withPersonas) === "on"
  const grouped = useLayoutParam(SIDEBAR_BROWSE_PARAMS.grouped) === "on"
  const navigate = useNavigate()
  const state = useMemo(
    () => ({ ...read(JSON.parse(encoded) as Record<string, unknown>), sort, reversed, withPersonas, grouped }),
    [encoded, sort, reversed, withPersonas, grouped]
  )
  const update = (change: Partial<HomeBrowse>, options?: { replace?: boolean }) => {
    const next = changeHomeBrowse(state, change)
    writeLayoutParams({
      [SIDEBAR_BROWSE_PARAMS.sort]: next.sort === "recent" ? null : next.sort,
      [SIDEBAR_BROWSE_PARAMS.reversed]: next.reversed ? "on" : null,
      [SIDEBAR_BROWSE_PARAMS.withPersonas]: next.withPersonas ? "on" : null,
      [SIDEBAR_BROWSE_PARAMS.grouped]: next.grouped ? "on" : null
    })
    const rest = Object.keys(change).filter((k) => !(k in SIDEBAR_BROWSE_PARAMS))
    // A sort change also resets the direction, both layout; only the rest navigates.
    if (rest.length === 0) return
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({ ...prev, ...write(changeHomeBrowse(read(prev), change)) }),
      replace: options?.replace ?? change.family === undefined,
      resetScroll: false
    })
  }
  return [state, update] as const
}

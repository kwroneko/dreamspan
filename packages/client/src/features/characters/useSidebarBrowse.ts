import { useEffect, useMemo } from "react"
import { useLocation, useNavigate, useSearch } from "@tanstack/react-router"
import { useCardBrowse } from "./cardBrowse.tsx"
import { changeHomeBrowse, homeSearch, readHomeSearch, writeHomeSearch, type HomeBrowse } from "./homeSearch.ts"

declare module "@tanstack/react-router" {
  interface HistoryState {
    sidebarBrowse?: boolean
  }
}
const key = (name: string) => `side${name[0]!.toUpperCase()}${name.slice(1)}`
const read = (search: Record<string, unknown>) =>
  readHomeSearch(Object.fromEntries(homeSearch.map((k) => [k, search[key(k)]])))
const write = (state: HomeBrowse) =>
  Object.fromEntries(Object.entries(writeHomeSearch(state)).map(([k, v]) => [key(k), v]))
export function useSidebarBrowse() {
  const encoded = useSearch({
    strict: false,
    select: (s: Record<string, unknown>) =>
      JSON.stringify(Object.fromEntries(homeSearch.map((k) => [key(k), s[key(k)]])))
  })
  const search = useMemo(() => JSON.parse(encoded) as Record<string, unknown>, [encoded])
  const marked = useLocation({ select: (l) => l.state.sidebarBrowse === true })
  const navigate = useNavigate()
  const [remembered, remember] = useCardBrowse("sidebar")
  const state = useMemo(() => {
    const parsed = read(search)
    return !marked && !homeSearch.some((k) => search[key(k)] !== undefined)
      ? { ...parsed, sort: remembered.sort, reversed: remembered.reversed, withPersonas: remembered.withPersonas }
      : parsed
  }, [marked, search, remembered.sort, remembered.reversed, remembered.withPersonas])
  useEffect(() => {
    if (!marked)
      void navigate({
        to: ".",
        search: (prev: Record<string, unknown>) => ({ ...prev, ...write(state) }),
        state: (prev) => ({ ...prev, sidebarBrowse: true }),
        replace: true,
        resetScroll: false
      })
  }, [marked, navigate, state])
  const update = (change: Partial<HomeBrowse>) => {
    if (change.sort !== undefined || change.reversed !== undefined || change.withPersonas !== undefined)
      remember(changeHomeBrowse(state, change))
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({ ...prev, ...write(changeHomeBrowse(read(prev), change)) }),
      state: (prev) => ({ ...prev, sidebarBrowse: true }),
      replace: true,
      resetScroll: false
    })
  }
  return [state, update] as const
}

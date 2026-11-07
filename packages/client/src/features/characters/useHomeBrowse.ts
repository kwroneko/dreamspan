import { useEffect, useMemo } from "react"
import { useLocation, useNavigate, useSearch } from "@tanstack/react-router"
import { useCardBrowse } from "./cardBrowse.tsx"
import { changeHomeBrowse, homeSearch, readHomeSearch, writeHomeSearch, type HomeBrowse } from "./homeSearch.ts"

declare module "@tanstack/react-router" {
  interface HistoryState {
    homeBrowse?: boolean
  }
}

/** URL state, with the account's sort used to seed a fresh, unqualified visit. */
export function useHomeBrowse() {
  const search = useSearch({ strict: false }) as Record<string, unknown>
  const initialized = useLocation({ select: (l) => l.state.homeBrowse === true })
  const navigate = useNavigate()
  const [remembered, remember, ready] = useCardBrowse("home")
  const state = useMemo(() => {
    const parsed = readHomeSearch(search)
    return !initialized && !homeSearch.some((key) => search[key] !== undefined)
      ? { ...parsed, sort: remembered.sort, reversed: remembered.reversed, withPersonas: remembered.withPersonas }
      : parsed
  }, [initialized, search, remembered.sort, remembered.reversed, remembered.withPersonas])
  // Mark even a default-only entry, so Back restores its defaults after a later choice
  // changed the account's choice. The marker survives reloads in this history entry.
  useEffect(() => {
    if (initialized || !ready) return
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({ ...prev, ...writeHomeSearch(state) }),
      state: (prev) => ({ ...prev, homeBrowse: true }),
      replace: true,
      resetScroll: false
    })
  }, [initialized, ready, navigate, state])

  const update = (change: Partial<HomeBrowse>) => {
    const next = changeHomeBrowse(state, change)
    if (change.sort !== undefined || change.reversed !== undefined || change.withPersonas !== undefined) remember(next)
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        ...writeHomeSearch(changeHomeBrowse(readHomeSearch(prev), change))
      }),
      state: (prev) => ({ ...prev, homeBrowse: true }),
      replace: change.filter === undefined,
      resetScroll: false
    })
  }
  return [state, update] as const
}

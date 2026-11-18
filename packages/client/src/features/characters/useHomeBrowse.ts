import { useMemo } from "react"
import { useNavigate, useSearch } from "@tanstack/react-router"
import { changeHomeBrowse, readHomeSearch, writeHomeSearch, type HomeBrowse } from "./homeSearch.ts"

/**
 * Home's browse state: its URL's (owner, 2026-11-18: a tab's view is its URL), the defaults where
 * a param is absent; nothing is remembered on the account, so another tab never changes it.
 */
export function useHomeBrowse() {
  const search = useSearch({ strict: false }) as Record<string, unknown>
  const navigate = useNavigate()
  const state = useMemo(() => readHomeSearch(search), [search])
  const update = (change: Partial<HomeBrowse>, options?: { replace?: boolean }) => {
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        ...writeHomeSearch(changeHomeBrowse(readHomeSearch(prev), change))
      }),
      replace:
        options?.replace ?? (change.filter === undefined && change.source === undefined && change.family === undefined),
      resetScroll: false
    })
  }
  return [state, update] as const
}

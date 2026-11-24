// A tab's router history over its own back and forward (history.ts): TanStack's memory history,
// but with entries the store can read, keep in session storage and name in the arrows' hovers.
import { createHistory, type HistoryLocation, type RouterHistory } from "@tanstack/react-router"
import { amend, go, push, replace, type TabEntry, type TabHistory } from "./history.ts"

type HistoryChange = "PUSH" | "REPLACE" | "GO"

/** Where a tab's history is kept (the store), and what's taken from the tab as it leaves an entry. */
export interface TabHistoryCell {
  readonly get: () => TabHistory
  readonly set: (next: TabHistory, change: HistoryChange) => void
  /** The entry shown is being left: its scroll positions and label, as the tab has them now. */
  readonly leaving: () => Partial<Pick<TabEntry, "scroll" | "label">>
}

let keys = 0
const newKey = () => `t${Date.now().toString(36)}${(keys++).toString(36)}`

const locationOf = (history: TabHistory): HistoryLocation => {
  const entry = history.entries[history.index]!
  const href = entry.href
  const hashAt = href.indexOf("#")
  const searchAt = href.indexOf("?")
  const end = (at: number) => (at < 0 ? href.length : at)
  const pathEnd = Math.min(end(hashAt), end(searchAt))
  const searchEnd = hashAt > searchAt ? end(hashAt) : href.length
  const state = (entry.state ?? {}) as Record<string, unknown>
  const key = typeof state.__TSR_key === "string" ? state.__TSR_key : newKey()
  return {
    href,
    pathname: href.slice(0, pathEnd),
    search: searchAt >= 0 && (hashAt < 0 || searchAt < hashAt) ? href.slice(searchAt, searchEnd) : "",
    hash: hashAt >= 0 ? href.slice(hashAt) : "",
    state: { ...state, key, __TSR_key: key, __TSR_index: history.index }
  } as HistoryLocation
}

/** A router history reading and writing `cell`'s entries; going back or forward needs no blockers. */
export const tabRouterHistory = (cell: TabHistoryCell): RouterHistory => {
  let blockers: ReturnType<NonNullable<Parameters<typeof createHistory>[0]["getBlockers"]>> = []
  // Every entry has its TanStack key from the start, so its location keeps one identity.
  const keyed = (history: TabHistory): TabHistory => {
    if (history.entries.every((e) => typeof e.state?.__TSR_key === "string")) return history
    return {
      ...history,
      entries: history.entries.map((e) => {
        if (typeof e.state?.__TSR_key === "string") return e
        const key = newKey()
        return { ...e, state: { ...e.state, key, __TSR_key: key } }
      })
    }
  }
  const start = cell.get()
  const first = keyed(start)
  if (first !== start) cell.set(first, "REPLACE")
  const leave = (history: TabHistory) => amend(history, cell.leaving())
  // The router's own steps (a page's Back) may reach below the arrows' floor: the opener's entry.
  const moved = (delta: number) => {
    const history = cell.get()
    const next = go({ ...history, floor: 0 }, delta)
    if (next.index === history.index) return
    cell.set({ ...leave(history), index: next.index }, "GO")
  }
  return createHistory({
    getLocation: () => locationOf(cell.get()),
    getLength: () => cell.get().entries.length,
    pushState: (path, state) => cell.set(push(leave(cell.get()), { href: path, state }), "PUSH"),
    replaceState: (path, state) => cell.set(replace(cell.get(), { href: path, state }), "REPLACE"),
    back: () => moved(-1),
    forward: () => moved(1),
    go: (n) => moved(n),
    createHref: (href) => href,
    getBlockers: () => blockers,
    setBlockers: (next) => {
      blockers = next
    }
  })
}

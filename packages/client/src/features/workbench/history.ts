// Each tab's own back and forward (owner, 2026-11-24; spec/TAB-HISTORY.md): the entries a tab
// went through and the one it shows. Pure; the store keeps one per tab and its router reads it
// through `tabRouterHistory.ts`.
//
// A push is a step (another place in the tab); a replace updates the entry shown (typing in a
// search box, a filter, a sort). The entries before `floor` are the tab's opener's (a tab opened
// from another starts there, so a page's own Back returns), which the arrows never go to.

/** A scrolled element as its path from the tab's element: child indices, and what it was. */
export interface ScrollMark {
  readonly path: ReadonlyArray<number>
  /** Its tag and attribute names, so a different element at that path isn't scrolled. */
  readonly what: string
  readonly top: number
  readonly left: number
}

export interface TabEntry {
  readonly href: string
  /** The view's history state at this URL (TanStack's own keys left out). */
  readonly state?: Readonly<Record<string, unknown>>
  /** The tab's scroll positions when it left this entry. */
  readonly scroll?: ReadonlyArray<ScrollMark>
  /** What the hovers call it: the tab's title, or the place the view named, while it was shown. */
  readonly label?: string
}

export interface TabHistory {
  readonly entries: ReadonlyArray<TabEntry>
  readonly index: number
  readonly floor: number
}

/** The most entries a tab keeps: a step past it drops the oldest. */
export const MAX_ENTRIES = 50

/** A tab's first history: its URL, after its opener's when it was opened from another tab. */
export const freshHistory = (href: string, openedFrom?: string): TabHistory =>
  openedFrom === undefined
    ? { entries: [{ href }], index: 0, floor: 0 }
    : { entries: [{ href: openedFrom }, { href }], index: 1, floor: 1 }

export const current = (history: TabHistory): TabEntry => history.entries[history.index]!

/** A step: forward is cleared, the oldest dropped past the cap. The URL shown already replaces it. */
export const push = (history: TabHistory, entry: TabEntry, max = MAX_ENTRIES): TabHistory => {
  if (current(history).href === entry.href) return replace(history, entry)
  const entries = [...history.entries.slice(0, history.index + 1), entry]
  const drop = Math.max(0, entries.length - max)
  return {
    entries: entries.slice(drop),
    index: entries.length - 1 - drop,
    floor: Math.max(0, history.floor - drop)
  }
}

/** The entry shown takes a new URL and state; what was taken when it was left stays. */
export const replace = (history: TabHistory, entry: TabEntry): TabHistory => {
  const entries = [...history.entries]
  const { scroll, label } = current(history)
  entries[history.index] = {
    ...(scroll ? { scroll } : {}),
    ...(label !== undefined ? { label } : {}),
    ...entry
  }
  return { ...history, entries }
}

/** Updates the entry shown with what's taken as it's left (its scroll, its label). */
export const amend = (history: TabHistory, change: Partial<Pick<TabEntry, "scroll" | "label">>): TabHistory => {
  const entries = [...history.entries]
  entries[history.index] = { ...current(history), ...change }
  return { ...history, entries }
}

/** `delta` entries back (negative) or forward, within what the arrows reach; unchanged past the ends. */
export const go = (history: TabHistory, delta: number): TabHistory => {
  const index = history.index + delta
  if (index < history.floor || index >= history.entries.length) return history
  return { ...history, index }
}

/** The entry `delta` steps away that the arrows can reach, if any. */
export const destination = (history: TabHistory, delta: number): TabEntry | undefined => {
  const index = history.index + delta
  return index < history.floor || index >= history.entries.length ? undefined : history.entries[index]
}

/** Where `href` is in the history right beside the entry shown (-1 back, 1 forward), else 0. */
export const besideAt = (history: TabHistory, href: string): -1 | 0 | 1 => {
  if (destination(history, -1)?.href === href) return -1
  if (destination(history, 1)?.href === href) return 1
  return 0
}

// --- Storage (sessionStorage, per browser tab): what's written and read back.

const STORED_VERSION = 1
/** At most this many scrolled elements per entry. */
const MAX_MARKS = 20

const appHref = (value: unknown): value is string =>
  typeof value === "string" && value.startsWith("/") && !value.startsWith("//") && value.length <= 8192

const plainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const markOf = (value: unknown): ScrollMark | null => {
  if (!plainObject(value)) return null
  const { path, what, top, left } = value
  if (!Array.isArray(path) || path.length > 64 || !path.every((n) => Number.isInteger(n) && n >= 0)) return null
  if (typeof what !== "string" || typeof top !== "number" || typeof left !== "number") return null
  if (!Number.isFinite(top) || !Number.isFinite(left)) return null
  return { path: path as Array<number>, what: what.slice(0, 500), top, left }
}

const entryOf = (value: unknown): TabEntry | null => {
  if (!plainObject(value) || !appHref(value.href)) return null
  const scroll = Array.isArray(value.scroll)
    ? value.scroll
        .slice(0, MAX_MARKS)
        .map(markOf)
        .filter((m): m is ScrollMark => m !== null)
    : []
  return {
    href: value.href,
    ...(plainObject(value.state) && Object.keys(value.state).length > 0 ? { state: value.state } : {}),
    ...(scroll.length > 0 ? { scroll } : {}),
    ...(typeof value.label === "string" ? { label: value.label.slice(0, 300) } : {})
  }
}

/** The JSON for a history, or null when it can't be written (state that isn't JSON). */
export const encodeHistory = (history: TabHistory): string | null => {
  // TanStack's own keys are made afresh on reading.
  const entries = history.entries.map(({ state, ...entry }) => {
    if (!state) return entry
    const { __TSR_index: _i, __TSR_key: _k, key: _key, ...rest } = state
    return Object.keys(rest).length > 0 ? { ...entry, state: rest } : entry
  })
  try {
    return JSON.stringify({ v: STORED_VERSION, entries, index: history.index, floor: history.floor })
  } catch {
    return null
  }
}

/** A history written by `encodeHistory`, repaired; null for anything else. */
export const decodeHistory = (text: string | null): TabHistory | null => {
  if (text === null) return null
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!plainObject(raw) || raw.v !== STORED_VERSION || !Array.isArray(raw.entries)) return null
  const all = raw.entries.map(entryOf)
  const at = typeof raw.index === "number" && Number.isInteger(raw.index) ? raw.index : -1
  if (at < 0 || at >= all.length || all[at] === null) return null
  // Invalid entries are dropped; the index and floor follow the entries kept.
  const kept: Array<TabEntry> = []
  let index = 0
  let floor = 0
  const rawFloor = typeof raw.floor === "number" && Number.isInteger(raw.floor) ? raw.floor : 0
  all.forEach((entry, i) => {
    if (i === at) index = kept.length
    if (i === rawFloor) floor = kept.length
    if (entry) kept.push(entry)
  })
  const drop = Math.max(0, kept.length - MAX_ENTRIES)
  const entries = kept.slice(drop)
  index = Math.max(0, index - drop)
  if (index >= entries.length) return null
  return { entries, index, floor: Math.min(Math.max(0, floor - drop), index) }
}

/**
 * After a reload (tab ids are made afresh): each restored tab, in layout order, takes the next
 * saved tab of the same item, skipping saved tabs the layout left out. `key` names a URL's item.
 */
export const matchSaved = <T extends { readonly id: string; readonly href: string }>(
  saved: ReadonlyArray<readonly [id: string, item: string]>,
  tabs: ReadonlyArray<T>,
  key: (href: string) => string
): Map<string, string> => {
  const matches = new Map<string, string>()
  let next = 0
  for (const tab of tabs) {
    const item = key(tab.href)
    const at = saved.findIndex(([, savedItem], i) => i >= next && savedItem === item)
    if (at < 0) continue
    matches.set(tab.id, saved[at]![0])
    next = at + 1
  }
  return matches
}

/** The order list written with the layout: `[[tab id, item], ...]`; empty for anything else. */
export const decodeOrder = (text: string | null): Array<readonly [string, string]> => {
  if (text === null) return []
  try {
    const raw: unknown = JSON.parse(text)
    if (!Array.isArray(raw)) return []
    return raw.flatMap((pair: unknown) =>
      Array.isArray(pair) && pair.length === 2 && typeof pair[0] === "string" && typeof pair[1] === "string"
        ? [[pair[0], pair[1]] as const]
        : []
    )
  } catch {
    return []
  }
}

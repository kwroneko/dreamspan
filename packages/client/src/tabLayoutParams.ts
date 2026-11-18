// The layout a browser tab shows (owner, 2026-11-18: layout "has to be in the URL"): whether the
// sidebar is hidden, the columns' widths, the sidebar foot's sections, the workbench's frames.
// It's in the browser tab's URL, as query params omitted at their defaults, so a reload, a
// copied link and a duplicated tab all show it, and nothing one tab does reaches another (no
// browser storage).
//
// The params are registered (`layoutParams`) and belong to the browser's URL, never a workbench
// tab's (workbench/store.ts keeps them off tabs' URLs). The page holds the current layout and
// the URL follows it: read from the URL the page loaded with, then changed only by a write here.
// Every navigation of the browser tab (a link, a programmatic navigation, Back, Forward) carries
// it: when one lands without it, the entry is replaced with it put back. So moving around keeps
// the layout, and Back and Forward go between pages, not between layout changes. A link's own
// address carries none of it, so one opened in a new browser tab starts from the defaults.
//
// A change replaces the browser's history entry (no new one). While a drag holds writes
// (`holdLayoutWrites`), its values show at once and reach the URL once when it ends.
import type { RouterHistory } from "@tanstack/react-router"
import { useSyncExternalStore } from "react"
import { makeRegistry } from "./registry.ts"

/** Query params that are the browser tab's layout: carried over navigation, the browser's own. */
export const layoutParams = makeRegistry<{ readonly id: string; readonly keys: ReadonlyArray<string> }>()

export const layoutKeys = () => new Set(layoutParams.list().flatMap((entry) => entry.keys))

let browser: RouterHistory | null = null
let unsubscribe: (() => void) | null = null
const listeners = new Set<() => void>()
/** The URL the page loaded with: a param not written since reads from it. */
let loaded = new URLSearchParams()
/** The values written since, ahead of the load's. null: removed. */
const values = new Map<string, string | null>()
let held = 0
/** Other URL writes a drag defers (`whenDragEnds`), the latest per key. */
const deferred = new Map<string, () => void>()
let writing = false
let queued = false

const notify = () => {
  for (const listener of listeners) listener()
}

/** The router writes a string that reads as JSON in quotes; these are words, numbers and JSON. */
const unquote = (value: string | null) =>
  value !== null && value.length > 1 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value

/** A layout param's value: the page's current one; null when absent. */
export const readLayoutParam = (key: string): string | null =>
  values.has(key) ? (values.get(key) ?? null) : unquote(loaded.get(key))

const clean = (state: unknown) => {
  if (typeof state !== "object" || state === null) return {}
  const { __TSR_index: _i, __TSR_key: _k, key: _key, ...rest } = state as Record<string, unknown>
  return rest
}

/** `href` with the layout as the page has it. */
export const withLayoutParams = (href: string) => {
  const url = new URL(href, "http://tab.invalid")
  for (const key of layoutKeys()) {
    const value = readLayoutParam(key)
    if (value === null) url.searchParams.delete(key)
    else if (unquote(url.searchParams.get(key)) !== value) url.searchParams.set(key, value)
  }
  const search = url.searchParams.toString()
  return `${url.pathname}${search ? `?${search}` : ""}${url.hash}`
}

/** Puts the browser's URL in step with the layout, replacing its entry, unless it is already. */
const sync = () => {
  queued = false
  if (!browser || held > 0) return
  const href = withLayoutParams(browser.location.href)
  const same = (a: string, b: string) => {
    const x = new URL(a, "http://tab.invalid")
    const y = new URL(b, "http://tab.invalid")
    return [...layoutKeys()].every((key) => unquote(x.searchParams.get(key)) === unquote(y.searchParams.get(key)))
  }
  if (same(href, browser.location.href)) return
  writing = true
  try {
    browser.replace(href, clean(browser.location.state), { ignoreBlocker: true })
  } finally {
    writing = false
  }
}

/** After whatever else follows this navigation (the workbench's own mirror) has run. */
const queueSync = () => {
  if (queued) return
  queued = true
  queueMicrotask(sync)
}

/** The browser tab's own history (the app's router, routes.tsx): where layout params live. */
export const setLayoutHistory = (history: RouterHistory) => {
  unsubscribe?.()
  browser = history
  loaded = new URLSearchParams(history.location.search)
  values.clear()
  unsubscribe = history.subscribe(() => {
    if (!writing) queueSync()
    notify()
  })
  notify()
}

/** Sets (null: removes) layout params: shown at once, in the browser's URL by replacing its entry. */
export const writeLayoutParams = (next: Readonly<Record<string, string | null>>) => {
  let changed = false
  for (const [key, value] of Object.entries(next))
    if (readLayoutParam(key) !== value) {
      values.set(key, value)
      changed = true
    }
  if (!changed) return
  notify()
  if (held === 0) sync()
}

export const writeLayoutParam = (key: string, value: string | null) => writeLayoutParams({ [key]: value })

/** Holds URL writes during a drag: shown at once, written to the URL once by the returned release. */
export const holdLayoutWrites = () => {
  held++
  let released = false
  return () => {
    if (released) return
    released = true
    held--
    if (held > 0) return
    sync()
    const run = [...deferred.values()]
    deferred.clear()
    for (const write of run) write()
  }
}

/**
 * Runs `write` (a URL write of a page's own, a portrait's size) now, or while a drag holds
 * writes, once it ends: only the last one given for `key` (so each writer keys its own).
 */
export const whenDragEnds = (key: string, write: () => void) => {
  if (held === 0) write()
  else deferred.set(key, write)
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

/** A layout param, following writes. */
export const useLayoutParam = (key: string) => useSyncExternalStore(subscribe, () => readLayoutParam(key))

/** A layout param read as a whole number of at least `min`, else null. */
export const useLayoutNumber = (key: string, min: number) => {
  const raw = useLayoutParam(key)
  const value = raw === null ? Number.NaN : Number(raw)
  return Number.isFinite(value) && value >= min ? Math.round(value) : null
}

/** `href` without the layout params: a workbench tab's own URL. */
export const withoutLayoutParams = (href: string) => {
  const keys = layoutKeys()
  if (keys.size === 0) return href
  const url = new URL(href, "http://tab.invalid")
  let changed = false
  for (const key of keys)
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key)
      changed = true
    }
  if (!changed) return href
  const search = url.searchParams.toString()
  return `${url.pathname}${search ? `?${search}` : ""}${url.hash}`
}

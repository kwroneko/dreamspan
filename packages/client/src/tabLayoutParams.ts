// The layout a browser tab shows around its pages (owner, 2026-11-18): whether the sidebar is
// hidden, the columns' widths, the sidebar foot's sections. It's in the browser tab's URL, as
// query params omitted at their defaults, so reload, Back and Forward, a copied link and a
// duplicated tab all show it, and nothing one tab does reaches another (no browser storage).
//
// The params are registered (`layoutParams`) and belong to the browser's URL, never a workbench
// tab's (workbench/store.ts keeps them off tabs' URLs and on the browser's). The browser's router
// carries them over every navigation that doesn't name them (routes.tsx), so moving around the
// app keeps the layout; a link opened in a new browser tab starts from the defaults.
//
// A change replaces the browser's history entry (no new one). While a drag holds writes
// (`holdLayoutWrites`), its values show at once and reach the URL once when it ends.
import { makeRegistry } from "./registry.ts"
import type { RouterHistory } from "@tanstack/react-router"
import { useSyncExternalStore } from "react"

/** Query params that are the browser tab's layout: carried over navigation, the browser's own. */
export const layoutParams = makeRegistry<{ readonly id: string; readonly keys: ReadonlyArray<string> }>()

export const layoutKeys = () => new Set(layoutParams.list().flatMap((entry) => entry.keys))

let browser: RouterHistory | null = null
let unsubscribe: (() => void) | null = null
const listeners = new Set<() => void>()
/** Values written while a drag holds writes, ahead of the URL. null: removed. */
const pending = new Map<string, string | null>()
let held = 0
/** Other URL writes a drag defers (`whenDragEnds`), the latest per key. */
const deferred = new Map<string, () => void>()

const notify = () => {
  for (const listener of listeners) listener()
}

/** The browser tab's own history (the app's router, routes.tsx): where layout params live. */
export const setLayoutHistory = (history: RouterHistory) => {
  unsubscribe?.()
  browser = history
  pending.clear()
  unsubscribe = history.subscribe(notify)
  notify()
}

const params = () => new URLSearchParams(browser?.location.search ?? "")
/** The router writes a string that reads as JSON in quotes; the params here are words and numbers. */
const unquote = (value: string | null) => (value === null ? null : value.replace(/^"(.*)"$/, "$1"))

/** A layout param's value: a held write's, else the browser URL's; null when absent. */
export const readLayoutParam = (key: string): string | null =>
  pending.has(key) ? (pending.get(key) ?? null) : unquote(params().get(key))

const clean = (state: unknown) => {
  if (typeof state !== "object" || state === null) return {}
  const { __TSR_index: _i, __TSR_key: _k, key: _key, ...rest } = state as Record<string, unknown>
  return rest
}

const flush = () => {
  if (!browser || pending.size === 0) {
    pending.clear()
    return
  }
  const url = new URL(browser.location.href, "http://tab.invalid")
  for (const [key, value] of pending) {
    if (value === null) url.searchParams.delete(key)
    else url.searchParams.set(key, value)
  }
  pending.clear()
  const href = `${url.pathname}${url.search}${url.hash}`
  if (href === browser.location.href) return notify()
  browser.replace(href, clean(browser.location.state), { ignoreBlocker: true })
}

/** Sets (null: removes) layout params in the browser's URL, replacing its entry. */
const writeLayoutParams = (values: Readonly<Record<string, string | null>>) => {
  for (const [key, value] of Object.entries(values)) pending.set(key, value)
  if (held > 0) notify()
  else flush()
}

export const writeLayoutParam = (key: string, value: string | null) => writeLayoutParams({ [key]: value })

/** Holds writes during a drag: shown at once, written to the URL once by the returned release. */
export const holdLayoutWrites = () => {
  held++
  let released = false
  return () => {
    if (released) return
    released = true
    held--
    if (held > 0) return
    flush()
    const run = [...deferred.values()]
    deferred.clear()
    for (const write of run) write()
  }
}

/**
 * Runs `write` (a URL write of a page's own, a portrait's size) now, or while a drag holds
 * writes, once it ends: only the last one given for `key`.
 */
export const whenDragEnds = (key: string, write: () => void) => {
  if (held === 0) write()
  else deferred.set(key, write)
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

/** A layout param, following the URL (Back, Forward, a write). */
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

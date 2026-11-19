// A place's small URL choices follow home's conventions: omit defaults, preserve unrelated
// keys, replace filters, push places, and keep the surrounding scroll position.
import { type AnyRouter, useNavigate, useRouter, useSearch } from "@tanstack/react-router"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { showToast } from "./ui/Toast.tsx"

export function usePlaceParam(
  key: string,
  fallback: string
): readonly [string, (next: string, replace?: boolean) => void]
export function usePlaceParam<T extends string>(
  key: string,
  fallback: T,
  choices: ReadonlyArray<T>
): readonly [T, (next: T, replace?: boolean) => void]
export function usePlaceParam<T extends string>(key: string, fallback: T, choices?: ReadonlyArray<T>) {
  const raw = useSearch({ strict: false, select: (s: Record<string, unknown>) => s[key] })
  const navigate = useNavigate()
  const value = typeof raw === "string" && (!choices || choices.includes(raw as T)) ? (raw as T) : fallback
  usePlaceNotice(
    raw !== undefined && (typeof raw !== "string" || (choices !== undefined && !choices.includes(raw as T)))
      ? "This view is no longer available. Showing the default view."
      : null
  )
  const set = useCallback(
    (next: T, replace = false) => {
      if (next === value && (raw === undefined || raw === next)) return
      void navigate({
        to: ".",
        search: (prev: Record<string, unknown>) => ({ ...prev, [key]: next === fallback ? undefined : next }),
        state: (prev) => ({ ...prev }),
        replace,
        resetScroll: false
      })
    },
    [navigate, key, fallback, raw, value]
  )
  return [value, set] as const
}

/** JSON query values are decoded by the router; reject malformed collections independently. */
export function usePlaceList(key: string) {
  const raw = useSearch({ strict: false, select: (s: Record<string, unknown>) => s[key] })
  const navigate = useNavigate()
  const value = useMemo(
    () => (Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string").slice(0, 500) : []),
    [raw]
  )
  const set = useCallback(
    (next: ReadonlyArray<string>, replace = false) => {
      if (JSON.stringify(next) === JSON.stringify(value)) return
      void navigate({
        to: ".",
        search: (prev: Record<string, unknown>) => ({ ...prev, [key]: next.length ? next : undefined }),
        state: (prev) => ({ ...prev }),
        replace,
        resetScroll: false
      })
    },
    [navigate, key, value]
  )
  return [value, set] as const
}

/** A value just set, over the URL's `base` it was set from. */
export interface PlaceOverride {
  readonly base: string
  readonly value: unknown
}

const text = (value: unknown) => JSON.stringify(value) ?? "undefined"

/**
 * What shows: a value just set while the URL still has what it was set from, else the URL's.
 * Once the URL's value has moved off `base` (the replace landing, or Back or Forward to an entry
 * with another value) the override is spent (`spentOverride`), so a later return to `base`
 * shows the URL's, not the old override.
 */
export const shownPlaceValue = (local: PlaceOverride | null, raw: unknown) =>
  local !== null && local.base === text(raw) ? local.value : raw

export const spentOverride = (local: PlaceOverride | null, raw: unknown) => local !== null && local.base !== text(raw)

/**
 * Replaces `key` in the router's URL with `next(current)`, no history entry; `undefined` removes
 * it. `current` is read from the location the router builds its next navigation on: the one the
 * last navigation built, even before it has landed. A workbench tab's history lands a change
 * only after its blocker has been asked (a microtask later), so reading the router's current
 * location instead lost the first of two writes in one tick (Duplicate's opened copy). The
 * write is built on that same location, so writes in a row compose, of one key or several.
 * Returns the value written, or `unchanged`.
 */
export const writePlaceValue = (
  router: AnyRouter,
  key: string,
  next: (current: unknown) => unknown
): { readonly value: unknown } | "unchanged" => {
  let current: unknown
  router.buildLocation({
    to: ".",
    search: (prev: Record<string, unknown>) => {
      current = prev[key]
      return prev
    }
  })
  const value = next(current)
  if (text(value) === text(current)) return "unchanged"
  void router.navigate({
    to: ".",
    search: (prev: Record<string, unknown>) => ({ ...prev, [key]: value }),
    state: (prev) => ({ ...prev }),
    replace: true,
    resetScroll: false
  })
  return { value }
}

/**
 * A query value as the router decoded it, and a setter that replaces it (no history entry),
 * computing the next value from the URL as the router's next navigation will have it
 * (`writePlaceValue`), so updates in a row compose. `undefined` removes it. A value set shows in
 * the same render, before the router has settled the navigation (an entry opened and focused at
 * once), until the URL's value changes; then the URL's shows, so Back and Forward show what
 * their entries hold.
 */
export function usePlaceValue(key: string) {
  const raw: unknown = useSearch({ strict: false, select: (s: Record<string, unknown>) => s[key] })
  const router = useRouter()
  const [local, setLocal] = useState<PlaceOverride | null>(null)
  // Dropped in render once the URL moved (React's "adjusting state when a prop changes").
  if (spentOverride(local, raw)) setLocal(null)
  const shown = shownPlaceValue(local, raw)
  const set = useCallback(
    (next: (current: unknown) => unknown) => {
      const written = writePlaceValue(router, key, next)
      if (written !== "unchanged") setLocal({ base: text(raw), value: written.value })
    },
    [router, key, raw]
  )
  return [shown, set] as const
}

let recentNotice = { title: "", at: 0 }

/** Existing notices explain stale links without inventing another error surface. */
export function usePlaceNotice(problem: string | null) {
  const previous = useRef<string | null>(null)
  useEffect(() => {
    if (
      problem !== null &&
      previous.current !== problem &&
      (recentNotice.title !== problem || Date.now() - recentNotice.at > 1000)
    ) {
      recentNotice = { title: problem, at: Date.now() }
      showToast({ title: problem })
    }
    previous.current = problem
  }, [problem])
}

/** Expansion uses one query value so changing its base and exceptions is atomic. */
export function usePlaceExpansion(key: string, defaultOpen: boolean) {
  const [saved, setSaved] = usePlaceList(key)
  const all = saved[0] === "open" ? true : saved[0] === "closed" ? false : defaultOpen
  const except = new Set(saved.slice(1))
  const set = (next: { all: boolean; except: ReadonlySet<string> }) =>
    setSaved(
      next.all === defaultOpen && next.except.size === 0 ? [] : [next.all ? "open" : "closed", ...next.except],
      true
    )
  return [{ all, except }, set] as const
}

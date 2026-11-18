// A place's small URL choices follow home's conventions: omit defaults, preserve unrelated
// keys, replace filters, push places, and keep the surrounding scroll position.
import { useNavigate, useRouter, useSearch } from "@tanstack/react-router"
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

/**
 * A query value as the router decoded it, and a setter that replaces it (no history entry),
 * computing the next value from the URL as it is at the call, so updates in a row compose.
 * `undefined` removes it. A value set shows in the same render, before the router has
 * settled the navigation (an entry opened and focused at once), until the URL changes.
 */
export function usePlaceValue(key: string) {
  const raw: unknown = useSearch({ strict: false, select: (s: Record<string, unknown>) => s[key] })
  const navigate = useNavigate()
  const router = useRouter()
  const [local, setLocal] = useState<{ readonly base: unknown; readonly value: unknown } | null>(null)
  const shown = local !== null && local.base === raw ? local.value : raw
  const set = useCallback(
    (next: (current: unknown) => unknown) => {
      const current = (router.latestLocation.search as Record<string, unknown>)[key]
      const value = next(current)
      if (JSON.stringify(value) === JSON.stringify(current)) return
      setLocal({ base: raw, value })
      void navigate({
        to: ".",
        search: (prev: Record<string, unknown>) => ({ ...prev, [key]: value }),
        state: (prev) => ({ ...prev }),
        replace: true,
        resetScroll: false
      })
    },
    [router, navigate, key, raw]
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

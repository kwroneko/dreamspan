// Which of a book's entries are open (owner, 2026-11-01: per entry; coordinator, 2026-11-02:
// per view): in the URL's `<scope>:open` (owner, 2026-11-18: the URL is the tab's state), the
// large editor's and the side panel's each their own, so each view restores its own expansion
// on reload and no other browser tab follows it.
import { useEffect, useMemo, useState } from "react"
import { usePlaceValue } from "../../usePlaceParam.ts"

/** At most this many open entries are kept per view: past it, the oldest open closed. */
const LIMIT = 2000

export const decodeOpen = (raw: unknown): ReadonlySet<number> =>
  new Set(
    (Array.isArray(raw) ? raw : [])
      .map((uid) => (typeof uid === "string" ? Number(uid) : uid))
      .filter((uid): uid is number => Number.isInteger(uid))
  )

/** The URL's value: absent with none open. */
export const encodeOpen = (open: ReadonlySet<number>) => (open.size === 0 ? undefined : [...open].slice(-LIMIT))

/**
 * The open entries and their setter, for the view whose URL scope is `scope`. `initial` opens one
 * besides (just added).
 */
export function useOpenEntries(scope: string, initial: number | null) {
  const [raw, setRaw] = usePlaceValue(`${scope}:open`)
  const open = useMemo(() => decodeOpen(raw), [raw])
  const setOpen = (next: ReadonlySet<number> | ((open: ReadonlySet<number>) => ReadonlySet<number>)) =>
    setRaw((current) => encodeOpen(typeof next === "function" ? next(decodeOpen(current)) : next))
  // The entry just added when the view mounted opens with it, then is in the URL like any other.
  // Until that write reaches the URL (the value still the one it mounted with), it shows open.
  const [mounted] = useState(() => ({ initial, raw }))
  useEffect(() => {
    const { initial: adding } = mounted
    if (adding !== null) setRaw((current) => encodeOpen(new Set(decodeOpen(current)).add(adding)))
  }, [mounted, setRaw])
  const adding = mounted.initial !== null && raw === mounted.raw ? mounted.initial : null
  const shown = useMemo(() => (adding === null || open.has(adding) ? open : new Set(open).add(adding)), [open, adding])
  return [shown, setOpen] as const
}

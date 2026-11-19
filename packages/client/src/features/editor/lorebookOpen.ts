// Which of a book's entries are open (owner, 2026-11-01: per entry; coordinator, 2026-11-02:
// per view): in the URL's `<scope>:open` (owner, 2026-11-18: the URL is the tab's state), the
// large editor's and the side panel's each their own, so each view restores its own expansion
// on reload and no other browser tab follows it.
import { useEffect, useMemo, useRef, useState } from "react"
import { usePlaceValue } from "../../usePlaceParam.ts"

/**
 * At most this many uids go in the URL (a few hundred bytes), so the whole URL stays well
 * under 2 KB: past it, the oldest choices are dropped (opened ones close; closed ones under
 * "all" open again). Expand all is a mode, never a list.
 */
export const OPEN_LIMIT = 50

const uidsOf = (raw: ReadonlyArray<unknown>) =>
  raw
    .slice(0, OPEN_LIMIT + 1)
    .map((uid) => (typeof uid === "string" ? Number(uid) : uid))
    .filter((uid): uid is number => Number.isInteger(uid))

/**
 * The open entries from the URL: a list of open uids, or `["all", ...closed uids]` (every entry
 * of the book, `uids`, but those).
 */
export const decodeOpen = (raw: unknown, uids: ReadonlyArray<number>): ReadonlySet<number> => {
  const list = Array.isArray(raw) ? raw : []
  if (list[0] === "all") {
    const closed = new Set(uidsOf(list.slice(1)))
    return new Set(uids.filter((uid) => !closed.has(uid)))
  }
  return new Set(uidsOf(list))
}

/** Whether the URL's value is the "all" mode (Expand all, then some closed). */
const allMode = (raw: unknown) => Array.isArray(raw) && raw[0] === "all"

/**
 * The URL's value: absent with none open; in the "all" mode (`all`: Expand all, or the value
 * was in it already) every entry but the closed ones, so entries added later show open too;
 * else the open ones. Only the user's Expand all starts the mode: entries opened one by one
 * never make later ones open.
 */
export const encodeOpen = (open: ReadonlySet<number>, uids: ReadonlyArray<number>, all = false) => {
  if (open.size === 0) return undefined
  if (all) return ["all", ...uids.filter((uid) => !open.has(uid)).slice(-OPEN_LIMIT)]
  return [...open].slice(-OPEN_LIMIT)
}

/**
 * The open entries and their setter, for the view whose URL scope is `scope`. `initial` opens one
 * besides (just added).
 */
export function useOpenEntries(scope: string, initial: number | null, uids: ReadonlyArray<number>) {
  const [raw, setRaw] = usePlaceValue(`${scope}:open`)
  const open = useMemo(() => decodeOpen(raw, uids), [raw, uids])
  /** `all`: the user's Expand all, which starts the "all" mode. */
  const setOpen = (next: ReadonlySet<number> | ((open: ReadonlySet<number>) => ReadonlySet<number>), all = false) =>
    setRaw((current) =>
      encodeOpen(typeof next === "function" ? next(decodeOpen(current, uids)) : next, uids, all || allMode(current))
    )
  // The entry just added when the view mounted opens with it, then is in the URL like any other.
  // Until that write reaches the URL it shows open; once the URL's value has moved at all, never
  // again (comparing with the mount's value instead kept it open: closing it put the URL back
  // to that value).
  const [mounted] = useState(() => ({ initial, raw, uids }))
  const [landed, setLanded] = useState(false)
  if (!landed && raw !== mounted.raw) setLanded(true)
  // Once, when the view mounts. `setRaw` changes with each URL value, so the effect runs again
  // after every write: without the flag, closing the added entry opened it again at once.
  const wrote = useRef(false)
  useEffect(() => {
    const { initial: adding } = mounted
    if (wrote.current || adding === null) return
    wrote.current = true
    // The book's entries as they are at mount.
    const all = mounted.uids
    setRaw((current) => encodeOpen(new Set(decodeOpen(current, all)).add(adding), all, allMode(current)))
  }, [mounted, setRaw])
  const adding = mounted.initial !== null && !landed && raw === mounted.raw ? mounted.initial : null
  const shown = useMemo(() => (adding === null || open.has(adding) ? open : new Set(open).add(adding)), [open, adding])
  return [shown, setOpen] as const
}

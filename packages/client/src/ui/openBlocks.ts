// Which blocks of a list are open (owner, 2026-11-01): each one's own choice, in the URL's
// `param` (owner, 2026-11-18: the URL is the tab's state; one param per list), and until a
// block has one, the list's default: open while the list is short. The value lists the blocks
// with a choice, an open one by its id and a closed one as `!id`. Expand all and Collapse all
// set every block's.
import { useMemo } from "react"
import { usePlaceValue } from "../usePlaceParam.ts"

/** Up to this many blocks, a list opens them all by default. */
const OPEN_WHEN_FEWER_THAN = 5

/** How many choices are kept per list: the oldest go first. */
const KEPT = 500

type Choices = ReadonlyMap<string, boolean>

export const decodeChoices = (raw: unknown): Choices =>
  new Map(
    (Array.isArray(raw) ? raw : [])
      .filter((v): v is string => typeof v === "string" && v !== "" && v !== "!")
      .map((v) => (v.startsWith("!") ? [v.slice(1), false] : [v, true]))
  )

/** The URL's value: undefined (absent) with no choices. */
export const encodeChoices = (choices: Choices) => {
  const list = [...choices].map(([id, open]) => (open ? id : `!${id}`)).slice(-KEPT)
  return list.length === 0 ? undefined : list
}

export interface OpenBlocks {
  readonly isOpen: (id: string) => boolean
  readonly setOpen: (id: string, open: boolean) => void
  /** Every one of `ids` open, or closed. */
  readonly setAll: (ids: ReadonlyArray<string>, open: boolean) => void
}

/**
 * The open state of a list's blocks, kept in the URL's `param`. `count` is how many the list
 * shows: below `OPEN_WHEN_FEWER_THAN`, a block with no choice of its own is open.
 */
export function useOpenBlocks(param: string, count: number): OpenBlocks {
  const [raw, setRaw] = usePlaceValue(param)
  const choices = useMemo(() => decodeChoices(raw), [raw])
  const change = (next: (current: Map<string, boolean>) => void) =>
    setRaw((current) => {
      const map = new Map(decodeChoices(current))
      next(map)
      return encodeChoices(map)
    })
  const fallback = count < OPEN_WHEN_FEWER_THAN
  return {
    isOpen: (id) => choices.get(id) ?? fallback,
    setOpen: (id, open) =>
      change((map) => {
        // The latest choice goes last, so the oldest are dropped first.
        map.delete(id)
        map.set(id, open)
      }),
    setAll: (ids, open) =>
      change((map) => {
        for (const id of ids) {
          map.delete(id)
          map.set(id, open)
        }
      })
  }
}

// Which blocks of a list are open (owner, 2026-11-01): each one's own choice, in the URL's
// `param` (owner, 2026-11-18: the URL is the tab's state; one param per list), and until a
// block has one, the list's default: open while the list is short. Expand all and Collapse all
// set that default for every block (a mode in the URL), then each block's choice since is
// listed, at most `KEPT`.
import { useMemo } from "react"
import { usePlaceValue } from "../usePlaceParam.ts"

/** Up to this many blocks, a list opens them all by default. */
const OPEN_WHEN_FEWER_THAN = 5

/**
 * How many blocks' own choices go in the URL (ids are long: this keeps the whole URL well under
 * 2 KB); the oldest go first. Expand all and Collapse all are a mode, never a list.
 */
export const KEPT = 20

export interface Choices {
  /** Expand all (true) or Collapse all (false) was the last; undefined: the list's default. */
  readonly all?: boolean
  /** Each block's own choice since. */
  readonly each: ReadonlyMap<string, boolean>
}

const NONE: Choices = { each: new Map() }

/** The URL's value: `"*"` (all open) or `"!*"` (all closed) first, then `id` open and `!id` closed. */
export const decodeChoices = (raw: unknown): Choices => {
  const list = (Array.isArray(raw) ? raw : []).filter(
    (v): v is string => typeof v === "string" && v !== "" && v !== "!"
  )
  const all = list[0] === "*" ? true : list[0] === "!*" ? false : undefined
  const rest = (all === undefined ? list : list.slice(1)).slice(-KEPT)
  return {
    ...(all === undefined ? {} : { all }),
    each: new Map(rest.map((v) => (v.startsWith("!") ? [v.slice(1), false] : [v, true])))
  }
}

/** The URL's value: undefined (absent) with no choices. */
export const encodeChoices = (choices: Choices) => {
  const list = [
    ...(choices.all === undefined ? [] : [choices.all ? "*" : "!*"]),
    ...[...choices.each].map(([id, open]) => (open ? id : `!${id}`)).slice(-KEPT)
  ]
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
  const choices = useMemo(() => (raw === undefined ? NONE : decodeChoices(raw)), [raw])
  const change = (next: (current: Choices) => Choices) =>
    setRaw((current) => encodeChoices(next(decodeChoices(current))))
  const fallback = choices.all ?? count < OPEN_WHEN_FEWER_THAN
  return {
    isOpen: (id) => choices.each.get(id) ?? fallback,
    setOpen: (id, open) =>
      change((current) => {
        // The latest choice goes last, so the oldest are dropped first.
        const each = new Map(current.each)
        each.delete(id)
        each.set(id, open)
        return { ...current, each }
      }),
    // Every block, as a mode: the URL stays short however long the list.
    setAll: (_ids, open) => change(() => ({ all: open, each: new Map() }))
  }
}

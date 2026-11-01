// Which blocks of a list are open (owner, 2026-11-01): each one's own choice, remembered in this
// browser under `key` (one per user and list), and until a block has one, the list's default:
// open while the list is short. Expand all and Collapse all set every block's.
import { useCallback, useState } from "react"

/** Up to this many blocks, a list opens them all by default. */
const OPEN_WHEN_FEWER_THAN = 5

/** How many choices are kept per list: the oldest go first. */
const KEPT = 500

type Choices = Readonly<Record<string, boolean>>

const read = (key: string): Choices => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? "{}")
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Choices) : {}
  } catch {
    return {}
  }
}

const write = (key: string, choices: Choices) => {
  try {
    const entries = Object.entries(choices)
    localStorage.setItem(key, JSON.stringify(Object.fromEntries(entries.slice(-KEPT))))
  } catch {
    /* Kept in memory while storage is off. */
  }
}

export interface OpenBlocks {
  readonly isOpen: (id: string) => boolean
  readonly setOpen: (id: string, open: boolean) => void
  /** Every one of `ids` open, or closed. */
  readonly setAll: (ids: ReadonlyArray<string>, open: boolean) => void
}

/**
 * The open state of a list's blocks. `count` is how many the list shows: below
 * `OPEN_WHEN_FEWER_THAN`, a block with no choice of its own is open.
 */
export function useOpenBlocks(key: string, count: number): OpenBlocks {
  const [choices, setChoices] = useState<Choices>(() => read(key))
  const change = useCallback(
    (next: (current: Choices) => Choices) =>
      setChoices((current) => {
        const changed = next(current)
        write(key, changed)
        return changed
      }),
    [key]
  )
  const fallback = count < OPEN_WHEN_FEWER_THAN
  return {
    isOpen: (id) => choices[id] ?? fallback,
    setOpen: (id, open) =>
      change((current) => {
        const { [id]: _old, ...rest } = current
        return { ...rest, [id]: open }
      }),
    setAll: (ids, open) => change((current) => ({ ...current, ...Object.fromEntries(ids.map((id) => [id, open])) }))
  }
}

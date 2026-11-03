// Which of a book's entries are open, remembered in this browser (owner, 2026-11-01: per entry,
// per device; coordinator, 2026-11-02: per view), so each editor restores its own expansion.
import type { FieldPath } from "@rp/shared/editing.ts"
import { useState } from "react"

/** At most this many open entries are remembered per book: past it, the rest open closed. */
const LIMIT = 2000

// Keep the existing key for the large editor; the side panel has its own expansion history.
const keyOf = (refId: string, root: FieldPath, panel: boolean) =>
  `rp.lorebookOpen:${refId}:${root.join("/")}${panel ? ":panel" : ""}`

const read = (key: string): ReadonlySet<number> => {
  try {
    const stored = JSON.parse(localStorage.getItem(key) ?? "[]") as unknown
    return new Set(Array.isArray(stored) ? stored.filter((uid): uid is number => Number.isInteger(uid)) : [])
  } catch {
    return new Set()
  }
}

const write = (key: string, open: ReadonlySet<number>) => {
  try {
    if (open.size === 0) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify([...open].slice(-LIMIT)))
  } catch {
    // Not remembered (storage full or unavailable): still open here.
  }
}

/** The open entries and their setter, remembered for this book. `initial` opens one besides (just added). */
export function useOpenEntries(refId: string, root: FieldPath, initial: number | null, panel: boolean) {
  const key = keyOf(refId, root, panel)
  const [open, setOpenState] = useState<ReadonlySet<number>>(() => {
    const stored = read(key)
    return initial === null ? stored : new Set(stored).add(initial)
  })
  const setOpen = (next: ReadonlySet<number> | ((open: ReadonlySet<number>) => ReadonlySet<number>)) =>
    setOpenState((current) => {
      const value = typeof next === "function" ? next(current) : next
      write(key, value)
      return value
    })
  return [open, setOpen] as const
}

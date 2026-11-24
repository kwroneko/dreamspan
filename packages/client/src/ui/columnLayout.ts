// The desktop's columns and the space they share (owner 2026-11-01: "Columns should have a
// MINIMUM width, not a maximum one"). Each resizable column (the left sidebar, the chat's side
// panel, the portrait column) has a width the user chose and a minimum; none has a maximum.
// What they share is the window less the middle's minimum (the messages, or a page), so a
// column can be dragged until the middle reaches MIDDLE_MIN. When the window is too narrow for
// every chosen width, the columns give way toward their minimums (the portrait first, then the
// others in proportion to how far each is above its own) before the middle goes below its
// minimum; the chosen widths stay as they were, so a wider window shows them again. Below
// 1024 px the phone layout takes over. Frames side by side in the middle raise its minimum to
// what they need together (`setMiddleMin`, the workbench).
import { useSyncExternalStore } from "react"

/** The least the middle column keeps: the messages beside the columns, or a page. */
const MIDDLE_MIN = 440

export interface ColumnEntry {
  /** The width the user chose, or the column's default. */
  readonly preferred: number
  readonly min: number
  /**
   * Which columns give way first when the window is short: higher first. The portrait column
   * (1), opened for a look and fitted to its image, gives way before the sidebar and the side
   * panel (0), which keep the widths the user set for them as long as it can.
   */
  readonly yields?: number
}

/**
 * Each column's shown width, given the room for every column together (the window less the
 * middle's minimum). Fits: as chosen. Too narrow: the columns that yield first give up the
 * shortfall, each a share in proportion to how far it is above its minimum, then the next.
 * Narrower than the minimums: the minimums.
 */
export function allocate(columns: ReadonlyMap<string, ColumnEntry>, room: number): Map<string, number> {
  const widths = new Map<string, number>()
  let short = -room
  for (const [id, column] of columns) {
    const preferred = Math.max(column.min, column.preferred)
    widths.set(id, preferred)
    short += preferred
  }
  const ranks = [...new Set([...columns.values()].map((column) => column.yields ?? 0))].sort((a, b) => b - a)
  for (const rank of ranks) {
    if (short <= 0) break
    const group = [...columns].filter(([, column]) => (column.yields ?? 0) === rank)
    let slack = 0
    for (const [id, column] of group) slack += widths.get(id)! - column.min
    if (slack <= 0) continue
    const taken = Math.min(short, slack)
    for (const [id, column] of group) {
      const width = widths.get(id)!
      widths.set(id, width - (taken * (width - column.min)) / slack)
    }
    short -= taken
  }
  return widths
}

/**
 * How wide `id` may be dragged: the room less what the other columns show now, or less only
 * the minimum of one that gives way before it (dragging the sidebar narrows the portrait).
 */
export const maxWidth = (
  id: string,
  columns: ReadonlyMap<string, ColumnEntry>,
  widths: ReadonlyMap<string, number>,
  room: number
) => {
  const own = columns.get(id)
  const rank = own?.yields ?? 0
  let others = 0
  for (const [other, column] of columns)
    if (other !== id) others += (column.yields ?? 0) > rank ? column.min : (widths.get(other) ?? column.min)
  return Math.max(own?.min ?? 0, room - others)
}

// --- The columns shown now, and the window's width.

let columns: ReadonlyMap<string, ColumnEntry> = new Map()
/** What the middle's content needs, when more than MIDDLE_MIN (frames side by side). */
let middleMin = 0
let viewport = typeof window === "undefined" ? 1440 : document.documentElement.clientWidth
const listeners = new Set<() => void>()
const notify = () => {
  for (const listener of listeners) listener()
}
const onResize = () => {
  const next = document.documentElement.clientWidth
  if (next === viewport) return
  viewport = next
  notify()
}

const subscribe = (listener: () => void) => {
  if (listeners.size === 0) window.addEventListener("resize", onResize)
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) window.removeEventListener("resize", onResize)
  }
}

/** Shows a column, or changes what it asks for. */
export const setColumn = (id: string, entry: ColumnEntry) => {
  const current = columns.get(id)
  if (current?.preferred === entry.preferred && current.min === entry.min && current.yields === entry.yields) return
  columns = new Map(columns).set(id, entry)
  notify()
}

/** The least the middle's content needs (0: MIDDLE_MIN), so the columns give way to it first. */
export const setMiddleMin = (px: number) => {
  const next = Math.max(0, Math.round(px))
  if (next === middleMin) return
  middleMin = next
  notify()
}

/** How much wider the middle would get if its content needed a larger minimum. */
export const middleWidthGrowth = (minimum: number) => {
  const current = Math.max(MIDDLE_MIN, middleMin)
  if (minimum <= current) return 0
  const columnWidth = (middle: number) =>
    [...allocate(columns, viewport - middle).values()].reduce((sum, width) => sum + Math.floor(width), 0)
  return columnWidth(current) - columnWidth(minimum)
}

export const removeColumn = (id: string) => {
  if (!columns.has(id)) return
  const next = new Map(columns)
  next.delete(id)
  columns = next
  notify()
}

/**
 * The width `id` shows at and how far it may be dragged, with `entry` as it asks now (it may
 * not be in the store yet: its first render, before its effect adds it).
 */
export function useColumnWidth(id: string, entry: ColumnEntry | null) {
  const shown = useSyncExternalStore(subscribe, () => columns)
  const width = useSyncExternalStore(subscribe, () => viewport)
  const middle = useSyncExternalStore(subscribe, () => middleMin)
  const all = entry ? new Map(shown).set(id, entry) : shown
  const room = width - Math.max(MIDDLE_MIN, middle)
  const widths = allocate(all, room)
  const min = entry?.min ?? 0
  return {
    width: Math.floor(widths.get(id) ?? min),
    max: Math.floor(maxWidth(id, all, widths, room))
  }
}

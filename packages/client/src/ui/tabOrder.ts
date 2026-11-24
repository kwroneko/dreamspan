// The order of a tab strip's tools (owner, 2026-11-17, DESIGN §10.1 "Tab order"): one list the
// user arranges, the strip showing as many as fit in that order and More the rest. The stored
// order names tabs by value; tabs it doesn't name (new or plugin tabs) follow in their own order.

/** The tabs in the stored order: the ones it names in that order, then the rest as given. */
export const inOrder = <Tab extends { readonly value: string }>(
  tabs: ReadonlyArray<Tab>,
  order: ReadonlyArray<string>
): ReadonlyArray<Tab> => {
  if (order.length === 0) return tabs
  const rank = new Map(order.map((value, index) => [value, index]))
  const named = tabs.filter((tab) => rank.has(tab.value)).sort((a, b) => rank.get(a.value)! - rank.get(b.value)!)
  return [...named, ...tabs.filter((tab) => !rank.has(tab.value))]
}

/**
 * The order to store once the shown tabs are arranged as `shown`: those, with each stored tab
 * this chat doesn't offer (Summaries in a workshop, a plugin turned off) kept after the tab it
 * followed, so arranging one chat's tabs never moves another's.
 */
export const storedOrder = (previous: ReadonlyArray<string>, shown: ReadonlyArray<string>) => {
  const next = [...new Set(shown)]
  const present = new Set(next)
  // A corrupt stored order with a value twice keeps its first place only, so it can't grow.
  const seen = new Set<string>()
  previous.forEach((value, index) => {
    if (present.has(value) || seen.has(value)) return
    seen.add(value)
    const before = previous
      .slice(0, index)
      .reverse()
      .find((earlier) => next.includes(earlier))
    next.splice(before === undefined ? 0 : next.indexOf(before) + 1, 0, value)
  })
  // The setting holds at most MAX_STORED values: past that, absent tools (plugins long gone)
  // go, from the end, so the write never fails the setting's check.
  for (let at = next.length - 1; next.length > MAX_STORED && at >= 0; at--)
    if (!present.has(next[at]!)) next.splice(at, 1)
  return next.slice(0, MAX_STORED)
}

/** The most values the stored order holds (panelTabOrder's limit in chatApi.ts). */
export const MAX_STORED = 200

/** `values` with the one at `from` placed so that it ends at index `to`. */
export const moved = (values: ReadonlyArray<string>, from: number, to: number) => {
  const next = [...values]
  const [value] = next.splice(from, 1)
  next.splice(Math.max(0, Math.min(to, next.length)), 0, value!)
  return next
}

/** `values` with `value` inserted before the item that was at `before` (the end at `values.length`). */
export const placedBefore = (values: ReadonlyArray<string>, value: string, before: number) => {
  const from = values.indexOf(value)
  if (from < 0) return [...values]
  return moved(values, from, from < before ? before - 1 : before)
}

/** The tools row's gap (gap-0.5). */
export const TOOL_GAP = 2

/**
 * Which tools show, for tools of `widths` in order, More `more` wide, in `room`: how many lead
 * the order, and whether the open one (`active`) shows after them as a guest, set apart before
 * More, because it is past them. The guest's room (its width and its divider, `divider`) is
 * kept before the leading tools are counted, so showing it never changes the count it was
 * counted with: the strip can't flip between two layouts at a boundary width.
 */
export const fitTools = (
  widths: ReadonlyArray<number>,
  more: number,
  divider: number,
  room: number,
  active: number
): { readonly count: number; readonly guest: boolean } => {
  const total = widths.reduce((sum, width) => sum + width + TOOL_GAP, 0)
  if (total <= room) return { count: widths.length, guest: false }
  const lead = (reserved: number) => {
    let used = more + TOOL_GAP + reserved
    let count = 0
    for (const width of widths) {
      if (used + width + TOOL_GAP > room) break
      used += width + TOOL_GAP
      count++
    }
    return count
  }
  const count = lead(0)
  if (active < count || active < 0 || active >= widths.length) return { count, guest: false }
  return { count: Math.min(active, lead(widths[active]! + TOOL_GAP + divider + TOOL_GAP)), guest: true }
}

import type { TimelineInputV1, TimelineRowV1, TimelineTransformV1 } from "../../../../plugin-api/src/display.ts"

const boundary = (rows: ReadonlyArray<TimelineRowV1>, input: TimelineInputV1, index: number) => {
  const entry = input.entries[index]
  const depth = entry && (entry.position ?? entry.depth)
  if (depth === undefined) return rows.length
  const at = rows.findIndex((row) => row.from <= row.to && row.to >= depth)
  return at < 0 ? rows.length : at
}
export const mergeTimeline = {
  api: 1,
  id: "timeline.merges",
  order: 5,
  source: import.meta.url,
  transform: ({ rows }) =>
    rows.some((row) => row.entry?.version?.origin === "merge")
      ? rows.map((row) =>
          row.entry?.version?.origin === "merge"
            ? { ...row, estimate: 64, body: { kind: "merge", ref: row.entry.slotId } }
            : row
        )
      : rows
} satisfies TimelineTransformV1
export const historyTimeline = {
  api: 1,
  id: "timeline.history-budget",
  order: 10,
  source: import.meta.url,
  transform: (input) => {
    if (input.historyDivider < 0 || !input.hasBudget || input.assemblyError) return input.rows
    const rows = [...input.rows]
    rows.splice(boundary(rows, input, input.historyDivider), 0, {
      key: "history-boundary",
      estimate: 64,
      from: Infinity,
      to: -1,
      body: { kind: "history" }
    })
    return rows
  }
} satisfies TimelineTransformV1
export const lcmTimeline = {
  api: 1,
  id: "timeline.lcm",
  order: 20,
  source: import.meta.url,
  transform: (input) => {
    const { entries, lcm, summaries, divider, historyDivider } = input
    if ((divider < 0 || !lcm) && (!summaries || !lcm?.layer.length)) return input.rows
    const original = [...input.rows]
    if (divider >= 0 && lcm) {
      let at = boundary(original, input, divider)
      if (divider === historyDivider && original[at - 1]?.key === "history-boundary") at--
      original.splice(at, 0, {
        key: "lcm-boundary",
        estimate: 44,
        from: lcm.cursor + 1,
        to: -1,
        body: { kind: "lcm-boundary" }
      })
    }
    const layer = summaries
      ? (lcm?.layer ?? []).filter(
          (s) => s.from <= (entries.at(-1) ? (entries.at(-1)!.position ?? entries.at(-1)!.depth) : -1) + 1
        )
      : []
    const result: TimelineRowV1[] = []
    let next = 0
    const append = () => {
      const summary = layer[next++]!
      result.push({
        key: summary.id,
        estimate: 64,
        from: summary.from - 1,
        to: summary.to - 1,
        lastSlotId: summary.lastSlotId,
        body: { kind: "summary", ref: summary.id }
      })
    }
    for (const row of original) {
      while (next < layer.length && layer[next]!.from - 1 <= row.from) append()
      if (
        !row.entry ||
        !layer.some(
          (s) =>
            (row.entry!.position ?? row.entry!.depth) >= s.from - 1 && (row.entry!.position ?? row.entry!.depth) < s.to
        )
      )
        result.push(row)
    }
    while (next < layer.length) append()
    return result
  }
} satisfies TimelineTransformV1
export const threadsTimeline = {
  api: 1,
  id: "timeline.threads",
  order: 30,
  source: import.meta.url,
  transform: ({ rows, threads }) => {
    let result = rows
    for (const set of threads) {
      const at = result.findIndex((row) => row.entry?.slotId === set.slotId)
      if (at < 0) continue
      result = [
        ...result.slice(0, at + 1),
        {
          key: `threads-${set.splitId}`,
          estimate: 48,
          from: Infinity,
          to: -1,
          body: { kind: "threads", ref: set.splitId }
        },
        ...result.slice(at + 1)
      ]
    }
    return result
  }
} satisfies TimelineTransformV1

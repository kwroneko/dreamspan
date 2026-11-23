// The timeline's history lines (ARCHITECTURE §12 "Context membership"): an imported ST chat
// hidden up to its summary, with nothing cut for size, says the messages above are hidden and
// names the summary sent in their place, with no size claim and no context-size action (owner,
// 2026-11-23); a size cut below a hidden run gets each line at its own place. Synthetic views.
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { historyLines } from "../src/features/chat/historyLines.ts"
import { registerPresentation } from "../src/features/chat/registerPresentation.tsx"
import { messageRows, timelineTransforms } from "../src/features/chat/timelineContributions.tsx"
import type { ChatView } from "../src/features/chat/session.ts"

vi.hoisted(() => {
  vi.stubGlobal("location", { protocol: "http:", host: "127.0.0.1" })
})

let disposers: Array<() => void>
beforeEach(() => {
  disposers = registerPresentation()
})
afterEach(() => {
  for (const dispose of disposers.reverse()) dispose()
})

const budget = {
  maximum: 1_000_000,
  target: 800_000,
  responseReserve: 4096,
  nonHistoryTokens: 27_880,
  countedInput: 60_085,
  presetName: "Default (built-in)",
  builtinPreset: true,
  origins: {
    context: "upstream" as const,
    reserve: "default" as const,
    target: "default" as const,
    model: { connectionId: "connection-1", modelId: "model-1" }
  }
}

/** A window of the 900-message chat from `from` to its end, the first `hidden` hidden. */
const view = (
  from: number,
  hidden: number,
  start: { depth: number; cutThrough?: number | null; hiddenBefore?: number | null },
  summaryNotes?: ReadonlyArray<string>
) =>
  ({
    entries: Array.from({ length: 900 - from }, (_, k) => ({
      slotId: `slot-${from + k}`,
      depth: from + k,
      contextExcluded: from + k < hidden
    })),
    older: from > 0 ? `slot-${from - 1}` : null,
    newer: null,
    history: {
      budget,
      historyStart: { slotId: `slot-${start.depth}`, ...start },
      summarizedThrough: null,
      ...(summaryNotes ? { summaryNotes } : {})
    }
  }) as unknown as ChatView

const rendered = (v: ChatView) => {
  const lines = historyLines(v, null)
  const rows = timelineTransforms.list().reduce(
    (rows, entry) =>
      entry.transform(rows, {
        view: v,
        lcm: null,
        summaries: false,
        divider: -1,
        historyDivider: lines.size,
        hiddenDivider: lines.hidden
      }),
    messageRows(v.entries)
  )
  const html = (key: string) => {
    const row = rows.find((r) => r.key === key)
    return row ? renderToStaticMarkup(createElement(() => row.render({} as never))) : null
  }
  return { rows, lines, hidden: html("hidden-boundary"), size: html("history-boundary") }
}

it("an imported chat hidden up to #831, nothing cut for size: the hidden line, naming the summary", () => {
  const v = view(800, 831, { depth: 831, cutThrough: null, hiddenBefore: 831 }, ["Summary (from ST)"])
  const { rows, lines, hidden, size } = rendered(v)
  expect(lines).toEqual({ size: -1, hidden: 31 })
  expect(hidden).toContain("Messages above this are hidden. Summary (from ST) is sent in their place.")
  expect(hidden).not.toContain("context")
  expect(hidden).not.toContain("<button")
  expect(size).toBeNull()
  // Right below #831, the last hidden message.
  const at = rows.findIndex((r) => r.key === "hidden-boundary")
  expect(rows[at - 1]!.entry?.slotId).toBe("slot-830")
  expect(rows[at + 1]!.entry?.slotId).toBe("slot-831")
})

it("without a summary sent, it says only that they're hidden", () => {
  const { hidden, size } = rendered(view(800, 831, { depth: 831, cutThrough: null, hiddenBefore: 831 }))
  expect(hidden).toContain("Messages above this are hidden, so they aren’t sent.")
  expect(size).toBeNull()
})

it("a size cut below the hidden run: each line at its own place", () => {
  // Hidden to #831, #832 to #850 cut for size, sent from #851.
  const v = view(800, 831, { depth: 850, cutThrough: 849, hiddenBefore: 831 }, ["Summary (from ST)"])
  const { rows, hidden, size } = rendered(v)
  expect(size).toContain("Messages above this aren’t sent to the model: the model’s context budget allows")
  expect(size).toContain("Change the context size")
  expect(hidden).toContain("Summary (from ST) is sent in their place.")
  const hiddenAt = rows.findIndex((r) => r.key === "hidden-boundary")
  const sizeAt = rows.findIndex((r) => r.key === "history-boundary")
  expect(rows[hiddenAt + 1]!.entry?.slotId).toBe("slot-831")
  expect(rows[sizeAt - 1]!.entry?.slotId).toBe("slot-849")
  expect(rows[sizeAt + 1]!.entry?.slotId).toBe("slot-850")
})

it("a size cut with hidden messages between it and the start puts the size line under the cut", () => {
  // Sent from #860; #840 to #849 cut; #850 to #859 hidden; the run above #840 unknown.
  const v = {
    ...view(800, 0, { depth: 860, cutThrough: 849, hiddenBefore: null }),
    entries: Array.from({ length: 100 }, (_, k) => ({
      slotId: `slot-${800 + k}`,
      depth: 800 + k,
      contextExcluded: 800 + k >= 850 && 800 + k < 860
    }))
  } as unknown as ChatView
  const { rows, hidden } = rendered(v)
  expect(hidden).toBeNull()
  const sizeAt = rows.findIndex((r) => r.key === "history-boundary")
  expect(rows[sizeAt + 1]!.entry?.slotId).toBe("slot-850")
})

it("a context read without the gap keeps the size line at the start", () => {
  const { lines } = rendered(view(800, 0, { depth: 820 }))
  expect(lines).toEqual({ size: 20, hidden: -1 })
})

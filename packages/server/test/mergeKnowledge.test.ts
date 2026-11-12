import { describe, expect, it } from "vitest"
import { viewedJoin } from "../src/assembler/mergeKnowledge.ts"
import type { MergeRow } from "../src/assembler/types.ts"

const row = (ordinal: number, content: string, knowers = ["wren", "mira"]): MergeRow => ({
  ordinal,
  kind: "message",
  name: "Mira",
  side: "assistant",
  speaker: "mira",
  content,
  included: "verbatim",
  knowers
})
const knows = (ids: ReadonlyArray<string>) => ids.includes("wren")

describe("a merged join's per-viewer text", () => {
  it("omitted source rows cannot change the visible result or its counts", () => {
    const view = (count: number) => {
      const rows = [
        row(0, "tide turns."),
        ...Array.from({ length: count }, (_, i) => ({ ...row(i + 1, "", ["mira"]), included: "left_out" as const }))
      ]
      return viewedJoin(
        `[${count} earlier messages of “Docks” not included.]\n\nMira: tide turns.`,
        "Docks",
        rows,
        knows
      ).content
    }
    expect(view(1)).toBe("Mira: tide turns.")
    expect(view(9)).toBe(view(1))
  })
  it("edits of a visible row survive even when a hidden row was also edited", () => {
    const rows = [row(0, "tide rises."), row(1, "private code.", ["mira"])]
    const projected = viewedJoin("Mira: tide ebbs.\n\nMira: private password.", "Docks", rows, knows)
    expect(projected.content).toBe("Mira: tide ebbs.")
    expect(projected.rows.map((r) => r.content)).toEqual(["tide ebbs."])
  })
  it("one character can know successive rows through different card identities", () => {
    const projected = viewedJoin(
      "Mira: first.\n\nMira: second.",
      "Docks",
      [row(0, "first.", ["old-wren"]), row(1, "second.", ["new-wren"])],
      (ids) => ["old-wren", "new-wren"].some((id) => ids.includes(id))
    )
    expect(projected.partial).toBe(false)
    expect(projected.rows).toHaveLength(2)
  })
})

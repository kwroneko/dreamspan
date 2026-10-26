// Incremental line comparisons shared by the editor gutter and its state tests.
import { Chunk } from "@codemirror/merge"
import { StateEffect, StateField, type Text } from "@codemirror/state"
import { gutter, GutterMarker } from "@codemirror/view"

export const comparisonBase = StateEffect.define<string>()
const diffConfig = { scanLimit: 2000, timeout: 30 }

export const lineChanges = StateField.define<{ base: Text; chunks: readonly Chunk[] }>({
  create: (state) => ({ base: state.doc, chunks: [] }),
  update(previous, transaction) {
    const base = transaction.effects.find((effect) => effect.is(comparisonBase))
    if (base) {
      const text = transaction.state.toText(base.value)
      return { base: text, chunks: Chunk.build(text, transaction.newDoc, diffConfig) }
    }
    return transaction.docChanged
      ? {
          base: previous.base,
          chunks: Chunk.updateB(previous.chunks, previous.base, transaction.newDoc, transaction.changes, diffConfig)
        }
      : previous
  }
})

type LineKind = "added" | "modified" | "deleted" | "unchanged"
export function lineKind(base: Text, doc: Text, chunks: readonly Chunk[], position: number): LineKind {
  const line = doc.lineAt(position)
  for (const chunk of chunks) {
    for (const change of chunk.changes) {
      const fromA = chunk.fromA + change.fromA
      const toA = chunk.fromA + change.toA
      const fromB = chunk.fromB + change.fromB
      const toB = chunk.fromB + change.toB
      if (fromB === toB) {
        if (doc.lineAt(Math.min(fromB, doc.length)).from === position) {
          return base.sliceString(fromA, toA).includes("\n") ? "deleted" : "modified"
        }
        continue
      }
      if (toB <= line.from || fromB > line.to) continue
      const oldLines = fromA === toA ? 0 : base.lineAt(toA - 1).number - base.lineAt(fromA).number + 1
      const offset = line.number - doc.lineAt(fromB).number
      // A whole inserted line can precede, follow, or sit beside a modified line.
      if (fromB <= line.from && toB >= line.to && offset >= oldLines) return "added"
      return "modified"
    }
  }
  return "unchanged"
}

class ChangeMarker extends GutterMarker {
  readonly kind: LineKind
  constructor(kind: LineKind) {
    super()
    this.kind = kind
  }
  override eq(other: ChangeMarker) {
    return this.kind === other.kind
  }
  override toDOM() {
    const marker = document.createElement("span")
    marker.className = `rp-line-marker rp-line-${this.kind}`
    marker.title =
      this.kind === "deleted" ? "Lines deleted here" : `${this.kind[0]!.toUpperCase()}${this.kind.slice(1)} line`
    marker.setAttribute("aria-label", marker.title)
    marker.textContent =
      this.kind === "added" ? "+" : this.kind === "modified" ? "│" : this.kind === "deleted" ? "−" : "·"
    return marker
  }
}
const markers = {
  added: new ChangeMarker("added"),
  modified: new ChangeMarker("modified"),
  deleted: new ChangeMarker("deleted"),
  unchanged: new ChangeMarker("unchanged")
}

export const changeGutter = gutter({
  class: "rp-change-gutter",
  lineMarker(view, line) {
    const { base, chunks } = view.state.field(lineChanges)
    return markers[lineKind(base, view.state.doc, chunks, line.from)]
  },
  lineMarkerChange: (update) =>
    update.docChanged || update.startState.field(lineChanges) !== update.state.field(lineChanges),
  initialSpacer: () => markers.unchanged
})

// A join's readable text, shared by assembly and the history tools. Frozen rows keep the
// source knowledge boundary; edits wholly inside a row follow that row's audience.
import { editedSpans } from "@dreamspan/shared/merge.ts"
import { leftOutNote, mergedRowText } from "./merges.ts"
import type { MergeRow } from "./types.ts"

export const viewedJoin = (
  content: string,
  title: string,
  rows: ReadonlyArray<MergeRow>,
  knows: (knowers: ReadonlyArray<string>) => boolean
) => {
  const sent = rows.filter((r) => r.included === "verbatim")
  const kept = sent.filter((r) => knows(r.knowers))
  const left = rows.filter((r) => r.included === "left_out")
  const visibleLeft = left.filter((r) => knows(r.knowers)).length
  const partial = kept.length !== sent.length || visibleLeft !== left.length
  const note = left.length ? leftOutNote(left.length, title) + "\n\n" : ""
  let base = note
  const spans = sent.map((row, i) => {
    if (i) base += "\n\n"
    const from = base.length
    base += mergedRowText(row)
    return { from, to: base.length }
  })
  const edits = editedSpans(base, content, spans)
  const edited = sent.map((row, i) => {
    const text = edits.texts[i]!
    // The name is framing, not message content. Preserve edited message bodies for own-line layout.
    const body =
      row.kind === "message" && text.startsWith(`${row.name}: `) ? text.slice(row.name.length + 2) : row.content
    return { ...row, content: body }
  })
  return {
    rows: edited.filter((r) => knows(r.knowers)),
    partial,
    ambiguous: edits.ambiguous,
    content: !partial
      ? content
      : [
          ...(visibleLeft ? [leftOutNote(visibleLeft, title)] : []),
          ...sent.flatMap((row, i) => (knows(row.knowers) ? [edits.texts[i]!] : []))
        ].join("\n\n")
  }
}

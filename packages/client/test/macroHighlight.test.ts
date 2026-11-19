import { EditorState } from "@codemirror/state"
import { expect, it } from "vitest"
import { highlightMacros } from "@dreamspan/shared/macros/highlight.ts"
import { macroRegistry } from "../src/macros.ts"
import { macroTokens } from "../src/ui/macroHighlight.ts"

it("incremental highlighting equals a fresh parse across edits, malformed openers and multiline arguments", () => {
  let state = EditorState.create({
    doc: "{{char}}\n{{if::1}}plain {{user}}{{/if}}\n{{unknown::a\nb}}\n{{unfinished\n{{char}}",
    extensions: [macroTokens]
  })
  for (const change of [
    { from: state.doc.length, insert: "}}" },
    { from: 32, insert: "{{trim}}" },
    { from: 2, to: 6, insert: "user" },
    { from: 10, insert: "{{// " },
    { from: 0, to: 2, insert: "{" },
    { from: 0, insert: "{" }
  ]) {
    state = state.update({ changes: change }).state
    expect(state.field(macroTokens).tokens).toEqual(highlightMacros(state.doc.toString(), macroRegistry))
  }
})

it("reuses the parsed prefix of a 5,000-line prompt when typing at its end", () => {
  const doc = Array.from({ length: 5000 }, (_, n) => `Line ${n} {{char}} {{getvar::x}}`).join("\n")
  const state = EditorState.create({ doc, extensions: [macroTokens] })
  const next = state.update({ changes: { from: doc.length, insert: " more {{user}}" } }).state
  expect(next.field(macroTokens).nodes[0]).toBe(state.field(macroTokens).nodes[0])
  expect(next.field(macroTokens).tokens).toEqual(highlightMacros(next.doc.toString(), macroRegistry))
})

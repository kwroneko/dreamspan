// "Add a script" on a card with no scripts (owner, 2026-11-01: "the add button for regex
// currently does nothing"): a card's document has no `regex` until it has a script, and a draft
// naming an element of a list that isn't there was refused, so nothing was added.
import { applyDrafts, newCardDoc, valueField } from "@rp/shared/editing.ts"
import type { RegexScript } from "@rp/shared/docs/regexScript.ts"
import { expect, it } from "vitest"
import { addScriptChange } from "../src/features/editor/regexAdd.ts"

const script = (id: string): RegexScript => ({
  id,
  name: "New script",
  find_regex: "",
  replace_string: "",
  trim_strings: [],
  placement: [2],
  disabled: true,
  markdown_only: false,
  prompt_only: false,
  run_on_edit: true,
  substitute_regex: "none",
  min_depth: null,
  max_depth: null
})

const draft = (change: ReturnType<typeof addScriptChange>) => ({
  field: valueField(change.path),
  content: JSON.stringify(change.value)
})

it("adds the first script to a card that has none as the list itself", () => {
  const card = newCardDoc("Mio")
  expect(card.regex).toBeUndefined()
  const { doc, problems } = applyDrafts("card", card, [draft(addScriptChange(undefined, script("s1")))])
  expect(problems).toEqual([])
  expect(doc.regex).toEqual([script("s1")])
})

it("was refused as an element of a list that isn't there (the bug)", () => {
  const { doc, problems } = applyDrafts("card", newCardDoc("Mio"), [
    { field: valueField(["regex", "id=s1"]), content: JSON.stringify(script("s1")) }
  ])
  expect(doc.regex).toBeUndefined()
  expect(problems).toHaveLength(1)
})

it("adds a later script as an element by its id, keeping the others", () => {
  const card = { ...newCardDoc("Mio"), regex: [script("s1")] }
  const { doc, problems } = applyDrafts("card", card, [draft(addScriptChange(card.regex, script("s2")))])
  expect(problems).toEqual([])
  expect(doc.regex).toEqual([script("s1"), script("s2")])
})

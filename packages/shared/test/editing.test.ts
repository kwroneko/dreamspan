import { describe, expect, it } from "vitest"
import {
  applyDrafts,
  droppedDrafts,
  canonicalJson,
  getAt,
  keepsRegexApproval,
  newCardDoc,
  parseField,
  textField,
  validateDoc,
  valueField,
  withoutGrantedAgentEdits,
  withValues
} from "../src/editing.ts"

const prompts = {
  schema_version: 1,
  prompts: [
    { identifier: "main", content: "Be vivid." },
    { identifier: "jailbreak", content: "Stay in character." }
  ],
  order: [{ identifier: "main", enabled: true }]
}

describe("draft fields", () => {
  it("omits an optional field explicitly, without confusing omission with null", () => {
    const field = valueField(["interval"])
    const applied = applyDrafts("note", { interval: 2, title: "Note" }, [{ field, content: "undefined" }])
    expect(applied).toEqual({ doc: { title: "Note" }, problems: [] })
    expect(applyDrafts("note", { interval: 2 }, [{ field, content: "null" }]).doc).toEqual({ interval: null })
  })

  it("names texts and values by path, in one spelling only", () => {
    expect(parseField(textField(["prompts", "identifier=main", "content"]))).toEqual({
      kind: "text",
      path: ["prompts", "identifier=main", "content"]
    })
    expect(parseField(valueField(["alternate_greetings", 2]))).toEqual({
      kind: "value",
      path: ["alternate_greetings", 2]
    })
    for (const field of ['[ "description"]', "description", "[]", "=[]", '["a",-1]', '["a",1.5]', '[""]', "[{}]"]) {
      expect(parseField(field), field).toBeNull()
    }
  })

  it("refuses keys that could reach a prototype", () => {
    for (const key of ["__proto__", "constructor", "prototype"]) {
      expect(parseField(textField(["extensions", key]))).toBeNull()
    }
    const { problems } = applyDrafts("card", { extensions: {} }, [
      { field: valueField(["extensions"]), content: '{"a":{"__proto__":{"polluted":true}}}' }
    ])
    expect(problems.map((p) => p.message)).toEqual(["This value has a key that isn't allowed."])
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it("finds elements by identity, so a reorder doesn't move a draft", () => {
    expect(getAt(prompts, ["prompts", "identifier=jailbreak", "content"])).toBe("Stay in character.")
    const reordered = { ...prompts, prompts: [...prompts.prompts].reverse() }
    const { doc } = applyDrafts("preset", reordered, [
      { field: textField(["prompts", "identifier=main", "content"]), content: "Be terse." }
    ])
    expect(getAt(doc, ["prompts", "identifier=main", "content"])).toBe("Be terse.")
    expect(getAt(reordered, ["prompts", "identifier=main", "content"])).toBe("Be vivid.")
  })

  it("adds an element before the texts in it, and removes one with null", () => {
    const { doc, problems } = applyDrafts("preset", prompts, [
      { field: textField(["prompts", "identifier=summary", "content"]), content: "{{summary}}" },
      { field: valueField(["prompts", "identifier=summary"]), content: '{"identifier":"summary","content":""}' },
      { field: valueField(["prompts", "identifier=jailbreak"]), content: "null" }
    ])
    expect(problems).toEqual([])
    expect(doc.prompts).toEqual([
      { identifier: "main", content: "Be vivid." },
      { identifier: "summary", content: "{{summary}}" }
    ])
  })

  it("reports what can't be applied, and never touches protected fields", () => {
    const { problems } = applyDrafts("preset", prompts, [
      { field: textField(["prompts", "identifier=gone", "content"]), content: "x" },
      { field: valueField(["prompts", "identifier=x"]), content: '{"identifier":"y"}' },
      { field: textField(["order"]), content: "x" },
      { field: valueField(["regex_approved"]), content: "true" },
      { field: valueField(["samplers"]), content: "{not json" }
    ])
    expect(problems.map((p) => p.message)).toEqual([
      "This changes through its own action, not an edit.",
      "This value isn't valid.",
      "This field can't be changed: the element doesn't have the id its path names.",
      "This field isn't text.",
      "This field can't be changed: the document has no place for it."
    ])
  })
})

describe("documents", () => {
  it("validates against the kind's schema, dropping keys it doesn't know", () => {
    const card = { ...newCardDoc("Wren"), planted: true }
    const valid = validateDoc("card", card)
    expect(valid.ok && "planted" in valid.doc).toBe(false)
    const invalid = validateDoc("card", { ...card, description: 3 })
    expect(invalid.ok).toBe(false)
    expect(!invalid.ok && invalid.problems[0]).toContain("description")
    expect(validateDoc("lorebook", {}).ok).toBe(false)
  })

  it("keeps a regex approval only for the scripts it was given for", () => {
    const scripts = [{ id: "a", find_regex: "x", replace_string: "y" }]
    const ours = { regex_approved: true, regex: scripts }
    expect(keepsRegexApproval(ours, { regex: [{ replace_string: "y", find_regex: "x", id: "a" }] })).toBe(true)
    expect(keepsRegexApproval(ours, { regex: [...scripts, { id: "b", find_regex: "(a+)+$" }] })).toBe(false)
    expect(keepsRegexApproval({ ...ours, regex_approved: false }, ours)).toBe(false)
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe('{"a":[{"c":2,"d":1}],"b":1}')
  })
})

describe("what the drafts can't do", () => {
  it("names elements of a list with ids by id, never by place", () => {
    const card = { modules: [{ id: "x", content: "same" }] }
    const { problems } = applyDrafts("card", card, [{ field: textField(["modules", 0, "content"]), content: "for x" }])
    expect(problems.map((p) => p.message)).toEqual([
      "This names a list's element by its place; elements with ids are named by their id."
    ])
    // A list without ids is named by place.
    const greetings = applyDrafts("card", { alternate_greetings: ["Hi."] }, [
      { field: textField(["alternate_greetings", 0]), content: "Hello." }
    ])
    expect(greetings.doc.alternate_greetings).toEqual(["Hello."])
  })

  it("tells a draft in something gone from one that doesn't fit", () => {
    const { problems } = applyDrafts("preset", prompts, [
      { field: textField(["prompts", "identifier=gone", "content"]), content: "x" },
      { field: textField(["order", "identifier=main", "enabled", "deeper"]), content: "x" }
    ])
    expect(problems.map((p) => p.orphan)).toEqual([true, false])
  })

  it("finds drafts the schema would drop", () => {
    const applied = { a: "kept", unknown: "My irreplaceable text" }
    const drafts = [
      { field: textField(["a"]), content: "kept" },
      { field: textField(["unknown"]), content: "My irreplaceable text" }
    ]
    expect(droppedDrafts(applied, { a: "kept" }, drafts).map((d) => d.field)).toEqual([textField(["unknown"])])
  })

  it("removes a key for a side that deleted it, rather than setting it null", () => {
    const doc = { modules: [{ id: "m", placement: { mode: "section" } }] }
    expect(withValues(doc, [{ path: ["modules", "id=m", "placement"], value: undefined }])).toEqual({
      modules: [{ id: "m" }]
    })
  })

  it("never grants the agent a permission the head doesn't give", () => {
    expect(withoutGrantedAgentEdits("note", { agent_editable: false }, { agent_editable: true }).agent_editable).toBe(
      false
    )
    expect(withoutGrantedAgentEdits("note", { agent_editable: true }, { agent_editable: true }).agent_editable).toBe(
      true
    )
    const ours = { modules: [{ id: "a", agent_editable: true }] }
    const next = {
      modules: [
        { id: "a", agent_editable: true },
        { id: "b", agent_editable: true }
      ]
    }
    expect(withoutGrantedAgentEdits("card", ours, next).modules).toEqual([
      { id: "a", agent_editable: true },
      { id: "b", agent_editable: false }
    ])
  })
})

import { describe, expect, it } from "vitest"
import type { Doc } from "@rp/shared/library.ts"
import { newLorebookEntry } from "@rp/shared/docs/lorebook.ts"
import { promptPreset } from "@rp/shared/docs/preset.ts"
import { builtinPreset } from "../src/db/assemblySources.ts"
import { documentDiff, safeAgentDocument } from "../src/db/agentDocuments.ts"

const preset = () => structuredClone(promptPreset(builtinPreset)) as unknown as Record<string, unknown>
const book = (entry: object, extensions = {}) =>
  ({ extensions, entries: [{ ...newLorebookEntry(1), ...entry }] }) as unknown as Doc

describe("workshop executable document policy", () => {
  it.each([
    { keys: ["/lamp/i"], use_regex: false },
    { secondary_keys: ["/lamp/i"], use_regex: false },
    { keys: ["{{getvar::pattern}}"], use_regex: false },
    { automation_id: "existing-action" },
    { extensions: { "plugin:script": "run()" } },
    { unknown_fields: { script: "run()" } }
  ])("cannot enable or edit a disabled executable entry: %j", (fields) => {
    const before = book({ ...fields, enabled: false })
    const next = book({ ...fields, enabled: true })
    expect((safeAgentDocument("lorebook", before, next).entries as { enabled: boolean }[])[0]!.enabled).toBe(false)
  })

  it("cannot enable an entry under existing opaque book extensions", () => {
    const extensions = { "plugin:script": "run()" }
    const before = book({ enabled: false }, extensions)
    const next = book({ enabled: true }, extensions)
    expect((safeAgentDocument("lorebook", before, next).entries as { enabled: boolean }[])[0]!.enabled).toBe(false)
  })

  it("never takes HTML approvals from an old revision, and keeps only current unchanged approvals", () => {
    const before = preset()
    const next = { ...before, html_scripts_approved: true, html_network_approved: true }
    const safe = safeAgentDocument("preset", before, next)
    expect(safe.html_scripts_approved === true).toBe(false)
    expect(safe.html_network_approved === true).toBe(false)
    const approved = { ...next }
    expect(safeAgentDocument("preset", approved, before).html_scripts_approved).toBe(true)
    expect(safeAgentDocument("preset", approved, before).html_network_approved).toBe(true)
  })

  it.each(["utility_prompts", "prefill", "prompts"])("new %s text invalidates existing panel approvals", (field) => {
    const before: Record<string, unknown> = { ...preset(), html_scripts_approved: true, html_network_approved: true }
    const next = structuredClone(before)
    if (field === "prompts") (next.prompts as { content: string }[])[0]!.content = "New instructions."
    else
      (next[field] as Record<string, unknown>)[field === "prefill" ? "assistant" : "send_if_empty"] =
        "<script>newCode()</script>"
    const safe = safeAgentDocument("preset", before, next)
    expect(safe.html_scripts_approved).toBe(false)
    expect(safe.html_network_approved).toBe(false)
  })

  it("does not enable prompts with existing opaque fields", () => {
    const before = preset()
    const prompt = (before.prompts as { identifier: string; unsupported?: object }[])[0]!
    prompt.unsupported = { script: "run()" }
    before.order = [{ identifier: prompt.identifier, enabled: false }]
    const next = { ...before, order: [{ identifier: prompt.identifier, enabled: true }] }
    expect((safeAgentDocument("preset", before, next).order as { enabled: boolean }[])[0]!.enabled).toBe(false)
  })

  it("lists individual prompt, entry and nested setting changes, including order, without unchanged filler", () => {
    const before = {
      prompts: [
        { identifier: "one", content: "unchanged filler" },
        { identifier: "two", content: "Before" }
      ],
      entries: [
        { uid: 1, content: "Old entry" },
        { uid: 2, content: "Remove" }
      ],
      utility_prompts: { send_if_empty: "Before", new_chat_prompt: "unchanged filler" },
      order: [
        { identifier: "one", enabled: true },
        { identifier: "two", enabled: true }
      ]
    }
    const after = {
      prompts: [before.prompts[0], { identifier: "two", content: "After" }, { identifier: "three", content: "New" }],
      entries: [{ uid: 1, content: "New entry" }],
      utility_prompts: { ...before.utility_prompts, send_if_empty: "After" },
      order: [
        { identifier: "two", enabled: false },
        { identifier: "one", enabled: true }
      ]
    }
    const diff = documentDiff(before, after)
    expect(diff.map((d) => d.field)).toEqual([
      'prompts["two"].content',
      'prompts["three"]',
      "prompts: order",
      "entries[1].content",
      "entries[2]",
      "entries: order",
      "utility_prompts.send_if_empty",
      'order["two"].enabled',
      "order: order"
    ])
    expect(JSON.stringify(diff)).not.toContain("unchanged filler")
    expect(diff.find((d) => d.field === 'prompts["two"].content')).toMatchObject({ before: "Before", after: "After" })
  })
})

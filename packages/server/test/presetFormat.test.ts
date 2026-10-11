import { PresetDoc } from "@rp/shared/docs/preset.ts"
import { Schema } from "effect"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { importStPreset, type PresetImport } from "../src/formats/preset.ts"

const fixture = (name: string) => readFileSync(new URL(`fixtures/presets/${name}.json`, import.meta.url), "utf8")

/** Imports and checks the document against the schema. */
const load = (input: string | Uint8Array | object) => {
  const result = importStPreset(
    typeof input === "object" && !(input instanceof Uint8Array) ? JSON.stringify(input) : input
  )
  expect(result.document).not.toBeNull()
  return { doc: Schema.decodeUnknownSync(PresetDoc)(result.document), report: result.report }
}
const codes = (result: Pick<PresetImport, "report">, level?: string) =>
  result.report.issues.filter((i) => level === undefined || i.level === level).map((i) => i.code)
const issue = (result: Pick<PresetImport, "report">, code: string) => result.report.issues.find((i) => i.code === code)
const prompt = (doc: PresetDoc, identifier: string) => doc.prompts.find((p) => p.identifier === identifier)

/** A minimal preset with ST's built-in prompts implied. */
const preset = (fields: object) => ({ prompt_order: [{ character_id: 100001, order: [] }], ...fields })

describe("importing an ST chat-completion preset", () => {
  it("reads a preset shaped like ST's default, using only the global prompt order", () => {
    const result = load(fixture("default"))
    const { doc } = result
    expect(result.report.format).toBe("st-chat-completion-preset")
    expect(doc.order.map((e) => e.identifier)).toEqual([
      "main",
      "worldInfoBefore",
      "personaDescription",
      "charDescription",
      "charPersonality",
      "scenario",
      "enhanceDefinitions",
      "nsfw",
      "worldInfoAfter",
      "dialogueExamples",
      "chatHistory",
      "jailbreak"
    ])
    expect(doc.order.find((e) => e.identifier === "enhanceDefinitions")?.enabled).toBe(false)
    expect(issue(result, "preset.prompt_orders_dropped")?.message).toContain("100000")
    expect(prompt(doc, "main")).toMatchObject({ content: "You narrate a story starring {{char}} and {{user}}." })
    expect(prompt(doc, "chatHistory")).toMatchObject({ marker: true, system_prompt: true, role: "system" })
    expect(doc.utility_prompts.impersonation_prompt).toBe("[Reply as {{user}} this time.]")
    // Fields left at ST's defaults, or with no effect on what's sent, raise no warnings.
    expect(codes(result, "warning")).toEqual([])
    expect(doc.unsupported).toEqual({
      stream_openai: true,
      bias_preset_selected: "Default (none)",
      media_inlining: true
    })
    expect(issue(result, "preset.defaults_applied")?.message).toContain("reasoning_effort")
  })

  it("ignores connection and model data, credentials included, and says so", () => {
    const result = load(fixture("full"))
    const stored = JSON.stringify(result.doc)
    for (const secret of ["example-proxy-password", "secret-header-value", "192.0.2.10", "example-local-model"])
      expect(stored).not.toContain(secret)
    const message = issue(result, "preset.connection_ignored")
    expect(message?.level).toBe("info")
    for (const key of ["chat_completion_source", "custom_model", "custom_url", "reverse_proxy", "proxy_password"])
      expect(message?.message).toContain(key)
  })

  it("keeps every supported semantic", () => {
    const result = load(fixture("full"))
    const { doc } = result
    expect(doc.samplers).toEqual({
      temperature: 0.85,
      frequency_penalty: 0.1,
      presence_penalty: 0.2,
      top_p: 0.95,
      top_k: 40,
      top_a: 0.1,
      min_p: 0.05,
      repetition_penalty: 1.1,
      openai_max_context: 32000,
      openai_max_tokens: 800,
      max_context_unlocked: true,
      seed: 1234,
      n: 2,
      reasoning_effort: "high",
      verbosity: "low"
    })
    expect(doc.utility_prompts).toMatchObject({ wi_format: "<lore>\n{0}\n</lore>", send_if_empty: "[{{user}} waits.]" })
    expect(doc.names_behavior).toBe("content")
    expect(doc.postprocess).toBe("strict")
    expect(doc.squash).toBe(true)
    expect(doc.use_sysprompt).toBe(true)
    expect(doc.prefill).toEqual({
      assistant: "<thinking>",
      impersonation: "{{user}}:",
      continue: true,
      continue_postfix: "\n"
    })

    expect(prompt(doc, "main")?.forbid_overrides).toBe(true)
    expect(prompt(doc, "charDescription")?.role).toBe("user")
    expect(prompt(doc, "3f1c2a7e-0001-4000-8000-000000000001")).toMatchObject({
      system_prompt: false,
      role: "user",
      injection_position: "relative"
    })
    expect(prompt(doc, "3f1c2a7e-0001-4000-8000-000000000002")).toMatchObject({
      injection_position: "absolute",
      injection_depth: 0,
      injection_order: 50,
      injection_trigger: ["normal", "swipe", "regenerate"]
    })
    expect(prompt(doc, "3f1c2a7e-0001-4000-8000-000000000003")).toMatchObject({
      role: "assistant",
      injection_position: "absolute",
      injection_depth: 2,
      injection_order: 200,
      // ST's own unused field is kept quietly; an unknown one is kept and reported.
      unsupported: { enabled: true, example_prompt_extra: "kept" }
    })
    expect(codes(result).filter((c) => c === "preset.unknown_field")).toHaveLength(2)
    expect(doc.order.slice(12).map((e) => e.enabled)).toEqual([true, true, false, true])
    expect(issue(result, "preset.prompt_orders_dropped")?.message).toContain("7")

    expect(doc.regex.map((s) => [s.prompt_only, s.markdown_only])).toEqual([
      [true, false],
      [false, true],
      [false, false]
    ])
    expect(doc.regex[0]).toEqual({
      id: "8a2d6c1e-0002-4000-8000-000000000001",
      name: "Strip thinking from the prompt",
      find_regex: "/<thinking>[\\s\\S]*?<\\/thinking>/g",
      replace_string: "",
      trim_strings: [],
      placement: [2],
      disabled: false,
      markdown_only: false,
      prompt_only: true,
      run_on_edit: true,
      substitute_regex: "none",
      min_depth: null,
      max_depth: 3
    })
    expect(doc.regex[1]).toMatchObject({ substitute_regex: "escaped", disabled: true, min_depth: 1, max_depth: null })
    // ST ignores a maximum below 0, but takes a minimum of -1.
    expect(doc.regex[2]).toMatchObject({ substitute_regex: "raw", min_depth: -1, max_depth: null })
    expect(doc.extensions).toEqual({ example_extension: { setting: true } })

    expect(doc.unsupported).toEqual({
      stream_openai: true,
      function_calling: true,
      media_inlining: true,
      bias_preset_selected: "Default (none)",
      example_unknown_field: { kept: [1, 2, 3] }
    })
    expect(issue(result, "preset.unsupported_field")).toMatchObject({ level: "warning", path: ["function_calling"] })
  })

  it("applies ST's migrations to a preset from before the prompt manager", () => {
    const result = load(fixture("legacy"))
    const { doc } = result
    expect(prompt(doc, "main")?.content).toBe("Write the next reply in this story between {{char}} and {{user}}.")
    expect(prompt(doc, "jailbreak")?.content).toBe("[Stay in character.]")
    expect(doc.order.map((e) => e.identifier)).toContain("personaDescription")
    expect(doc.names_behavior).toBe("completion")
    expect(doc.postprocess).toBe("merge")
    expect(doc.use_sysprompt).toBe(true)
    expect(doc.samplers).toMatchObject({ temperature: 0.9, frequency_penalty: 0.7, top_k: 0 })
    // ST migrates only a non-empty legacy prompt, and leaves an empty one in the file.
    expect(doc.unsupported).toMatchObject({ nsfw_prompt: "", media_inlining: false, nsfw_toggle: true })
    for (const consumed of ["main_prompt", "jailbreak_prompt", "names_in_completion", "claude_use_sysprompt"])
      expect(doc.unsupported).not.toHaveProperty(consumed)
    expect(issue(result, "preset.unsupported_field")?.path).toEqual(["media_inlining"])
    expect(issue(result, "preset.defaults_applied")?.message).toContain("prompt_order")
  })

  it("migrates an enabled image_inlining the way ST does, which drops it", () => {
    // ST's migration table deletes the key at its first entry, so the `true` entry never runs.
    expect(load({ openai_max_context: 4095, image_inlining: true }).doc.unsupported).not.toHaveProperty(
      "media_inlining"
    )
  })
})

describe("ST's prompt and order sanitizing", () => {
  it("adds missing built-in prompts and fills an empty prompt list", () => {
    const builtIns = ["main", "nsfw", "jailbreak", "chatHistory", "dialogueExamples", "personaDescription"]
    const fromEmpty = load(preset({ prompts: [] })).doc
    const fromPartial = load(preset({ prompts: [{ identifier: "main", content: "Hi", system_prompt: true }] })).doc
    for (const doc of [fromEmpty, fromPartial])
      expect(doc.prompts.map((p) => p.identifier)).toEqual(expect.arrayContaining(builtIns))
    expect(prompt(fromPartial, "main")?.content).toBe("Hi")
    expect(fromPartial.order).toEqual([])
  })

  it("treats a prompt without `system_prompt` as ST does: not sent from the order", () => {
    const doc = load(
      preset({
        prompts: [
          { identifier: "a", content: "x" },
          { identifier: "b", content: "y", system_prompt: false }
        ]
      })
    ).doc
    expect(prompt(doc, "a")?.system_prompt).toBe(true)
    expect(prompt(doc, "b")?.system_prompt).toBe(false)
  })

  it("imports in-chat prompts ST would never send as disabled", () => {
    const result = load({
      prompts: [
        { identifier: "a", role: "system", content: "x", injection_position: 1, injection_depth: "2" },
        { identifier: "b", content: "y", injection_position: 1, injection_depth: 1 },
        { identifier: "c", role: "user", content: "z", injection_position: 1, injection_depth: 10_001 },
        { identifier: "d", role: "user", content: "w", injection_position: 1, injection_depth: 3 }
      ],
      prompt_order: [
        { character_id: 100001, order: ["a", "b", "c", "d"].map((identifier) => ({ identifier, enabled: true })) }
      ]
    })
    expect(result.doc.order.map((e) => e.enabled)).toEqual([false, false, false, true])
    expect(codes(result).filter((c) => c === "preset.prompt_never_sent")).toHaveLength(3)
  })

  it("keeps the first of duplicate prompts and order entries, and drops dangling entries", () => {
    const result = load({
      prompts: [
        { identifier: "a", content: "first" },
        { identifier: "a", content: "second" },
        "not a prompt",
        { content: "no identifier" }
      ],
      prompt_order: [
        {
          character_id: "100001",
          order: [
            { identifier: "a", enabled: true },
            { identifier: "a", enabled: false },
            { identifier: "ghost", enabled: true },
            { enabled: true }
          ]
        }
      ]
    })
    expect(prompt(result.doc, "a")?.content).toBe("first")
    expect(prompt(result.doc, "imported-3")?.content).toBe("no identifier")
    expect(result.doc.order).toEqual([{ identifier: "a", enabled: true }])
    expect(codes(result)).toEqual(
      expect.arrayContaining([
        "preset.prompt_duplicate",
        "preset.prompt_invalid",
        "preset.prompt_identifier",
        "preset.order_duplicate",
        "preset.order_entry_dropped"
      ])
    )
  })

  it("uses ST's default order when the preset has no global order", () => {
    const result = load({ prompts: [], prompt_order: [{ character_id: 100000, order: [] }] })
    expect(result.doc.order).toHaveLength(12)
    expect(codes(result, "warning")).toContain("preset.no_global_order")
    expect(issue(result, "preset.prompt_orders_dropped")?.message).toContain("100000")
  })

  it("falls back to ST's defaults for unusable values, and says so", () => {
    const result = load(
      preset({ names_behavior: 9, custom_prompt_post_processing: "unknown", temperature: "warm", top_p: "" })
    )
    expect(result.doc.names_behavior).toBe("default")
    expect(result.doc.postprocess).toBe("none")
    expect(result.doc.samplers.temperature).toBe(1)
    expect(result.doc.samplers.top_p).toBe(1)
    expect(codes(result, "warning").filter((c) => c === "preset.invalid_value")).toHaveLength(4)
  })

  it("normalizes regex scripts without ids or with repeated ones", () => {
    const result = load(
      preset({
        extensions: {
          regex_scripts: [
            { id: "r", findRegex: "a" },
            { id: "r", findRegex: "b", minDepth: "2", placement: [2, "1", 1.5] },
            { findRegex: "c", substituteRegex: true }
          ]
        }
      })
    )
    expect(result.doc.regex.map((s) => [s.id, s.find_regex])).toEqual([
      ["r", "a"],
      ["r-2", "b"],
      ["imported-regex-2", "c"]
    ])
    expect(result.doc.regex[1]).toMatchObject({ min_depth: 2, placement: [2] })
    // ST reads a legacy `true` as 1, raw substitution.
    expect(result.doc.regex[2]?.substitute_regex).toBe("raw")
  })

  it("reads bytes, with or without a byte-order mark", () => {
    const text = JSON.stringify(preset({ temperature: 0.5 }))
    const bytes = new TextEncoder().encode("\uFEFF" + text)
    expect(load(bytes).doc.samplers.temperature).toBe(0.5)
    expect(load("\uFEFF" + text).doc.samplers.temperature).toBe(0.5)
  })
})

describe("files that aren't chat-completion presets", () => {
  it.each([
    ["st-instruct-template", { name: "X", input_sequence: "", output_sequence: "", wrap: true }],
    ["st-context-template", { name: "X", story_string: "{{description}}" }],
    ["st-system-prompt", { name: "X", content: "You are helpful." }],
    ["st-text-completion-preset", { temp: 0.7, top_k: 40, top_p: 0.9, rep_pen: 1.1 }],
    ["st-reasoning-template", { name: "X", prefix: "<think>", suffix: "</think>", separator: "\n" }],
    ["st-novelai-preset", { temperature: 1, max_length: 150, min_length: 1 }],
    ["st-master-export", { instruct: { name: "X" }, context: { name: "X" } }]
  ])("reports %s as unsupported without importing it", (format, file) => {
    const result = importStPreset(JSON.stringify(file))
    expect(result.document).toBeNull()
    expect(result.report.format).toBe(format)
    expect(codes(result)).toEqual(["preset.unsupported_format"])
  })

  it.each([["not json {"], ["[]"], ['"text"'], ["null"], ['{"something":"else"}']])("rejects %s", (text) => {
    const result = importStPreset(text)
    expect(result.document).toBeNull()
    expect(codes(result, "error")).toHaveLength(1)
  })
})

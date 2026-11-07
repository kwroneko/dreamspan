import { LegacyPresetDoc as PresetDoc } from "@rp/shared/docs/preset.ts"
import { conditionOf, editedDoc, presetWarnings, triggersFor, withEndOfRequest } from "@rp/shared/presetConditions.ts"
import { CONTINUE_TEXT, DIRECTION_TEXT, endOfRequestText, TURN_TEXT } from "@rp/shared/endOfRequest.ts"
import { Schema } from "effect"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { exportStPreset, importStPreset, MAX_PRESET_BYTES, type PresetImport } from "../src/formats/preset.ts"
import { defaultLimits } from "../src/formats/safety.ts"

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
  it("puts Main first and off when the ST order leaves it out, including on reimport", () => {
    const imported = load({
      prompts: [{ identifier: "main", name: "Custom Main", system_prompt: false, content: "KEEP ME" }],
      prompt_order: [{ character_id: 100001, order: [{ identifier: "chatHistory", enabled: true }] }]
    }).doc
    expect(imported.order[0]).toEqual({ identifier: "main", enabled: false })
    expect(prompt(imported, "main")).toMatchObject({ content: "KEEP ME", system_prompt: false })
    const again = load(exportStPreset(imported)).doc
    expect(again.order[0]).toEqual({ identifier: "main", enabled: false })
    expect(prompt(again, "main")?.content).toBe("KEEP ME")
  })

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
      "newestMessage",
      "jailbreak"
    ])
    expect(doc.order.find((e) => e.identifier === "enhanceDefinitions")?.enabled).toBe(false)
    expect(issue(result, "preset.prompt_orders_dropped")?.message).toContain("100000")
    expect(prompt(doc, "main")).toMatchObject({ content: "You narrate a story starring {{char}} and {{user}}." })
    expect(prompt(doc, "chatHistory")).toMatchObject({ marker: true, system_prompt: true, role: "system" })
    // ST's impersonation prompt is an end-of-request text now, with {{user}} as {{speaker}}.
    expect(doc.utility_prompts.impersonation_prompt).toBe("")
    expect(prompt(doc, "impersonationPrompt")).toMatchObject({ content: "[Reply as {{speaker}} this time.]" })
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
    expect(
      doc.order
        .filter((e) => !["newestMessage", "groupNudge", "impersonationPrompt", "direction"].includes(e.identifier))
        .slice(12)
        .map((e) => e.enabled)
    ).toEqual([true, true, false, true])
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
    // An empty ST order still sends the markers ST appends after the other prompts.
    expect(fromPartial.order.filter((e) => e.enabled).map((e) => e.identifier)).toEqual([
      "newestMessage",
      "worldInfoBefore",
      "worldInfoAfter",
      "charDescription",
      "charPersonality",
      "scenario",
      "personaDescription"
    ])
    // Every prompt but the four end-of-request texts, which are never in the order.
    expect(fromPartial.order).toHaveLength(fromPartial.prompts.length - 4)
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
    expect(result.doc.order.slice(1, 5).map((e) => e.enabled)).toEqual([false, false, false, true])
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
    expect(result.doc.order.slice(1, 2)).toEqual([{ identifier: "a", enabled: true }])
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
    // ST's twelve and the newest-message marker; the end-of-request texts are outside the order.
    expect(result.doc.order).toHaveLength(13)
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

describe("exporting to an ST chat-completion preset", () => {
  type Item = Record<string, unknown>
  const byKey = (items: unknown, key: string) => new Map((items as Array<Item>).map((i) => [i[key], i]))
  // ST ignores a regex depth below these bounds, as it does a missing one.
  const stDepth = (v: unknown, min: number) => (typeof v === "number" && v >= min ? v : null)

  it("leaves out the preset's lorebooks, which ST has no field for, and an ST file never sets them", () => {
    const { doc } = load(fixture("default"))
    expect(doc.lorebooks).toBeUndefined()
    const file = exportStPreset({ ...doc, lorebooks: [{ id: "book-ref", enabled: true }] })
    expect(file).not.toHaveProperty("lorebooks")
    expect(JSON.stringify(file)).not.toContain("book-ref")
    // A file with a top-level `lorebooks` keeps it only as a field ST's export gives back.
    expect(
      load({ ...JSON.parse(fixture("default")), lorebooks: [{ id: "x", enabled: true }] }).doc.lorebooks
    ).toBeUndefined()
  })

  it.each(["default", "full"])("gives back every field ST reads from %s, with the same value", (name) => {
    const original = JSON.parse(fixture(name)) as Item
    const file = exportStPreset(load(original).doc)
    const connection = [
      "chat_completion_source",
      "openai_model",
      "claude_model",
      "openrouter_model",
      "openrouter_use_fallback",
      "openrouter_sort_models",
      "electronhub_sort_models",
      "custom_model",
      "custom_url",
      "custom_include_headers",
      "reverse_proxy",
      "proxy_password",
      "show_external_models",
      "bypass_status_check"
    ]
    for (const [key, value] of Object.entries(original)) {
      if (connection.includes(key)) expect(file).not.toHaveProperty(key)
      else if (key === "prompts") {
        const prompts = byKey(file.prompts, "identifier")
        for (const p of value as Array<Item>) expect(prompts.get(p.identifier)).toMatchObject(p)
      } else if (key === "prompt_order") {
        const global = (value as Array<Item>).find((o) => o.character_id === 100001)
        expect(
          (file.prompt_order as Array<{ character_id: number; order: Array<{ identifier: string }> }>).map((o) => ({
            ...o,
            order: o.order.filter((e) => e.identifier !== "newestMessage" && e.identifier !== "direction")
          }))
        ).toEqual([global])
      } else if (key === "extensions") {
        const { regex_scripts, ...rest } = value as Item
        const scripts = (file.extensions as Item).regex_scripts as Array<Item> | undefined
        expect(file.extensions).toMatchObject(rest)
        for (const [i, s] of ((regex_scripts ?? []) as Array<Item>).entries())
          expect(scripts?.[i]).toEqual({ ...s, minDepth: stDepth(s.minDepth, -1), maxDepth: stDepth(s.maxDepth, 0) })
      } else if (typeof file[key] === "number") expect(file[key]).toBe(Number(value))
      else expect(file[key]).toEqual(value)
    }
  })

  it.each(["default", "full", "legacy"])("round-trips %s to the same document", (name) => {
    const first = load(fixture(name))
    const second = load(JSON.stringify(exportStPreset(first.doc)))
    expect(second.doc).toEqual(first.doc)
    // Nothing is dropped or defaulted the second time.
    for (const code of ["preset.prompt_orders_dropped", "preset.connection_ignored", "preset.defaults_applied"])
      expect(codes(second)).not.toContain(code)
  })

  it("lets modelled fields win over an unsupported entry of the same name", () => {
    const { doc } = load(fixture("default"))
    const file = exportStPreset({ ...doc, unsupported: { ...doc.unsupported, temperature: 2, prompts: [] } })
    expect(file.temperature).toBe(1)
    // The turn texts go back to ST's utility prompts; ST has no field for the direction text.
    expect(file.prompts).toHaveLength(doc.prompts.length - 4)
  })

  it("writes the document's enums back as ST's values", () => {
    const { doc } = load(fixture("full"))
    expect(exportStPreset(doc)).toMatchObject({ names_behavior: 2, custom_prompt_post_processing: "strict" })
    expect(exportStPreset({ ...doc, names_behavior: "none", postprocess: "none" })).toMatchObject({
      names_behavior: -1,
      custom_prompt_post_processing: ""
    })
  })
})

describe("hardening: the file is untrusted", () => {
  // The shared ReportBuilder's cap on issues.
  const MAX_ISSUES = 200
  const valid = JSON.stringify(preset({ temperature: 0.5 }))

  it("refuses a file over the size cap before parsing it", () => {
    expect(importStPreset(valid.padEnd(MAX_PRESET_BYTES, " ")).document).not.toBeNull()
    for (const input of [valid.padEnd(MAX_PRESET_BYTES + 1, " "), new Uint8Array(MAX_PRESET_BYTES + 1).fill(32)]) {
      const result = importStPreset(input)
      expect(result.document).toBeNull()
      expect(codes(result)).toEqual(["json.too_large"])
    }
    // Measured in bytes, not characters.
    const wide = valid.slice(0, -1) + `,"x":"${"é".repeat(MAX_PRESET_BYTES / 2)}"}`
    expect(codes(importStPreset(wide))).toEqual(["json.too_large"])
  })

  it("refuses nesting deeper than the bound, counting only brackets outside strings", () => {
    const nested = (depth: number) =>
      JSON.stringify(preset({ extensions: { x: "PLACEHOLDER" } })).replace(
        '"PLACEHOLDER"',
        "[".repeat(depth) + "]".repeat(depth)
      )
    // The root and `extensions` are two levels.
    expect(importStPreset(nested(defaultLimits.maxJsonDepth - 2)).document).not.toBeNull()
    const result = importStPreset(nested(defaultLimits.maxJsonDepth - 1))
    expect(result.document).toBeNull()
    expect(codes(result)).toEqual(["json.too_deep"])
    const brackets = JSON.stringify(preset({ prompts: [{ identifier: "a", content: '\\"' + "[{".repeat(500) }] }))
    expect(importStPreset(brackets).document).not.toBeNull()
  })

  it("drops prototype keys at any depth and reports each, so none reaches an object", () => {
    const text = `{
      "prompts": [{ "identifier": "a", "content": "x", "__proto__": { "system_prompt": false }, "constructor": "c" }],
      "extensions": { "__proto__": { "polluted": true }, "ok": { "constructor": { "prototype": 1 }, "kept": 1 } },
      "__proto__": { "temperature": 0.1, "polluted": true }
    }`
    const result = importStPreset(text)
    const doc = result.document!
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    for (const o of [doc.unsupported, doc.extensions, doc.extensions.ok as object])
      expect(Object.getPrototypeOf(o)).toBe(Object.prototype)
    expect(doc.extensions).toEqual({ ok: { kept: 1 } })
    expect(Object.hasOwn(doc.extensions, "__proto__")).toBe(false)
    expect(doc.unsupported).toEqual({})
    expect("polluted" in doc.unsupported).toBe(false)
    expect(doc.samplers.temperature).toBe(1)
    expect(prompt(doc, "a")?.system_prompt).toBe(true)
    expect(prompt(doc, "a")).not.toHaveProperty("unsupported")
    expect(result.report.issues.filter((i) => i.code === "json.forbidden_key").map((i) => i.path)).toEqual([
      ["prompts", 0, "__proto__"],
      ["prompts", 0, "constructor"],
      ["extensions", "__proto__"],
      ["extensions", "ok", "constructor"],
      ["__proto__"]
    ])
  })

  it("stores regex scripts without compiling them", () => {
    const patterns = ["(", "/(a+)+$/", "/[/g", "/x/zz"]
    const scripts = patterns.map((findRegex, i) => ({ id: `r${i}`, findRegex }))
    const doc = load(preset({ extensions: { regex_scripts: scripts } })).doc
    expect(doc.regex.map((s) => s.find_regex)).toEqual(patterns)
  })

  it("doesn't throw on values that can't be converted to text or numbers", () => {
    const hostile = { toString: 1, valueOf: 1 }
    const result = load({
      prompts: [{ identifier: "a", injection_order: hostile }],
      prompt_order: [
        { character_id: hostile, order: [] },
        { character_id: 100001, order: [] }
      ],
      extensions: { regex_scripts: [{ id: "r", substituteRegex: hostile, minDepth: hostile, maxDepth: hostile }] }
    })
    expect(result.doc.regex[0]).toMatchObject({ substitute_regex: "none", min_depth: null, max_depth: null })
  })

  it("renames many repeated regex ids in linear time", { timeout: 5_000 }, () => {
    const count = 30_000
    const scripts = Array.from({ length: count }, () => ({ id: "r", findRegex: "x" }))
    const ids = new Set(load(preset({ extensions: { regex_scripts: scripts } })).doc.regex.map((s) => s.id))
    expect(ids.size).toBe(count)
  })

  it("lists at most a bounded number of issues", () => {
    const many = Object.fromEntries(Array.from({ length: MAX_ISSUES * 2 }, (_, i) => [`unknown_${i}`, i]))
    const result = load(preset(many))
    expect(result.report.issues).toHaveLength(MAX_ISSUES + 1)
    expect(result.report.issues.at(-1)?.code).toBe("report.truncated")
  })

  it("keeps the whole report small, however much text the file supplies", () => {
    const fill = (unit: string, around: number) => unit.repeat(Math.floor((MAX_PRESET_BYTES - around) / unit.length))
    const long = "K".repeat(1000)
    const files = [
      // Many order lists without ids, each listed in one message (within the container cap).
      `{"prompt_order":[${"{},".repeat(200_000)}{"character_id":100001,"order":[]}]}`,
      // A few huge keys.
      `{"prompt_order":[],${[1, 2, 3, 4].map((i) => `"${"K".repeat(MAX_PRESET_BYTES / 5)}${i}":0`).join(",")}}`,
      // Issues with long paths of long keys (within the cap on prototype keys).
      `{"prompt_order":[],"extensions":${`{"${long}":`.repeat(60)}[${'{"__proto__":1},'.repeat(90)}{}]${"}".repeat(61)}`,
      // Many repeated long prompt identifiers.
      `{"prompt_order":[],"prompts":[${fill(`{"identifier":"${long}"},`, 100)}{}]}`
    ]
    for (const file of files) {
      expect(Buffer.byteLength(file)).toBeLessThanOrEqual(MAX_PRESET_BYTES)
      const result = importStPreset(file)
      expect(result.document).not.toBeNull()
      expect(JSON.stringify(result.report).length).toBeLessThanOrEqual(MAX_ISSUES * 2048)
    }
    const dropped = issue(importStPreset(files[0]!), "preset.prompt_orders_dropped")?.message
    expect(dropped).toMatch(/: \?, \?, .* and \d+ more\.$/)
  })

  it("caps files at 2 MB, room for 250 times ST's own default preset", () => {
    expect(MAX_PRESET_BYTES).toBe(2 * 1024 * 1024)
  })

  it("never returns a document the schema refuses, whatever the file holds", () => {
    // A seeded generator, so a failure reproduces.
    let seed = 0x5eed
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const pick = <A>(items: ReadonlyArray<A>) => items[Math.floor(random() * items.length)]!
    const hostile: ReadonlyArray<unknown> = [
      "INFINITY",
      "-INFINITY",
      "Infinity",
      -1,
      0,
      1.5,
      10_001,
      "",
      "x",
      null,
      true,
      [],
      [7],
      {},
      { toString: 1, valueOf: 1 },
      "__proto__"
    ]
    const leaves = (value: unknown, path: Array<string | number> = []): Array<Array<string | number>> =>
      typeof value === "object" && value !== null
        ? [path, ...Object.entries(value).flatMap(([k, v]) => leaves(v, [...path, Array.isArray(value) ? +k : k]))]
        : [path]
    // Sets the value at the path, unless an earlier mutation replaced a container on it.
    const set = (root: unknown, path: ReadonlyArray<string | number>, v: unknown): unknown => {
      const copy = structuredClone(root) as Record<string | number, unknown>
      let node: unknown = copy
      for (const key of path.slice(0, -1)) node = (node as Record<string | number, unknown> | undefined)?.[key]
      if (typeof node === "object" && node !== null) (node as Record<string | number, unknown>)[path.at(-1)!] = v
      return copy
    }
    const inputs: Array<string> = []
    for (const name of ["default", "full", "legacy"]) {
      const base = JSON.parse(fixture(name)) as unknown
      const paths = leaves(base).filter((p) => p.length > 0)
      inputs.push(JSON.stringify(base))
      for (let i = 0; i < 400; i++) {
        let mutated = base
        for (let j = 0; j < 3; j++) mutated = set(mutated, pick(paths), pick(hostile))
        inputs.push(JSON.stringify(mutated))
      }
    }
    for (const input of inputs) {
      // JSON.stringify can't write infinities, so they go in as text.
      const result = importStPreset(input.replaceAll('"-INFINITY"', "-1e999").replaceAll('"INFINITY"', "1e999"))
      if (result.document !== null) expect(Schema.decodeUnknownExit(PresetDoc)(result.document)._tag).toBe("Success")
    }
  })
})

describe("cases where ST's behaviour is easy to miss", () => {
  const order = (...entries: Array<[string, boolean]>) => [
    { character_id: 100001, order: entries.map(([identifier, enabled]) => ({ identifier, enabled })) }
  ]

  it("keeps only regex placements its schema takes: whole numbers within the safe range", () => {
    const text = JSON.stringify(preset({ extensions: { regex_scripts: [{ id: "r", placement: [1e20, 2, 1.5] }] } }))
    const result = importStPreset(text)
    expect(result.document!.regex[0]!.placement).toEqual([2])
    expect(Schema.decodeUnknownExit(PresetDoc)(result.document)._tag).toBe("Success")
  })

  it("reads infinite regex depths as ST does, and reports them", () => {
    const text = JSON.stringify(
      preset({ extensions: { regex_scripts: [{ id: "r", findRegex: "/a/", minDepth: "Infinity", maxDepth: "MAX" }] } })
    ).replace('"MAX"', "1e999")
    const result = load(text)
    expect(result.doc.regex[0]).toMatchObject({ min_depth: Number.MAX_VALUE, max_depth: null })
    expect(codes(result).filter((c) => c === "preset.regex_infinite_depth")).toHaveLength(2)
  })

  it("sends an in-chat marker without a role as system, as ST does", () => {
    const result = load({
      prompts: [
        { identifier: "charDescription", system_prompt: true, marker: true, injection_position: 1, injection_depth: 2 },
        { identifier: "chatHistory", system_prompt: true, marker: true, injection_position: 1, injection_depth: 2 }
      ],
      prompt_order: order(["charDescription", true], ["chatHistory", true])
    })
    expect(result.doc.order.slice(1, 3)).toEqual([
      { identifier: "charDescription", enabled: true },
      { identifier: "chatHistory", enabled: false }
    ])
  })

  it("enables a prompt listed twice if any entry is, and warns when ST would send it twice", () => {
    const prompts = [
      { identifier: "x", system_prompt: false, role: "system", content: "n", injection_position: 1, injection_depth: 1 }
    ]
    const once = load({ prompts, prompt_order: order(["x", false], ["x", true]) })
    expect(once.doc.order.slice(1, 2)).toEqual([{ identifier: "x", enabled: true }])
    expect(codes(once)).not.toContain("preset.order_repeated")
    const twice = load({ prompts, prompt_order: order(["x", true], ["x", true]) })
    expect(twice.doc.order.slice(1, 2)).toEqual([{ identifier: "x", enabled: true }])
    expect(issue(twice, "preset.order_repeated")?.message).toContain("2 times")
  })

  it("reads a relative prompt listed twice by its first entry, as ST does", () => {
    const prompts = [{ identifier: "x", system_prompt: false, role: "user", content: "rel" }]
    const off = load({ prompts, prompt_order: order(["x", false], ["x", true]) })
    expect(off.doc.order.slice(1, 2)).toEqual([{ identifier: "x", enabled: false }])
    // ST sends it once: the second copy overwrites the first's slot.
    const on = load({ prompts, prompt_order: order(["x", true], ["x", true]) })
    expect(on.doc.order.slice(1, 2)).toEqual([{ identifier: "x", enabled: true }])
    expect(codes(on)).not.toContain("preset.order_repeated")
  })

  it("imports a prompt whose generation types are all invalid as disabled", () => {
    const result = load({
      prompts: [
        { identifier: "a", system_prompt: false, content: "x", injection_trigger: [7] },
        { identifier: "b", system_prompt: false, content: "y", injection_trigger: ["normal", 7] }
      ],
      prompt_order: order(["a", true], ["b", true])
    })
    expect(result.doc.order.slice(1, 3).map((e) => e.enabled)).toEqual([false, true])
    expect(prompt(result.doc, "b")?.injection_trigger).toEqual(["normal"])
    expect(issue(result, "preset.prompt_never_sent")?.message).toContain("generation types")
  })

  it("generates identifiers and regex ids that nothing in the file uses", () => {
    const result = load(
      preset({
        prompts: [{ content: "generated" }, { identifier: "imported-0", content: "real" }],
        extensions: { regex_scripts: [{ findRegex: "generated" }, { id: "imported-regex-0", findRegex: "real" }] }
      })
    )
    expect(prompt(result.doc, "imported-0")?.content).toBe("real")
    expect(prompt(result.doc, "imported-0-2")?.content).toBe("generated")
    expect(result.doc.regex.map((s) => [s.id, s.find_regex])).toEqual([
      ["imported-regex-0-2", "generated"],
      ["imported-regex-0", "real"]
    ])
  })

  it("says where a global order without a list differs from ST", () => {
    const result = load({ prompts: [], prompt_order: [{ character_id: 100001 }] })
    expect(result.doc.order).toHaveLength(13)
    expect(issue(result, "preset.no_global_order")?.message).toContain("ST would send none")
  })

  it("reports text fields that hold something else", () => {
    const result = load(
      preset({
        prompts: [{ identifier: "x", content: 42, name: ["n"] }],
        extensions: { regex_scripts: [{ id: "r", findRegex: ["/a/"], replaceString: 5, scriptName: {} }] }
      })
    )
    expect(prompt(result.doc, "x")).toMatchObject({ content: "", name: "" })
    expect(result.doc.regex[0]).toMatchObject({ find_regex: "", replace_string: "", name: "" })
    expect(codes(result).filter((c) => c === "preset.invalid_value")).toHaveLength(5)
  })

  it("never takes the regex approval from the file, and never exports it", () => {
    const result = load(preset({ regex_approved: true, extensions: { regex_scripts: [{ id: "r" }] } }))
    expect(result.doc.regex_approved).toBe(false)
    expect(result.doc.unsupported).not.toHaveProperty("regex_approved")
    expect(codes(result, "warning")).toContain("preset.approval_ignored")
    // Whether the file claimed it or the user later approved, the export carries nothing.
    for (const doc of [result.doc, { ...result.doc, regex_approved: true }])
      expect(JSON.stringify(exportStPreset(doc))).not.toContain("regex_approved")
  })

  it("never takes its panels' permissions from the file, and never exports them", () => {
    const result = load(preset({ html_scripts_approved: true, html_network_approved: true }))
    expect(result.doc.html_scripts_approved).toBeUndefined()
    expect(result.doc.html_network_approved).toBeUndefined()
    expect(result.doc.unsupported).not.toHaveProperty("html_scripts_approved")
    expect(codes(result, "warning").filter((c) => c === "preset.approval_ignored")).toHaveLength(2)
    const allowed = { ...result.doc, html_scripts_approved: true, html_network_approved: true }
    expect(JSON.stringify(exportStPreset(allowed))).not.toContain("html_")
  })
})

describe("the document order", () => {
  it("appends prompts outside the ST order off and reports their names", () => {
    const result = load({
      prompts: [{ identifier: "parked", name: "Parked prompt", system_prompt: false, content: "Keep me" }],
      prompt_order: [
        {
          character_id: 100001,
          order: [
            { identifier: "main", enabled: true },
            { identifier: "chatHistory", enabled: true }
          ]
        }
      ]
    })
    expect(result.doc.order.find((e) => e.identifier === "parked")).toEqual({ identifier: "parked", enabled: false })
    expect(result.doc.order.map((e) => e.identifier).sort()).toEqual(
      result.doc.prompts
        .map((p) => p.identifier)
        .filter((id) => !endOfRequestText(id))
        .sort()
    )
    expect(issue(result, "preset.prompts_appended_off")?.message).toContain("Parked prompt")
    // ST still sends the markers its order leaves out, after the other prompts: they stay on.
    expect(result.doc.order.find((e) => e.identifier === "charDescription")).toEqual({
      identifier: "charDescription",
      enabled: true
    })
    expect(issue(result, "preset.prompts_appended_off")?.message).not.toContain("Char Description")
    expect(issue(result, "preset.markers_appended_on")?.message).toContain("Char Description")
    const history = result.doc.order.findIndex((e) => e.identifier === "chatHistory")
    expect(result.doc.order[history + 1]?.identifier).toBe("newestMessage")
  })
  it("round trips the newest message after the tail", () => {
    const original = load(fixture("default")).doc
    const moved = {
      ...original,
      order: [
        ...original.order.filter((e) => e.identifier !== "newestMessage"),
        { identifier: "newestMessage", enabled: true }
      ]
    }
    expect(load(exportStPreset(moved)).doc.order).toEqual(moved.order)
  })
})

describe("conditions (DESIGN §2.2)", () => {
  const withTriggers = (injection_trigger: ReadonlyArray<string>) =>
    load(
      preset({
        prompts: [{ identifier: "t", name: "Triggered", content: "x", system_prompt: false, injection_trigger }],
        prompt_order: [{ character_id: 100001, order: [{ identifier: "t", enabled: true }] }]
      })
    )

  it.each([
    [[]],
    [["impersonate"]],
    [["normal"]],
    [["regenerate"]],
    [["continue", "quiet"]],
    [["normal", "impersonate"]]
  ] as const)("keeps ST triggers %j as they are, beside an Always condition (owner 2026-10-28)", (triggers) => {
    const p = prompt(withTriggers(triggers).doc, "t")!
    expect(p.condition).toBeUndefined()
    expect(conditionOf(p)).toBe("always")
    expect(p.injection_trigger).toEqual(triggers)
  })

  it("sends a prompt only for the generation types its triggers name, as ST's shouldTrigger", () => {
    const p = (injection_trigger: ReadonlyArray<string>) => prompt(withTriggers(injection_trigger).doc, "t")!
    const types = ["normal", "swipe", "impersonate", "continue", "quiet"]
    const sentFor = (triggers: ReadonlyArray<string>) => types.filter((type) => triggersFor(p(triggers), type))
    // A normal-only prompt isn't sent on swipes, as in ST.
    expect(sentFor(["normal"])).toEqual(["normal"])
    // A new version of a reply is ST's swipe and its regenerate alike.
    expect(sentFor(["swipe"])).toEqual(["swipe"])
    expect(sentFor(["regenerate"])).toEqual(["swipe"])
    expect(sentFor(["impersonate"])).toEqual(["impersonate"])
    expect(sentFor(["continue"])).toEqual(["continue"])
    expect(sentFor(["quiet"])).toEqual(["quiet"])
    expect(sentFor([])).toEqual(types)
  })

  it("turns ST's group nudge and impersonation prompt into end-of-request texts, outside the order", () => {
    const result = load(
      preset({
        group_nudge_prompt: "[Only {{char}} speaks; not {{ CHAR }}'s rival.]",
        impersonation_prompt: "[Write as {{user}}.]",
        continue_nudge_prompt: "[Go on from {{char}}'s last line.]",
        prompt_order: [
          {
            character_id: 100001,
            order: ["main", "chatHistory", "jailbreak"].map((identifier) => ({ identifier, enabled: true }))
          }
        ]
      })
    )
    const { doc } = result
    expect(prompt(doc, "groupNudge")).toMatchObject({
      role: "user",
      name: "When a character speaks",
      content: "[Only {{speaker}} speaks; not {{speaker}}'s rival.]"
    })
    expect(prompt(doc, "groupNudge")!.condition).toBeUndefined()
    expect(prompt(doc, "impersonationPrompt")).toMatchObject({ role: "user", content: "[Write as {{speaker}}.]" })
    expect(prompt(doc, "directionPrompt")).toMatchObject({ role: "user", content: DIRECTION_TEXT })
    // ST's continue nudge, as it is: it speaks to the model, so its macros stay.
    expect(prompt(doc, "continueNudge")).toMatchObject({
      role: "user",
      name: "When you continue a reply",
      content: "[Go on from {{char}}'s last line.]"
    })
    expect(doc.utility_prompts.group_nudge_prompt).toBe("")
    expect(doc.utility_prompts.impersonation_prompt).toBe("")
    expect(doc.utility_prompts.continue_nudge_prompt).toBe("")
    const ids = doc.order.map((e) => e.identifier)
    expect(ids.slice(0, 4)).toEqual(["main", "chatHistory", "newestMessage", "jailbreak"])
    for (const id of ["groupNudge", "impersonationPrompt", "continueNudge", "directionPrompt"])
      expect(ids).not.toContain(id)
    expect(codes(result)).toEqual(expect.arrayContaining(["preset.group_nudge_prompt", "preset.impersonation_prompt"]))
    // Empty ones keep our defaults.
    const none = load(preset({ group_nudge_prompt: "", impersonation_prompt: "", continue_nudge_prompt: "" })).doc
    expect(prompt(none, "groupNudge")!.content).toBe(TURN_TEXT)
    expect(prompt(none, "impersonationPrompt")!.content).toBe(TURN_TEXT)
    expect(prompt(none, "continueNudge")!.content).toBe(CONTINUE_TEXT)
  })

  it("gives every import the end-of-request texts once, and not again on a reimport", () => {
    const { doc } = load(fixture("full"))
    for (const id of ["groupNudge", "impersonationPrompt", "continueNudge", "directionPrompt"])
      expect(doc.prompts.filter((p) => p.identifier === id)).toHaveLength(1)
    const again = load(exportStPreset(doc)).doc
    expect(again).toEqual(doc)
    // Converted already, it comes back as it is.
    expect(withEndOfRequest(doc).doc).toBe(doc)
  })

  it("exports conditions as ST has them, and reimports the same document", () => {
    const { doc } = load(
      preset({
        group_nudge_prompt: "[Only {{char}}.]",
        impersonation_prompt: "[As {{user}}.]",
        continue_nudge_prompt: "[Go on.]",
        prompts: [
          { identifier: "a", content: "a", system_prompt: false, injection_trigger: ["normal"] },
          { identifier: "b", content: "b", system_prompt: false }
        ],
        prompt_order: [
          {
            character_id: 100001,
            order: [
              { identifier: "a", enabled: true },
              { identifier: "b", enabled: true },
              { identifier: "chatHistory", enabled: true }
            ]
          }
        ]
      })
    )
    const edited = {
      ...doc,
      prompts: doc.prompts.map((p) => (p.identifier === "b" ? { ...p, condition: "as_user" as const } : p))
    }
    const file = exportStPreset(edited)
    expect(file.group_nudge_prompt).toBe("[Only {{char}}.]")
    expect(file.impersonation_prompt).toBe("[As {{user}}.]")
    expect(file.continue_nudge_prompt).toBe("[Go on.]")
    const prompts = file.prompts as Array<Record<string, unknown>>
    expect(prompts.map((p) => p.identifier)).not.toContain("groupNudge")
    // ST has no field for the direction text: it isn't written.
    expect(prompts.map((p) => p.identifier)).not.toContain("directionPrompt")
    expect(JSON.stringify(file)).not.toContain(DIRECTION_TEXT)
    expect(prompts.find((p) => p.identifier === "a")!.injection_trigger).toEqual(["normal"])
    expect(prompts.find((p) => p.identifier === "b")!.injection_trigger).toEqual(["impersonate"])
    const order = (file.prompt_order as Array<{ order: Array<{ identifier: string; enabled: boolean }> }>)[0]!.order
    expect(order.map((e) => e.identifier)).not.toContain("impersonationPrompt")
    expect(prompts.find((p) => p.identifier === "b")!.condition).toBe("as_user")
    expect(load(file).doc).toEqual({
      ...edited,
      prompts: edited.prompts.map((p) => (p.identifier === "b" ? { ...p, injection_trigger: ["impersonate"] } : p))
    })
    // A condition and the prompt's own triggers both limit it: ST gets the types where both hold.
    const both = exportStPreset({
      ...edited,
      prompts: edited.prompts.map((p) =>
        p.identifier === "a"
          ? { ...p, condition: "as_character" as const, injection_trigger: ["normal", "impersonate"] }
          : p
      )
    })
    const a = (both.prompts as Array<Record<string, unknown>>).find((p) => p.identifier === "a")!
    expect(a.injection_trigger).toEqual(["normal"])
    expect(a.condition).toBe("as_character")
    // A prompt sent only with a direction, which ST would send every turn, goes out off.
    const directed = exportStPreset({
      ...edited,
      prompts: edited.prompts.map((p) => (p.identifier === "a" ? { ...p, condition: "with_direction" as const } : p))
    })
    const directedOrder = (
      directed.prompt_order as Array<{ order: Array<{ identifier: string; enabled: boolean }> }>
    )[0]!.order
    expect(directedOrder.find((e) => e.identifier === "a")?.enabled).toBe(false)
    // A condition and generation types that never meet (as your card, only Normal; inv A2): never
    // sent here, so off for ST, which would send it on a normal turn. A reimport turns it back on.
    const never = {
      ...edited,
      // (b's condition alone goes to ST as its triggers, as above.)
      prompts: edited.prompts.map((p) =>
        p.identifier === "a"
          ? { ...p, condition: "as_user" as const }
          : p.identifier === "b"
            ? { ...p, injection_trigger: ["impersonate"] }
            : p
      )
    }
    expect(presetWarnings(new Map(never.prompts.map((p) => [p.identifier, p])), never.order).neverSent).toEqual([
      never.prompts.find((p) => p.identifier === "a")
    ])
    const neverFile = exportStPreset(never)
    const neverOrder = (neverFile.prompt_order as Array<{ order: Array<{ identifier: string; enabled: boolean }> }>)[0]!
      .order
    expect(neverOrder.find((e) => e.identifier === "a")?.enabled).toBe(false)
    expect(neverOrder.find((e) => e.identifier === "b")?.enabled).toBe(true)
    const neverA = (neverFile.prompts as Array<Record<string, unknown>>).find((p) => p.identifier === "a")!
    expect(neverA).toMatchObject({ injection_trigger: ["normal"], condition: "as_user", enabled_here: true })
    expect(load(neverFile).doc).toEqual(never)
    // Switched off here, it stays off there and after a reimport.
    const neverOff = { ...never, order: never.order.map((e) => (e.identifier === "a" ? { ...e, enabled: false } : e)) }
    expect(load(exportStPreset(neverOff)).doc).toEqual(neverOff)
    // An emptied nudge is an empty one in ST.
    const off = exportStPreset({
      ...edited,
      prompts: edited.prompts.map((p) => (p.identifier === "groupNudge" ? { ...p, content: "" } : p))
    })
    expect(off.group_nudge_prompt).toBe("")
  })

  it("reads a preset saved before the end-of-request texts as the import would make it now, without rewriting it", () => {
    const fresh = load(preset({ group_nudge_prompt: "[Only {{char}}.]", impersonation_prompt: "[As {{user}}.]" })).doc
    const moved = new Set(["groupNudge", "impersonationPrompt", "continueNudge", "directionPrompt"])
    const stored = {
      ...fresh,
      prompts: fresh.prompts.filter((p) => !moved.has(p.identifier)),
      order: fresh.order.filter((e) => !moved.has(e.identifier)),
      utility_prompts: {
        ...fresh.utility_prompts,
        group_nudge_prompt: "[Only {{char}}.]",
        impersonation_prompt: "[As {{user}}.]",
        continue_nudge_prompt: CONTINUE_TEXT
      }
    }
    const before = JSON.stringify(stored)
    expect(withEndOfRequest(stored).doc).toEqual(fresh)
    expect(editedDoc("preset", stored)).toEqual(fresh)
    expect(editedDoc("card", stored)).toBe(stored)
    expect(JSON.stringify(stored)).toBe(before)
  })
})

import { validateDoc } from "../src/editing.ts"
import { mainPrompt, presetOrder, withMain } from "../src/presetOrder.ts"
import { editedDoc } from "../src/presetConditions.ts"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { PresetDoc, type PresetPrompt } from "../src/docs/preset.ts"

const prompt = (identifier: string): PresetPrompt => ({
  identifier,
  name: identifier,
  role: "system",
  content: "",
  system_prompt: false,
  marker: false,
  injection_position: "relative",
  injection_depth: 4,
  injection_order: 100,
  injection_trigger: [],
  forbid_overrides: false
})

const doc = {
  schema_version: 1,
  prompts: [prompt("main"), prompt("style")],
  order: [
    { identifier: "main", enabled: true },
    { identifier: "style", enabled: false }
  ],
  samplers: {
    temperature: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
    top_p: 1,
    top_k: 0,
    top_a: 0,
    min_p: 0,
    repetition_penalty: 1,
    openai_max_context: 4095,
    openai_max_tokens: 300,
    max_context_unlocked: false,
    seed: -1,
    n: 1,
    reasoning_effort: "auto",
    verbosity: "auto"
  },
  utility_prompts: {
    impersonation_prompt: "",
    new_chat_prompt: "",
    new_group_chat_prompt: "",
    new_example_chat_prompt: "",
    continue_nudge_prompt: "",
    group_nudge_prompt: "",
    send_if_empty: "",
    wi_format: "{0}",
    scenario_format: "{{scenario}}",
    personality_format: "{{personality}}"
  },
  names_behavior: "default",
  squash: false,
  postprocess: "none",
  use_sysprompt: false,
  prefill: { assistant: "", impersonation: "", continue: false, continue_postfix: " " },
  regex: [],
  regex_approved: false,
  extensions: {},
  unsupported: {}
}

const decode = Schema.decodeUnknownExit(PresetDoc)

describe("PresetDoc", () => {
  it("accepts a well-formed document", () => {
    expect(decode(doc)._tag).toBe("Success")
  })

  it("refuses duplicate prompt identifiers, which the library merge relies on", () => {
    const order = [{ identifier: "main", enabled: true }]
    expect(decode({ ...doc, order })._tag).toBe("Success")
    expect(decode({ ...doc, order, prompts: [prompt("main"), prompt("main")] })._tag).toBe("Failure")
    expect(decode({ ...doc, order: [...doc.order, { identifier: "main", enabled: false }] })._tag).toBe("Failure")
  })

  it("refuses an order entry that names no prompt", () => {
    expect(decode({ ...doc, order: [{ identifier: "missing", enabled: true }] })._tag).toBe("Failure")
  })

  it("refuses an in-chat depth that isn't a non-negative integer", () => {
    expect(decode({ ...doc, prompts: [{ ...prompt("main"), injection_depth: -1 }, prompt("style")] })._tag).toBe(
      "Failure"
    )
  })
})

describe("Main's permanent slot", () => {
  it("adds a missing order entry at the start, off, without changing the prompt", () => {
    const missing = { ...doc, order: [doc.order[1]!] }
    const result = withMain(missing)
    expect(result.order).toEqual([{ identifier: "main", enabled: false }, doc.order[1]])
    expect(result.prompts).toBe(missing.prompts)
    expect(presetOrder(missing.prompts, missing.order)[0]).toEqual({ identifier: "main", enabled: false })
  })

  it("materializes a missing prompt on validation and editor reads of our older documents", () => {
    const missing = { ...doc, prompts: [prompt("style")], order: [doc.order[1]!] }
    const checked = validateDoc("preset", missing)
    expect(checked.ok).toBe(true)
    if (!checked.ok) return
    expect(checked.doc.prompts).toEqual([mainPrompt, prompt("style")])
    expect(checked.doc.order).toEqual([{ identifier: "main", enabled: false }, doc.order[1]])
    const read = editedDoc("preset", missing)
    expect(read.prompts[0]).toEqual(mainPrompt)
    expect(read.order[0]).toEqual({ identifier: "main", enabled: false })
  })

  it("keeps Main's position and switch when reordered or reset", () => {
    for (const enabled of [true, false]) {
      const ordered = { ...doc, order: [doc.order[1]!, { identifier: "main", enabled }] }
      expect(withMain(ordered)).toBe(ordered)
      expect(presetOrder(ordered.prompts, ordered.order).slice(0, 2)).toEqual(ordered.order)
    }
    expect(withMain(withMain({ prompts: [], order: [] }))).toEqual({
      prompts: [mainPrompt],
      order: [{ identifier: "main", enabled: false }]
    })
  })
})

// The reply-section parser (spec/REPLY-SECTIONS.md) on its own: chunks in, the body, the
// sections and the panel's text out, as Generations accumulates them.
import { describe, expect, it } from "@effect/vitest"
import {
  DEFAULT_REPLY_SECTIONS,
  literalPattern,
  originalReply,
  type ReplySections,
  type ReplySectionSettings,
  sectionsDisplay
} from "@rp/shared/replySections.ts"
import type { GenerationChunk } from "../src/chat/Generator.ts"
import { compilePairs, parseReply, settleHeld } from "../src/chat/replySections.ts"

interface Run {
  readonly body: string
  readonly sections: ReplySections | null
  /** The panel's text as its `Section` deltas built it. */
  readonly panel: string
  /** The body after each chunk, to check nothing showed there before it was known. */
  readonly bodies: ReadonlyArray<string>
  /** The panel after each chunk, to check it keeps up with the stream. */
  readonly panels: ReadonlyArray<string>
  readonly reasoning: string
}

const run = (
  chunks: ReadonlyArray<GenerationChunk>,
  options: {
    readonly settings?: ReplySectionSettings
    readonly initial?: { readonly text: string; readonly sections?: ReplySections }
    readonly prefill?: string
    /** Stopped before the end: what's held back is settled as Generations does. */
    readonly stopped?: boolean
  } = {}
): Run => {
  const parse = parseReply(
    compilePairs(options.settings ?? DEFAULT_REPLY_SECTIONS),
    options.initial,
    options.prefill ?? null
  )
  let body = options.initial?.text ?? ""
  let sections: ReplySections | null = options.initial?.sections ?? null
  let panel = sectionsDisplay(sections)
  let reasoning = ""
  let held: { held: string; into: "body" | "section" } | null = null
  const bodies: Array<string> = []
  const panels: Array<string> = []
  const apply = (out: ReadonlyArray<GenerationChunk>) => {
    for (const chunk of out) {
      if (typeof chunk === "string") body += chunk
      else if ("sections" in chunk) {
        sections = chunk.sections
        panel += chunk.text
      } else if ("held" in chunk) held = { ...chunk }
      else reasoning += chunk.reasoning
    }
    bodies.push(body)
    panels.push(panel)
  }
  for (const chunk of chunks) apply(parse.push(chunk))
  if (options.stopped) {
    const settled = settleHeld(body, sections, held)
    return { body: settled.text, sections: settled.sections, panel, bodies, panels, reasoning }
  }
  apply(parse.end())
  return { body, sections, panel, bodies, panels, reasoning }
}

/** Every split of `text` into two chunks, and into single characters. */
const splits = (text: string) => [
  ...Array.from({ length: text.length - 1 }, (_, i) => [text.slice(0, i + 1), text.slice(i + 1)]),
  [...text]
]

describe("reply sections", () => {
  it("takes a leading section in either spelling, closed by either", () => {
    for (const [open, close] of [
      ["<think>", "</think>"],
      ["<thinking>", "</thinking>"],
      ["<thinking>", "</think>"],
      ["<think>", "</thinking>"],
      ["<THINKING>", "</Think>"]
    ]) {
      const text = `\n ${open}\nPlan: keep it short.\n${close}\n\nMira looks up.`
      const result = run([text])
      expect(result.body).toBe("Mira looks up.")
      expect(result.sections).toEqual({
        sections: [{ lead: "\n ", open, text: "\nPlan: keep it short.\n", close }],
        gap: "\n\n"
      })
      expect(result.panel).toBe("\nPlan: keep it short.\n")
      expect(originalReply(result.body, result.sections)).toBe(text)
    }
  })

  it("parses a tag split across deltas anywhere, and never shows the section in the body first", () => {
    const text = "<thinking>Plan.</think>\n\nThe ledger says otherwise."
    for (const chunks of splits(text)) {
      const result = run(chunks)
      expect(result.body).toBe("The ledger says otherwise.")
      expect(result.panel).toBe("Plan.")
      for (const shown of result.bodies) expect("The ledger says otherwise.".startsWith(shown)).toBe(true)
    }
  })

  it("shows a section's text in the panel as it streams, holding back only what may start its closing tag", () => {
    const result = run(["<thinking>Plan", " the scene: the tide", " is late, a < b; </th", "ink>\n\nBody."])
    expect(result.panels).toEqual([
      "Plan",
      "Plan the scene: the tide",
      "Plan the scene: the tide is late, a ",
      "Plan the scene: the tide is late, a < b; ",
      "Plan the scene: the tide is late, a < b; "
    ])
    expect(result.body).toBe("Body.")
    // With `<` in its text, every split still parses, the panel growing only by its own text.
    const text = "<think>a < b, <i>so</i> </thin.</think>\n\nThe ledger <think>stays</think>."
    for (const chunks of splits(text)) {
      const split = run(chunks)
      expect(split.body).toBe("The ledger <think>stays</think>.")
      expect(split.panel).toBe("a < b, <i>so</i> </thin.")
      for (const shown of split.panels) expect(split.panel.startsWith(shown)).toBe(true)
    }
    // A closing pattern with no plain first character: the last 64 characters wait.
    const settings = { enabled: true, pairs: [{ open: "<plan>", close: "(?:END|STOP)" }], send_back: 0 }
    const long = run(["<plan>" + "x".repeat(100), "STOP Body."], { settings })
    expect(long.panels[0]).toBe("x".repeat(36))
    expect(long.panel).toBe("x".repeat(100))
    expect(long.body).toBe("Body.")
  })

  it("takes several leading sections, a blank line apart in the panel", () => {
    const text = "<think>One.</think>\n<thinking>Two.</thinking>\n\nBody <think>kept</think>."
    for (const chunks of [[text], [...text]]) {
      const result = run(chunks)
      expect(result.body).toBe("Body <think>kept</think>.")
      expect(result.sections!.sections.map((s) => s.text)).toEqual(["One.", "Two."])
      expect(result.panel).toBe("One.\n\nTwo.")
      expect(sectionsDisplay(result.sections)).toBe(result.panel)
      expect(originalReply(result.body, result.sections)).toBe(text)
    }
  })

  it("leaves tags later in the text alone", () => {
    for (const text of ["Mira says <think>no</think>.", "*She smiles.*\n<think>later</think>", "  Hello"]) {
      const result = run([...text])
      expect(result.body).toBe(text)
      expect(result.sections).toBe(null)
      expect(result.panel).toBe("")
    }
  })

  it("lets text that can't start a tag through at once", () => {
    const result = run(["*Mira", " looks up.*"])
    expect(result.bodies).toEqual(["*Mira", "*Mira looks up.*", "*Mira looks up.*"])
  })

  it("keeps a section that was never closed in the panel", () => {
    const result = run(["<think>Plan: the tide", " is late, and"])
    expect(result.body).toBe("")
    expect(result.sections).toEqual({
      sections: [{ lead: "", open: "<think>", text: "Plan: the tide is late, and", close: null }],
      gap: ""
    })
    expect(result.panel).toBe("Plan: the tide is late, and")
  })

  it("settles what it held back when the reply stops", () => {
    // Inside the section: the held tail is the section's.
    const inside = run(["<think>Plan: the tide is late"], { stopped: true })
    expect(inside.sections!.sections[0]!.text).toBe("Plan: the tide is late")
    expect(inside.body).toBe("")
    // A tag that may be starting: the body's.
    const lead = run(["<thi"], { stopped: true })
    expect(lead.body).toBe("<thi")
    expect(lead.sections).toBe(null)
  })

  it("resumes inside a section cut off, from the continued version", () => {
    const initial = {
      text: "",
      sections: { sections: [{ lead: "", open: "<thinking>", text: "Plan: the", close: null }], gap: "" }
    }
    const result = run([" tide.</thi", "nk>\n\nMira looks up."], { initial })
    expect(result.body).toBe("Mira looks up.")
    expect(result.sections!.sections).toEqual([
      { lead: "", open: "<thinking>", text: "Plan: the tide.", close: "</think>" }
    ])
    expect(result.panel).toBe("Plan: the tide.")
    // A finished version continues its body.
    const body = run([" <think>x</think>"], {
      initial: {
        text: "Mira",
        sections: { ...initial.sections, sections: [{ ...initial.sections.sections[0]!, close: "</thinking>" }] }
      }
    })
    expect(body.body).toBe("Mira <think>x</think>")
  })

  it("starts inside a section the preset's prefill opens", () => {
    const result = run(["Plan.</think>\nMira looks up."], { prefill: "<thinking>\n" })
    expect(result.body).toBe("Mira looks up.")
    expect(result.sections!.sections).toEqual([
      { lead: "", open: "<thinking>", text: "\nPlan.", close: "</think>", prefilled: 11 }
    ])
    expect(result.panel).toBe("\nPlan.")
  })

  it("passes reasoning through and parses the text beside it", () => {
    const result = run([{ reasoning: "Mira is wary." }, "<think>Plan.", { reasoning: " Short." }, "</think>Hi."])
    expect(result.reasoning).toBe("Mira is wary. Short.")
    expect(result.body).toBe("Hi.")
    expect(result.panel).toBe("Plan.")
  })

  it("uses the pairs it's given: literal, case-sensitive, and none that match nothing", () => {
    const settings: ReplySectionSettings = {
      enabled: true,
      pairs: [
        { open: literalPattern("[plan]"), close: literalPattern("[/plan]"), case_sensitive: true },
        { open: "x*", close: "y" },
        { open: "(", close: ")" }
      ],
      send_back: 0
    }
    expect(compilePairs(settings)).toHaveLength(1)
    expect(run(["[plan]A[/plan]B"], { settings }).body).toBe("B")
    expect(run(["[PLAN]A[/PLAN]B"], { settings }).body).toBe("[PLAN]A[/PLAN]B")
  })
})

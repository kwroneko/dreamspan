// The reply-section parser (spec/REPLY-SECTIONS.md) on its own: chunks in, the body, the
// sections and the panel's text out, as Generations accumulates them.
import { describe, expect, it } from "@effect/vitest"
import {
  DEFAULT_REPLY_SECTIONS,
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
  it("takes a leading section in either spelling, each closed by its own, in any case", () => {
    const either: ReplySectionSettings = {
      enabled: true,
      pairs: [{ open: "<think(?:ing)?>", close: "</think(?:ing)?>", regex: true }],
      send_back: 0
    }
    for (const [open, close, settings] of [
      ["<think>", "</think>", undefined],
      ["<thinking>", "</thinking>", undefined],
      ["<THINKING>", "</Thinking>", undefined],
      // A regex pair, opted into, lets either close either.
      ["<thinking>", "</think>", either],
      ["<think>", "</thinking>", either]
    ] as const) {
      const text = `\n ${open}\nPlan: keep it short.\n${close}\n\nMira looks up.`
      const result = run([text], settings ? { settings } : {})
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
    const text = "<thinking>Plan.</thinking>\n\nThe ledger says otherwise."
    for (const chunks of splits(text)) {
      const result = run(chunks)
      expect(result.body).toBe("The ledger says otherwise.")
      expect(result.panel).toBe("Plan.")
      for (const shown of result.bodies) expect("The ledger says otherwise.".startsWith(shown)).toBe(true)
    }
  })

  it("shows a section's text in the panel as it streams, holding back only what may start its closing tag", () => {
    // A literal closing tag holds back exactly a tail that begins it: `</th`, not `< b`.
    const result = run(["<thinking>Plan", " the scene: the tide", " is late, a < b; </th", "inking>\n\nBody."])
    expect(result.panels).toEqual([
      "Plan",
      "Plan the scene: the tide",
      "Plan the scene: the tide is late, a < b; ",
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
    // A closing regex with no plain first character: the last 64 characters wait.
    const settings = { enabled: true, pairs: [{ open: "<plan>", close: "(?:END|STOP)", regex: true }], send_back: 0 }
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
    const result = run(["Plan.</thinking>\nMira looks up."], { prefill: "<thinking>\n" })
    expect(result.body).toBe("Mira looks up.")
    expect(result.sections!.sections).toEqual([
      { lead: "", open: "<thinking>", text: "\nPlan.", close: "</thinking>", prefilled: 11 }
    ])
    expect(result.panel).toBe("\nPlan.")
  })

  it("passes reasoning through and parses the text beside it", () => {
    const result = run([{ reasoning: "Mira is wary." }, "<think>Plan.", { reasoning: " Short." }, "</think>Hi."])
    expect(result.reasoning).toBe("Mira is wary. Short.")
    expect(result.body).toBe("Hi.")
    expect(result.panel).toBe("Plan.")
  })

  it("uses the pairs it's given: literal, case-sensitive, and no regex that matches nothing", () => {
    const settings: ReplySectionSettings = {
      enabled: true,
      pairs: [
        { open: "[plan]", close: "[/plan]", case_sensitive: true },
        { open: "x*", close: "y", regex: true },
        { open: "(", close: ")", regex: true },
        { open: "", close: "end" }
      ],
      send_back: 0
    }
    expect(compilePairs(settings)).toHaveLength(1)
    expect(run(["[plan]A[/plan]B"], { settings }).body).toBe("B")
    expect(run(["[PLAN]A[/PLAN]B"], { settings }).body).toBe("[PLAN]A[/PLAN]B")
    // As literal text, `x*` and `(` are tags like any other.
    const literal: ReplySectionSettings = {
      enabled: true,
      pairs: [
        { open: "x*", close: "y" },
        { open: "(", close: ")" }
      ],
      send_back: 0
    }
    expect(compilePairs(literal)).toHaveLength(2)
    expect(run(["(aside) Body"], { settings: literal }).body).toBe("Body")
    expect(run(["xxx Body"], { settings: literal }).body).toBe("xxx Body")
  })

  it("matches literal tags with regex metacharacters exactly as written, split anywhere", () => {
    for (const [open, close, decoy] of [
      ["<think|plan>", "</think|plan>", "<think>"],
      ["[plan.*]", "[/plan.*]", "plan"],
      ["{{think}}", "{{/think}}", "{think}"],
      ["\\think/", "\\/think/", "\think/"],
      ["^$(?:a)", "(?:a)$^", "a"],
      ["(+)?", "(-)?", "+"]
    ] as const) {
      const settings: ReplySectionSettings = { enabled: true, pairs: [{ open, close }], send_back: 0 }
      const text = `${open}Plan: a + b? [c] (d)|e.${close}\n\nBody.`
      for (const chunks of splits(text)) {
        const result = run(chunks, { settings })
        expect(result.body).toBe("Body.")
        expect(result.panel).toBe("Plan: a + b? [c] (d)|e.")
        expect(originalReply(result.body, result.sections)).toBe(text)
        for (const shown of result.bodies) expect("Body.".startsWith(shown)).toBe(true)
      }
      // What the tag would mean as a regex doesn't open a section.
      const plain = `${decoy}Body.`
      expect(run([...plain], { settings }).body).toBe(plain)
    }
  })

  it("parses SillyTavern's literal tags with line breaks in them, split anywhere", () => {
    // ST's default prefix and suffix carry a line break; one with two, or starting with one,
    // is held just as well.
    for (const [open, close] of [
      ["<think>\n", "\n</think>"],
      ["<think>\n\n", "\n\n</think>"],
      ["\n<think>", "</think>\n"]
    ] as const) {
      const settings: ReplySectionSettings = {
        enabled: true,
        pairs: [{ open, close, case_sensitive: true }],
        send_back: 0
      }
      const text = `${open}Plan.\nStill plan.${close}\nBody.`
      for (const chunks of splits(text)) {
        const result = run(chunks, { settings })
        expect(result.body).toBe("Body.")
        expect(result.panel).toBe("Plan.\nStill plan.")
      }
    }
  })

  it("parses regex tags split across deltas anywhere", () => {
    const settings: ReplySectionSettings = {
      enabled: true,
      pairs: [{ open: "<(?:plan|scheme)>", close: "</(?:plan|scheme)>", regex: true }],
      send_back: 0
    }
    for (const [open, close] of [
      ["<plan>", "</scheme>"],
      ["<SCHEME>", "</plan>"]
    ] as const) {
      const text = `${open}Go < there.${close}\n\nBody.`
      for (const chunks of splits(text)) {
        const result = run(chunks, { settings })
        expect(result.body).toBe("Body.")
        expect(result.panel).toBe("Go < there.")
        for (const shown of result.panels) expect("Go < there.".startsWith(shown)).toBe(true)
        for (const shown of result.bodies) expect("Body.".startsWith(shown)).toBe(true)
      }
    }
  })

  it("lets a partial tag that stops matching through at once", () => {
    const result = run(["<b", ">Mira</b>"])
    expect(result.bodies).toEqual(["<b", "<b>Mira</b>", "<b>Mira</b>"])
    // While it still may be the opening tag, it waits; once complete, what follows is thinking.
    const thinking = run(["<thi", "nking>Pl", "an"])
    expect(thinking.bodies).toEqual(["", "", "", ""])
    expect(thinking.panels).toEqual(["", "Pl", "Plan", "Plan"])
  })

  it("streamed in any chunks, saves what the whole reply parsed at once does", () => {
    // A small deterministic generator of replies and chunkings (no randomness between runs).
    let seed = 7
    const next = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % n
    }
    const pieces = [
      "<think>",
      "</think>",
      "<thinking>",
      "</thinking>",
      "<",
      "</",
      "thi",
      "nk>",
      " ",
      "\n",
      "Plan.",
      "Mira",
      "a < b"
    ]
    const regexPairs: ReplySectionSettings = {
      enabled: true,
      pairs: [{ open: "<think(?:ing)?>", close: "</think(?:ing)?>", regex: true }],
      send_back: 0
    }
    for (let i = 0; i < 400; i++) {
      const text = Array.from({ length: 1 + next(12) }, () => pieces[next(pieces.length)]).join("")
      const chunks: Array<string> = []
      for (let at = 0; at < text.length;) {
        const size = 1 + next(6)
        chunks.push(text.slice(at, at + size))
        at += size
      }
      for (const settings of [DEFAULT_REPLY_SECTIONS, regexPairs]) {
        const whole = run([text], { settings })
        const streamed = run(chunks, { settings })
        expect(streamed.body).toBe(whole.body)
        expect(streamed.sections).toEqual(whole.sections)
        expect(streamed.panel).toBe(sectionsDisplay(whole.sections))
        expect(originalReply(streamed.body, streamed.sections)).toBe(text)
      }
    }
  })
})

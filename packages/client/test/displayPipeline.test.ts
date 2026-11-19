import { expect, it, vi } from "vitest"
import { Version, type SlotId, type VersionId } from "@dreamspan/shared/chat.ts"
import { DEFAULT_DISPLAY_PREFS } from "@dreamspan/shared/chatApi.ts"
import type { RegexScript } from "@dreamspan/shared/docs/preset.ts"
import { expand } from "@dreamspan/shared/macros/expand.ts"
import { makeMacroRegistry } from "@dreamspan/shared/macros/registry.ts"
import {
  applyDisplayTransforms,
  displayTransforms,
  macroDisplay,
  type DisplayInput
} from "../src/features/chat/displayPipeline.ts"
import { run, OutputLimit } from "@dreamspan/shared/regexReplace.ts"
import { runDisplayRegex } from "../src/features/chat/displayRegex.ts"

const version = new Version({
  id: "v" as VersionId,
  slotId: "s" as SlotId,
  ordinal: 1,
  status: "complete",
  speakerEntityId: null,
  writer: "model",
  content: "Hi {{user}}",
  macroMode: "verbatim",
  origin: "generated",
  sourceVersionId: null,
  direction: null,
  hidden: false,
  starred: false,
  createdAt: 0,
  model: null,
  error: null,
  mark: null,
  frozenMacros: null,
  context: null,
  rowVersion: 0
})
const input: DisplayInput = {
  text: version.content,
  version,
  names: { user: "Ana", char: "Mira" },
  card: {},
  prefs: DEFAULT_DISPLAY_PREFS,
  scripts: [],
  placement: 2,
  depth: 0
}
const script = (fields: Partial<RegexScript> = {}): RegexScript => ({
  id: "r",
  name: "Mask",
  find_regex: "/(Hi) (.*)/g",
  replace_string: "$1 **$2**",
  trim_strings: [],
  placement: [2],
  disabled: false,
  markdown_only: true,
  prompt_only: false,
  run_on_edit: false,
  substitute_regex: "none",
  min_depth: null,
  max_depth: null,
  ...fields
})
const regex = (scripts: ReadonlyArray<RegexScript>, text = "Hi Ana", depth = 0, placement = 2) =>
  runDisplayRegex({ text, scripts, depth, placement, names: input.names, card: {} })

it("output macros require opt-in, human text stays verbatim and assembly never takes the display flag", () => {
  expect(macroDisplay(input).text).toBe(version.content)
  const opted = { ...input, prefs: { ...input.prefs, outputMacros: true } }
  expect(macroDisplay(opted).text).toBe("Hi Ana")
  expect(macroDisplay({ ...opted, version: { ...version, writer: "human" } }).text).toBe(version.content)
  expect(version.content).toBe("Hi {{user}}")
  const limited = macroDisplay({ ...opted, text: "{{space::999999999}}" })
  expect(limited.text).toBe("{{space::999999999}}")
  expect(limited.issues).toEqual([expect.stringContaining("limit reached")])
  const assembled = expand({
    text: version.content,
    origin: { kind: "message", macroMode: "verbatim" },
    purpose: "assembly",
    displayRule: true,
    random: () => 0.5,
    registry: makeMacroRegistry(),
    context: { names: input.names, now: 0, timeZone: "UTC" }
  })
  expect(assembled).toMatchObject({ _tag: "Expanded", text: version.content })
})

it("registered transforms run in order and can be overridden, disabled and restored", async () => {
  const restore = displayTransforms.register({ id: "test.macros", order: 10, transform: macroDisplay })
  const opt = { ...input, prefs: { ...input.prefs, outputMacros: true } }
  try {
    expect((await applyDisplayTransforms(opt)).text).toBe("Hi Ana")
    const undo = displayTransforms.register({
      id: "test.macros",
      order: 10,
      transform: () => ({ text: "plugin", issues: [] })
    })
    expect((await applyDisplayTransforms(opt)).text).toBe("plugin")
    const enable = displayTransforms.disable("test.macros")
    expect((await applyDisplayTransforms(opt)).text).toBe(input.text)
    enable()
    undo()
    expect((await applyDisplayTransforms(opt)).text).toBe("Hi Ana")
  } finally {
    restore()
  }
})

it("display regex respects placement, depth, disabled and display-only flags, captures and trim strings", () => {
  expect(regex([script()]).text).toBe("Hi **Ana**")
  for (const fields of [
    { disabled: true },
    { markdown_only: false },
    { placement: [1] },
    { min_depth: 1 },
    { max_depth: 0, min_depth: 1 }
  ]) {
    expect(regex([script(fields)]).text).toBe("Hi Ana")
  }
  // Both flags: in the prompt and on display, as ST's getRegexedString runs it for either.
  expect(regex([script({ prompt_only: true })]).text).toBe("Hi **Ana**")
  expect(regex([script({ max_depth: 0 })], "Hi Ana", 1).text).toBe("Hi Ana")
  expect(regex([script({ placement: [1], trim_strings: ["A"] })], "Hi Ana", 0, 1).text).toBe("Hi **na**")
  expect(
    regex([script({ find_regex: "/{{user}}/g", substitute_regex: "escaped", replace_string: "{{char}}" })]).text
  ).toBe("Hi Mira")
  expect(
    regex([script({ find_regex: "/{{user}}/", substitute_regex: "escaped", replace_string: "found" })], "Ana", 0).text
  ).toBe("found")
})

it("invalid, excessive and output-amplifying scripts keep safe input with explanations", () => {
  const invalid = regex([script({ find_regex: "[" })])
  expect(invalid.text).toBe("Hi Ana")
  expect(invalid.issues).toHaveLength(1)
  const oversized = regex([script()], "a".repeat(200_001))
  expect(oversized.text).toHaveLength(200_001)
  expect(oversized.issues).toHaveLength(1)
  const bomb = regex([script({ find_regex: "/a/g", replace_string: "x".repeat(100_000) })], "a".repeat(20))
  expect(bomb.text).toBe("a".repeat(20))
  expect(bomb.issues).toHaveLength(1)
  expect(regex(Array.from({ length: 101 }, () => script({ find_regex: "nomatch" }))).issues).toHaveLength(1)
})

it("a regex macro limit skips the script instead of replacing text with an unresolved macro", () => {
  for (const fields of [
    { replace_string: "{{space::999999999}}" },
    { trim_strings: ["{{space::999999999}}"] },
    { find_regex: "{{space::999999999}}", substitute_regex: "raw" as const },
    { find_regex: "{{space::999999999}}", substitute_regex: "escaped" as const }
  ]) {
    expect(regex([script(fields)])).toEqual({ text: "Hi Ana", issues: [expect.stringContaining("limit")] })
  }
})

it("capture amplification is charged before building a replacement", () => {
  expect(() => run(/a+/, "$0".repeat(50_000), [], "a".repeat(50_000), { left: 100_000 })).toThrow(OutputLimit)
})

/** The worker queue as a page starts it: no worker yet, none idle. */
const freshQueue = async () => {
  vi.resetModules()
  return (await import("../src/features/chat/displayWorker.ts")).regexDisplay
}

it("the worker deadline keeps the original and releases the queue for the next message", async () => {
  const regexDisplay = await freshQueue()
  vi.useFakeTimers()
  let started = 0
  const terminate = vi.fn()
  class FakeWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null
    onerror = null
    terminate = terminate
    constructor() {
      started++
      queueMicrotask(() => this.onmessage?.({ data: "ready" }))
    }
    postMessage() {
      if (started > 1) queueMicrotask(() => this.onmessage?.({ data: { text: "second", issues: [] } }))
    }
  }
  vi.stubGlobal("Worker", FakeWorker)
  try {
    const opt = { ...input, prefs: { ...input.prefs, displayRegex: true }, scripts: [script()] }
    expect(regexDisplay(input)).toEqual({ text: input.text, issues: [] })
    const first = regexDisplay(opt)
    const second = regexDisplay(opt)
    await vi.runAllTimersAsync()
    expect(await first).toMatchObject({ text: input.text, issues: [expect.stringContaining("took too long")] })
    expect(await second).toEqual({ text: "second", issues: [] })
    // Only the worker that ran out of time goes; the one that answered takes the next jobs.
    expect(terminate).toHaveBeenCalledTimes(1)
    // A human can write an assistant-side message, and a model can write a user-side turn.
    const humanAssistant = regexDisplay({ ...opt, version: { ...version, writer: "human" } })
    const modelUser = regexDisplay({ ...opt, placement: 1, scripts: [script({ placement: [1] })] })
    await vi.runAllTimersAsync()
    expect(await humanAssistant).toEqual({ text: "second", issues: [] })
    expect(await modelUser).toEqual({ text: "second", issues: [] })
    expect(started).toBe(2)
  } finally {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  }
})

it("a job's deadline starts once its worker has loaded, however long that takes", async () => {
  const regexDisplay = await freshQueue()
  vi.useFakeTimers()
  class SlowStart {
    onmessage: ((event: { data: unknown }) => void) | null = null
    onerror = null
    terminate = vi.fn()
    constructor() {
      // Loads in 3 s (a busy machine), then answers each job at once.
      setTimeout(() => this.onmessage?.({ data: "ready" }), 3000)
    }
    postMessage() {
      queueMicrotask(() => this.onmessage?.({ data: { text: "rewritten", issues: [] } }))
    }
  }
  vi.stubGlobal("Worker", SlowStart)
  try {
    const opt = { ...input, prefs: { ...input.prefs, displayRegex: true }, scripts: [script()] }
    const job = regexDisplay(opt)
    await vi.advanceTimersByTimeAsync(3000)
    expect(await job).toEqual({ text: "rewritten", issues: [] })
  } finally {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  }
})

it("escaped pattern macros quote regex syntax after expanding nested arguments", () => {
  const result = runDisplayRegex({
    text: "A.*(b)",
    scripts: [script({ find_regex: "/{{if::1::{{user}}}}/g", substitute_regex: "escaped", replace_string: "found" })],
    depth: 0,
    placement: 2,
    names: { user: "A.*(b)", char: "Mira" },
    card: {}
  })
  expect(result).toEqual({ text: "found", issues: [] })
})

it("depth-bounded scripts wait for an off-window tip instead of treating it as depth zero", () => {
  const job = {
    text: "Hi Ana",
    scripts: [script({ max_depth: 0 })],
    depth: null,
    placement: 2,
    names: input.names,
    card: {}
  }
  expect(runDisplayRegex(job)).toEqual({ text: "Hi Ana", issues: [expect.stringContaining("waiting")] })
  expect(runDisplayRegex({ ...job, scripts: [script()] })).toEqual({ text: "Hi **Ana**", issues: [] })
})

it("global zero-width Unicode patterns advance over an entire surrogate pair", () => {
  expect(regex([script({ find_regex: "/(?:)/gu", replace_string: "_" })], "😺")).toEqual({ text: "_😺_", issues: [] })
})

it("the display worker queue refuses excess work without starting more workers", async () => {
  const regexDisplay = await freshQueue()
  vi.useFakeTimers()
  let started = 0
  class BusyWorker {
    onmessage = null
    onerror = null
    constructor() {
      started++
    }
    postMessage() {}
    terminate() {}
  }
  vi.stubGlobal("Worker", BusyWorker)
  try {
    const opt = { ...input, prefs: { ...input.prefs, displayRegex: true }, scripts: [script()] }
    const jobs = Array.from({ length: 128 }, () => regexDisplay(opt))
    expect(regexDisplay(opt)).toMatchObject({ text: input.text, issues: [expect.stringContaining("too many")] })
    await vi.runAllTimersAsync()
    await Promise.all(jobs)
    expect(started).toBe(128)
  } finally {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  }
})

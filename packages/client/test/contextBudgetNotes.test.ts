// The budget note, the refusal and a context-length error say where each number comes from
// and offer the action that changes it (owner report 2026-10-31). Synthetic views only.
import type { BudgetOrigins } from "@rp/shared/inspectorApi.ts"
import type { Version } from "@rp/shared/chat.ts"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { registerPresentation } from "../src/features/chat/registerPresentation.tsx"
import { chatComposerNotes, versionFailureActions } from "../src/features/chat/presentation.tsx"
import { messageRows, timelineTransforms } from "../src/features/chat/timelineContributions.tsx"
import type { ChatView } from "../src/features/chat/session.ts"
import { SlotOutlet } from "../src/slots.tsx"

vi.hoisted(() => {
  vi.stubGlobal("location", { protocol: "http:", host: "127.0.0.1" })
})

let disposers: Array<() => void>
beforeEach(() => {
  disposers = registerPresentation()
})
afterEach(() => {
  for (const dispose of disposers.reverse()) dispose()
})

const origins = (patch: Partial<BudgetOrigins>): BudgetOrigins => ({
  context: "assumed",
  reserve: "default",
  target: "default",
  model: { connectionId: "connection-1", modelId: "model-1" },
  ...patch
})

const budget = (o: BudgetOrigins) => ({
  maximum: 128_000,
  target: 102_400,
  responseReserve: 4096,
  nonHistoryTokens: 130_000,
  presetName: "Default (built-in)",
  builtinPreset: true,
  origins: o
})

const note = (o: BudgetOrigins) => {
  const entries = [0, 1].map((depth) => ({ depth, slotId: `slot-${depth}` })) as unknown as ChatView["entries"]
  const view = { entries, history: { budget: budget(o) } } as unknown as ChatView
  const rows = timelineTransforms
    .list()
    .reduce(
      (rows, entry) => entry.transform(rows, { view, lcm: null, summaries: false, divider: -1, historyDivider: 1 }),
      messageRows(entries)
    )
  const row = rows.find((r) => r.key === "history-boundary")!
  return renderToStaticMarkup(createElement(() => row.render({} as never)))
}

it("the history note marks an assumed size and offers to set it", () => {
  const html = note(origins({}))
  expect(html).toContain("allows 128,000 tokens (assumed: nothing reports this model&#x27;s size)")
  expect(html).toContain("reserves 4,096 (default) for the reply")
  expect(html).toContain("Set the context size")
  expect(html).toContain("border-warning")
})

it("the history note names each other source", () => {
  expect(note(origins({ context: "catalog", catalog: "pi-ai's catalog (claude-sonnet-4)" }))).toContain(
    "(from pi-ai&#x27;s catalog (claude-sonnet-4))"
  )
  expect(note(origins({ context: "upstream" }))).toContain("(as the provider reports it)")
  expect(note(origins({ context: "learned" }))).toContain("(learned from the provider&#x27;s error)")
  const own = note(origins({ context: "setting", reserve: "setting", target: "setting" }))
  expect(own).toContain("(the model&#x27;s context size setting)")
  expect(own).toContain("(the model&#x27;s response length)")
  expect(own).toContain("(the model&#x27;s history target)")
  expect(own).toContain("Change the context size")
  // Without a model there's nothing to open.
  expect(note(origins({ model: null }))).not.toContain("context size</button>")
})

it("a budget refusal sits in the composer's column, names its sources and offers the action", () => {
  const view = {
    history: {
      assemblyError: "The full notes, fixed context and response reserve don't fit the maximum context size.",
      assemblyErrorReason: "budget",
      budget: budget(origins({}))
    }
  } as unknown as ChatView
  const html = renderToStaticMarkup(
    createElement(SlotOutlet<{ view: ChatView }>, { slot: chatComposerNotes, props: { view } })
  )
  expect(html).toContain("chat-column")
  // A calm notice in the warning tone, not an error.
  expect(html).toContain("The next reply doesn&#x27;t fit the context size")
  expect(html).toContain("border-warning")
  expect(html).not.toContain("Can&#x27;t prepare")
  expect(html).toContain("take ~130,000 tokens and the reply reserves 4,096 (default): more than the context size")
  expect(html).toContain("context size of 128,000 tokens (assumed: nothing reports this model&#x27;s size)")
  expect(html).toContain("Set the context size")
  // Another refusal has no budget action.
  const other = { history: { ...view.history, assemblyErrorReason: "no_model" } } as unknown as ChatView
  expect(
    renderToStaticMarkup(
      createElement(SlotOutlet<{ view: ChatView }>, { slot: chatComposerNotes, props: { view: other } })
    )
  ).not.toContain("Set the context size")
})

it("a refusal for the newest message never claims the fixed part overflows", () => {
  const view = {
    history: {
      assemblyError:
        "The newest message needs about 31 tokens; the history limit is 0 tokens. Shorten it or increase the context target.",
      assemblyErrorReason: "budget",
      budget: {
        ...budget(origins({ context: "setting", reserve: "setting" })),
        maximum: 4095,
        nonHistoryTokens: 3538,
        responseReserve: 300
      }
    }
  } as unknown as ChatView
  const html = renderToStaticMarkup(
    createElement(SlotOutlet<{ view: ChatView }>, { slot: chatComposerNotes, props: { view } })
  )
  expect(html).toContain("The newest message needs about 31 tokens")
  expect(html).not.toContain("more than the")
  expect(html).toContain(
    "The context size is 4,095 tokens (the model&#x27;s context size setting); the card, prompts and other fixed content take ~3,538 tokens and the reply reserves 300 (the model&#x27;s response length)."
  )
  expect(html).toContain("Change the context size")
})

it("while a refusal shows, the history note doesn't repeat it", () => {
  const entries = [0, 1].map((depth) => ({ depth, slotId: `slot-${depth}` })) as unknown as ChatView["entries"]
  const view = {
    entries,
    history: { budget: budget(origins({})), assemblyError: "x", assemblyErrorReason: "budget" }
  } as unknown as ChatView
  const rows = timelineTransforms
    .list()
    .reduce(
      (rows, entry) => entry.transform(rows, { view, lcm: null, summaries: false, divider: -1, historyDivider: 1 }),
      messageRows(entries)
    )
  expect(rows.find((r) => r.key === "history-boundary")).toBeUndefined()
})

it("a context-length error that states a limit offers to save it", () => {
  const version = {
    error: {
      class: "context_overflow",
      message: "This model's maximum context length is 100000 tokens.",
      contextLimit: { tokens: 100_000, modelId: "model-1" }
    }
  } as unknown as Version
  const html = renderToStaticMarkup(
    createElement(SlotOutlet<{ version: Version }>, { slot: versionFailureActions, props: { version } })
  )
  expect(html).toContain("Save 100,000 as its context size")
  const plain = { error: { class: "bad_request", message: "no" } } as unknown as Version
  expect(
    renderToStaticMarkup(
      createElement(SlotOutlet<{ version: Version }>, { slot: versionFailureActions, props: { version: plain } })
    )
  ).toBe("")
})

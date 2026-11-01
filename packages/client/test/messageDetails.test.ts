// Message details and model marks (msgmeta): what's registered where, which lab's mark a
// model gets, and how a message's time reads.
import { DEFAULT_DISPLAY_PREFS, type DisplayPrefs } from "@rp/shared/chatApi.ts"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  formatMessageTime,
  messageDetails,
  registerMessageDetails,
  useMessageDetails
} from "../src/features/chat/messageDetails.tsx"
import { markFor, modelMarks, registerModelMarks } from "../src/features/chat/modelMarks.tsx"

const viewer = vi.hoisted(() => ({ prefs: null as DisplayPrefs | null }))
vi.mock("../src/ui/viewPrefs.ts", () => ({
  useViewPrefs: () => ({ prefs: viewer.prefs ?? DEFAULT_DISPLAY_PREFS })
}))

let dispose: Array<() => void> = []
afterEach(() => {
  for (const close of dispose) close()
  dispose = []
})

describe("message details", () => {
  it("registers the time and model in the header and the number under the portrait", () => {
    dispose = registerMessageDetails()
    expect([...messageDetails.snapshot().entries].map((entry) => [entry.id, entry.place])).toEqual([
      ["message.time", "header"],
      ["message.model-icon", "header"],
      ["message.model", "header"],
      ["message.number", "portrait"]
    ])
    // Each has a name and a description for its switch in the Display settings.
    expect(messageDetails.list().every((entry) => entry.label !== "" && entry.description !== "")).toBe(true)
  })

  it("leaves out the details the user turned off, by id, a plugin's too", () => {
    dispose = [
      ...registerMessageDetails(),
      messageDetails.register({
        id: "plugin.mood",
        place: "portrait",
        order: 5,
        label: "Mood",
        description: "The speaker's mood.",
        component: () => null
      })
    ]
    const shown = () => {
      let ids: Array<string> = []
      renderToStaticMarkup(
        createElement(() => {
          const { header, portrait } = useMessageDetails()
          ids = [...header, ...portrait].map((detail) => detail.id)
          return null
        })
      )
      return ids
    }
    expect(shown()).toEqual(["message.time", "message.model-icon", "message.model", "plugin.mood", "message.number"])
    viewer.prefs = { ...DEFAULT_DISPLAY_PREFS, messageDetails: { "message.model-icon": false, "plugin.mood": false } }
    expect(shown()).toEqual(["message.time", "message.model", "message.number"])
    viewer.prefs = null
  })

  it("reads the time first, with the date only when it isn't today", () => {
    const now = new Date(2026, 10, 1, 18, 0).getTime()
    const today = new Date(2026, 10, 1, 14, 32).getTime()
    const thisYear = new Date(2026, 2, 4, 9, 5).getTime()
    const before = new Date(2025, 2, 4, 9, 5).getTime()
    const time = (at: number) => new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(at)
    expect(formatMessageTime(today, now)).toBe(time(today))
    expect(formatMessageTime(thisYear, now)).toMatch(new RegExp(`, ${time(thisYear)}$`))
    expect(formatMessageTime(thisYear, now)).not.toMatch(/2026/)
    expect(formatMessageTime(before, now)).toMatch(/2025/)
  })
})

describe("model marks", () => {
  const mark = (provider: string, model: string) => markFor(modelMarks.list(), { provider, model })?.id

  it("names the lab from the model's key first, then from the provider", () => {
    dispose = registerModelMarks()
    expect(mark("openrouter", "anthropic/claude-3.5-sonnet")).toBe("anthropic")
    expect(mark("openrouter", "meta-llama/llama-3.1-405b-instruct")).toBe("meta")
    expect(mark("openrouter", "some-lab/unknown-model")).toBe("openrouter")
    expect(mark("claude", "claude-3-opus-20240229")).toBe("anthropic")
    expect(mark("openai", "gpt-4o")).toBe("openai")
    expect(mark("openai-chat", "o3-mini")).toBe("openai")
    expect(mark("makersuite", "gemini-2.5-pro")).toBe("google")
    expect(mark("deepseek", "deepseek-reasoner")).toBe("deepseek")
    expect(mark("mistralai", "mistral-large-latest")).toBe("mistral")
    expect(mark("xai", "grok-4")).toBe("xai")
    expect(mark("openrouter", "qwen/qwen3-235b-a22b")).toBe("qwen")
    expect(mark("cohere", "command-r-plus")).toBe("cohere")
    expect(mark("openrouter", "moonshotai/kimi-k2")).toBe("moonshot")
    // A local server with a model no rule names: the generic mark.
    expect(mark("koboldcpp", "Midnight-Rose-70B")).toBeUndefined()
    expect(mark("openai-chat", "")).toBeUndefined()
    expect(mark("deepseek", "")).toBe("deepseek")
  })

  it("lets a plugin add a lab ahead of the built-in rules, and undo it", () => {
    dispose = registerModelMarks()
    const undo = modelMarks.register({
      id: "plugin.nous",
      label: "Nous Research",
      order: 1,
      models: /hermes/,
      component: () => null
    })
    expect(mark("openrouter", "nousresearch/hermes-3-llama-3.1-405b")).toBe("plugin.nous")
    undo()
    expect(mark("openrouter", "nousresearch/hermes-3-llama-3.1-405b")).toBe("meta")
  })
})

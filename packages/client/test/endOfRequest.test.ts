// The preset editor's End of request section and its warning (DESIGN §2.2, owner 2026-10-29):
// three fixed texts outside the prompt order, and a warning when the direction text would
// lose the direction.
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import type { FieldPath } from "@rp/shared/editing.ts"
import type { PresetPrompt } from "@rp/shared/docs/preset.ts"
import { DIRECTION_TEXT, TURN_TEXT } from "@rp/shared/endOfRequest.ts"
import type { EditorStore } from "../src/features/editor/store.ts"

vi.hoisted(() => {
  vi.stubGlobal("location", { protocol: "http:", host: "127.0.0.1" })
})
// The fields' own editor is tested elsewhere: here, which fields the section has, at which paths.
vi.mock("../src/features/editor/controls.tsx", () => ({
  TextField: ({ store, path, label }: { store: EditorStore; path: FieldPath; label: string }) =>
    createElement("label", { "data-path": path.join("/") }, label, createElement("textarea", null, store.text(path)))
}))

// Server rendering has no subscriptions: the hooks read the store directly.
vi.mock("../src/features/editor/store.ts", async (original) => ({
  ...(await original<typeof import("../src/features/editor/store.ts")>()),
  useValue: (store: EditorStore, path: FieldPath) => store.value(path),
  useText: (store: EditorStore, path: FieldPath) => store.text(path)
}))

const { EndOfRequest } = await import("../src/features/editor/EndOfRequest.tsx")
const { PresetWarnings } = await import("../src/features/editor/PromptDocument.tsx")

const prompt = (identifier: string, content: string): PresetPrompt => ({
  identifier,
  name: identifier,
  role: "user",
  content,
  system_prompt: false,
  marker: false,
  injection_position: "relative",
  injection_depth: 4,
  injection_order: 100,
  injection_trigger: [],
  forbid_overrides: false
})

/** The store reads the section and the warning use, over one document. */
const storeOf = (prompts: ReadonlyArray<PresetPrompt>) => {
  const doc = { prompts, order: [] }
  const at = (path: FieldPath): unknown => {
    let value: unknown = doc
    for (const key of path) {
      const match = typeof key === "string" ? /^identifier=(.*)$/.exec(key) : null
      value = match
        ? (value as ReadonlyArray<PresetPrompt>).find((p) => p.identifier === match[1])
        : (value as Record<string | number, unknown> | undefined)?.[key]
    }
    return value
  }
  return {
    snapshot: { ref: { kind: "preset" } },
    subscribe: () => () => () => {},
    value: at,
    text: (path: FieldPath) => String(at(path) ?? "")
  } as unknown as EditorStore
}

const defaults = [
  prompt("main", "Write."),
  prompt("groupNudge", TURN_TEXT),
  prompt("impersonationPrompt", "[As {{speaker}}.]"),
  prompt("directionPrompt", DIRECTION_TEXT)
]

describe("the End of request section", () => {
  it("shows the three texts, labelled, each with when it's sent, and nothing to move, delete or condition", () => {
    const html = renderToStaticMarkup(createElement(EndOfRequest, { store: storeOf(defaults) }))
    expect(html).toContain("End of request")
    const fields = [...html.matchAll(/data-path="([^"]+)">([^<]+)</g)].map((m) => [m[1], m[2]])
    expect(fields).toEqual([
      ["prompts/identifier=groupNudge/content", "When a character speaks"],
      ["prompts/identifier=impersonationPrompt/content", "When your card speaks"],
      ["prompts/identifier=directionPrompt/content", "When you give a direction (added after the turn text)"]
    ])
    expect(html).toContain("[As {{speaker}}.]")
    expect(html).toContain("Sent last when the model writes as a card you don&#x27;t play.")
    expect(html).toContain("Sent last instead when the model writes as a card you play.")
    expect(html).toContain("Sent on a new line after the turn text when you give a direction")
    for (const control of ["Delete", "Condition", "Generation types", 'role="switch"', "Drag"])
      expect(html).not.toContain(control)
  })
})

describe("the preset warnings", () => {
  it("say nothing while the direction text reads {{direction}}", () => {
    expect(renderToStaticMarkup(createElement(PresetWarnings, { store: storeOf(defaults) }))).toBe("")
  })

  it("warn when the direction text would lose the direction, with a link to it", () => {
    const lost = defaults.map((p) => (p.identifier === "directionPrompt" ? { ...p, content: "[Next.]" } : p))
    const html = renderToStaticMarkup(createElement(PresetWarnings, { store: storeOf(lost) }))
    expect(html).toContain('role="alert"')
    expect(html).toContain("doesn&#x27;t contain {{direction}}")
    expect(html).toContain("Go to the text")
  })
})

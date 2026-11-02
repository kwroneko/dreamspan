// The preset editor's End of request section and its warning (DESIGN §2.2, owner 2026-10-29):
// four fixed texts outside the prompt order, and a warning when the direction text would
// lose the direction.
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import type { FieldPath } from "@rp/shared/editing.ts"
import type { PresetPrompt } from "@rp/shared/docs/preset.ts"
import { CONTINUE_TEXT, DIRECTION_TEXT, TURN_TEXT } from "@rp/shared/endOfRequest.ts"
import type { EditorStore } from "../src/features/editor/store.ts"

vi.hoisted(() => {
  vi.stubGlobal("location", { protocol: "http:", host: "127.0.0.1" })
})
// The fields' own editor is tested elsewhere: here, which fields the section has, at which paths.
vi.mock("../src/features/editor/controls.tsx", () => ({
  NumberField: () => null,
  SelectField: () => null,
  SwitchField: () => null,
  TextField: ({ store, path, label, about }: { store: EditorStore; path: FieldPath; label: string; about?: string }) =>
    createElement(
      "label",
      { "data-path": path.join("/") },
      label,
      createElement("textarea", null, store.text(path)),
      createElement("span", { hidden: true }, about)
    )
}))

// Server rendering has no subscriptions: the hooks read the store directly.
vi.mock("../src/features/editor/store.ts", async (original) => ({
  ...(await original<typeof import("../src/features/editor/store.ts")>()),
  useValue: (store: EditorStore, path: FieldPath) => store.value(path),
  useText: (store: EditorStore, path: FieldPath) => store.text(path),
  useEditorState: (store: EditorStore) => ({ snapshot: store.snapshot })
}))

// Render the editor's actual warning host without mounting the unrelated prompt fields.
vi.mock("../src/features/editor/PromptDocument.tsx", async (original) => ({
  ...(await original<typeof import("../src/features/editor/PromptDocument.tsx")>()),
  PromptDocument: () => null
}))

const { EndOfRequest } = await import("../src/features/editor/EndOfRequest.tsx")
const { PresetWarnings, registerPresetWarnings } = await import("../src/features/editor/PromptDocument.tsx")
const { PresetEditor } = await import("../src/features/editor/PresetEditor.tsx")
const { presetEditorWarnings } = await import("../src/features/editor/presetSections.ts")

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
const storeOf = (
  prompts: ReadonlyArray<PresetPrompt>,
  order: ReadonlyArray<{ identifier: string; enabled: boolean }> = []
) => {
  const doc = { prompts, order }
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
    snapshot: { ref: { kind: "preset" }, doc },
    subscribe: () => () => () => {},
    value: at,
    text: (path: FieldPath) => String(at(path) ?? "")
  } as unknown as EditorStore
}

const defaults = [
  prompt("main", "Write."),
  prompt("groupNudge", TURN_TEXT),
  prompt("impersonationPrompt", "[As {{speaker}}.]"),
  prompt("continueNudge", CONTINUE_TEXT),
  prompt("directionPrompt", DIRECTION_TEXT)
]

describe("the End of request section", () => {
  it("shows the four labelled texts with help, and nothing to move, delete or condition", () => {
    const html = renderToStaticMarkup(createElement(EndOfRequest, { store: storeOf(defaults) }))
    expect(html).toContain("End of request")
    const fields = [...html.matchAll(/data-path="([^"]+)">([^<]+)</g)].map((m) => [m[1], m[2]])
    expect(fields).toEqual([
      ["prompts/identifier=groupNudge/content", "When a character speaks"],
      ["prompts/identifier=impersonationPrompt/content", "When your card speaks"],
      ["prompts/identifier=continueNudge/content", "When you continue a reply"],
      ["prompts/identifier=directionPrompt/content", "When you give guidance"]
    ])
    expect(html).toContain("[As {{speaker}}.]")
    expect(html).toContain("Tell the model how to write a character you don’t play.")
    expect(html).toContain("Tell the model how to write a character you play.")
    expect(html).toContain("Ask the model to carry on from the reply so far, when it can’t use a prefill.")
    expect(html).toContain("Guide what happens next.")
    for (const control of ["Delete", "Condition", "Generation types", 'role="switch"', "Drag"])
      expect(html).not.toContain(control)
  })
})

describe("the preset warnings", () => {
  const onGoTo = () => {}

  it("the mounted editor renders registered warnings, scoped replacements, additions and disablement", () => {
    const lost = defaults.map((p) => (p.identifier === "directionPrompt" ? { ...p, content: "[Next.]" } : p))
    const store = storeOf(lost)
    const render = () => renderToStaticMarkup(createElement(PresetEditor, { store, call: vi.fn() }))
    const builtIn = registerPresetWarnings()
    const added = presetEditorWarnings.register({
      id: "synthetic.warning",
      order: 200,
      component: () => createElement("p", null, "Additional warning")
    })
    try {
      expect(render()).toContain("doesn&#x27;t contain {{direction}}")
      expect(render()).toContain("Additional warning")
      const replacement = presetEditorWarnings.register({
        id: "preset.warnings",
        order: 100,
        component: () => createElement("p", null, "Replacement warning")
      })
      try {
        expect(render()).toContain("Replacement warning")
        expect(render()).not.toContain("doesn&#x27;t contain {{direction}}")
        const disabled = presetEditorWarnings.disable("preset.warnings")
        try {
          expect(render()).not.toContain("Replacement warning")
          expect(render()).toContain("Additional warning")
        } finally {
          disabled()
        }
      } finally {
        replacement()
      }
      expect(render()).toContain("doesn&#x27;t contain {{direction}}")
    } finally {
      added()
      builtIn()
    }
    expect(render()).not.toContain("Preset warnings")
  })

  it("say nothing while the direction text reads {{direction}}", () => {
    expect(renderToStaticMarkup(createElement(PresetWarnings, { store: storeOf(defaults), onGoTo }))).toBe("")
  })

  it("reads the field's current draft instead of the saved prompts array", () => {
    const store = storeOf(defaults)
    const saved = store.text.bind(store)
    store.text = (path) => (path[1] === "identifier=directionPrompt" ? "[Next.]" : saved(path))
    const changed = renderToStaticMarkup(createElement(PresetWarnings, { store, onGoTo }))
    expect(changed).toContain("doesn&#x27;t contain {{direction}}")
    // Restoring the macro clears the warning without a revision save or structural change.
    store.text = saved
    expect(renderToStaticMarkup(createElement(PresetWarnings, { store, onGoTo }))).toBe("")
  })

  it("warn when the direction text would lose the direction, with a link to it", () => {
    const lost = defaults.map((p) => (p.identifier === "directionPrompt" ? { ...p, content: "[Next.]" } : p))
    const html = renderToStaticMarkup(createElement(PresetWarnings, { store: storeOf(lost), onGoTo }))
    expect(html).toContain('role="alert"')
    expect(html).toContain("doesn&#x27;t contain {{direction}}")
    expect(html).toContain("Go to the text")
  })

  it("name a switched-on prompt whose condition and generation types never meet, with a link to it", () => {
    const never = { ...prompt("asCard", "[Stay in voice.]"), name: "As your card", condition: "as_user" as const }
    const prompts = [...defaults, { ...never, injection_trigger: ["normal"] }]
    const on = [
      { identifier: "main", enabled: true },
      { identifier: "asCard", enabled: true }
    ]
    const html = renderToStaticMarkup(createElement(PresetWarnings, { store: storeOf(prompts, on), onGoTo }))
    expect(html).toContain("“As your card” is never sent")
    expect(html).toContain("only for Normal")
    expect(html).toContain("Go to the prompt")
    // Switched off, or with a generation type the condition meets, it says nothing.
    const off = on.map((e) => ({ ...e, enabled: e.identifier !== "asCard" }))
    expect(renderToStaticMarkup(createElement(PresetWarnings, { store: storeOf(prompts, off), onGoTo }))).toBe("")
    const meets = [...defaults, { ...never, injection_trigger: ["normal", "impersonate"] }]
    expect(renderToStaticMarkup(createElement(PresetWarnings, { store: storeOf(meets, on), onGoTo }))).toBe("")
  })
})

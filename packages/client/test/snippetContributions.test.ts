import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { register } from "../src/features/snippets/index.tsx"
import { chatPanels } from "../src/features/chat/panels.tsx"
import { chatSurfaceProviders } from "../src/features/chat/presentation.tsx"
import { appTools } from "../src/features/shell.tsx"
import { editorTextActions, textActions } from "../src/textActions.tsx"
vi.hoisted(() => {
  vi.stubGlobal("location", { protocol: "http:", host: "127.0.0.1" })
})
let dispose: Array<() => void>
beforeEach(() => {
  dispose = register()
})
afterEach(() => {
  for (const close of dispose.reverse()) close()
})
it("registers the workspace, panel and transfers as individually replaceable contributions", () => {
  expect(appTools.get("snippets.tools")).toBeDefined()
  expect(chatSurfaceProviders.get("snippets.scope")).toBeDefined()
  expect(chatPanels.get("snippets")!.label).toBe("Snippets")
  const send = textActions.get("snippets.send")!
  expect(send.available({ text: "A synthetic passage" })).toBe(true)
  expect(send.available({ text: "" })).toBe(false)
  const disable = chatPanels.disable("snippets")
  expect(send.available({ text: "A synthetic passage" })).toBe(false)
  disable()
  // Editors offer the whole text's send, and the selection's only while there is one; never in a snippet's own editor.
  const offered = (selection: string, source?: "snippet") =>
    editorTextActions(textActions.snapshot().entries, "Whole text", selection, source).map(({ action, context }) => [
      action.id,
      context.text
    ])
  expect(offered("")).toEqual([["snippets.send-text", "Whole text"]])
  expect(offered("text")).toEqual([
    ["snippets.send-text", "Whole text"],
    ["snippets.send", "text"]
  ])
  expect(offered("text", "snippet")).toEqual([])
  // No Insert (owner, 2026-11-01: copy and paste); a plugin can still replace a transfer.
  expect(textActions.get("snippets.insert")).toBeUndefined()
  const original = textActions.get("snippets.send")!
  const replacement = vi.fn()
  const undo = textActions.register({ ...original, label: "Plugin send", available: () => true, run: replacement })
  textActions.get("snippets.send")!.run({ text: "Selected" })
  expect(replacement).toHaveBeenCalledWith({ text: "Selected" })
  expect(textActions.get("snippets.send")!.label).toBe("Plugin send")
  undo()
  expect(textActions.get("snippets.send")).toBe(original)
})

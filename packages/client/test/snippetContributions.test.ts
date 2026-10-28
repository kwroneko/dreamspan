import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { register } from "../src/features/snippets/index.tsx"
import { chatPanels } from "../src/features/chat/panels.tsx"
import { chatSurfaceProviders } from "../src/features/chat/presentation.tsx"
import { appTools } from "../src/features/shell.tsx"
import { textActions } from "../src/textActions.tsx"
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
  const original = textActions.get("snippets.insert")!
  const replacement = vi.fn()
  const undo = textActions.register({ ...original, label: "Plugin insertion", available: () => true, run: replacement })
  textActions.get("snippets.insert")!.run({ text: "Selected", source: "snippet" })
  expect(replacement).toHaveBeenCalledWith({ text: "Selected", source: "snippet" })
  expect(textActions.get("snippets.insert")!.label).toBe("Plugin insertion")
  undo()
  expect(textActions.get("snippets.insert")).toBe(original)
})

import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, expect, it, vi } from "vitest"
import { DEFAULT_DISPLAY_PREFS } from "@dreamspan/shared/chatApi.ts"
import { MessageColorSettings } from "../src/features/chat/MessageColors.tsx"

const state = vi.hoisted(() => ({ viewer: vi.fn() }))
vi.mock("../src/ui/viewPrefs.ts", () => ({ useViewPrefs: state.viewer }))
vi.mock("../src/ui/messageColors.ts", async (original) => ({
  ...(await original<object>()),
  useMessageColorDefault: () => "#303039"
}))
beforeEach(() =>
  state.viewer.mockReturnValue({
    prefs: DEFAULT_DISPLAY_PREFS,
    ready: true,
    pending: false,
    error: null,
    change: vi.fn()
  })
)
const render = () => renderToStaticMarkup(createElement(MessageColorSettings))

it("renders four labelled colour inputs and an individual reset for each account choice", () => {
  const html = render()
  for (const label of ["Main text", "Italics", "Underline", "Quote"]) {
    expect(html).toContain(`${label} colour`)
    expect(html).toContain(`aria-label="Reset ${label.toLowerCase()} colour"`)
  }
  expect(html.match(/type="color"/g)).toHaveLength(4)
  expect(html.match(/value="#303039"/g)).toHaveLength(4)
})
it("shows account overrides and save failures, and disables controls during a write", () => {
  state.viewer.mockReturnValue({
    prefs: { ...DEFAULT_DISPLAY_PREFS, quoteTextColor: "#123456" },
    ready: true,
    pending: true,
    error: { message: "Save failed" }
  })
  const html = render()
  expect(html).toContain('value="#123456"')
  expect(html).toContain('role="alert"')
  expect(html).toContain("Save failed")
  expect(html.match(/ disabled=""/g)).toHaveLength(8)
})

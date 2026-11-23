import type { KeyboardEvent } from "react"
import { expect, it, vi } from "vitest"
import { composerKeyDown, composerSubmitKey } from "../src/features/chat/composerKeys.ts"

const event = (patch: object = {}) =>
  ({
    key: "Enter",
    altKey: false,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    nativeEvent: { isComposing: false },
    preventDefault: vi.fn(),
    ...patch
  }) as unknown as KeyboardEvent<HTMLTextAreaElement>

it("excludes Alt+Enter, modifiers with Alt, Shift+Enter and composition from sending", () => {
  const send = vi.fn()
  for (const patch of [
    { altKey: true },
    { altKey: true, ctrlKey: true },
    { shiftKey: true },
    { nativeEvent: { isComposing: true } }
  ]) {
    const key = event(patch)
    composerKeyDown(send)(key)
    expect(key.preventDefault).not.toHaveBeenCalled()
  }
  expect(send).not.toHaveBeenCalled()
  const key = event()
  composerKeyDown(send)(key)
  expect(send).toHaveBeenCalledOnce()
  expect(key.preventDefault).toHaveBeenCalledOnce()
})

it("applies all account modes on desktop and touch, with a send chord and newline escape", () => {
  for (const coarse of [false, true]) {
    vi.stubGlobal("matchMedia", () => ({ matches: coarse }))
    for (const mode of ["automatic", "always", "never"] as const) {
      const send = vi.fn()
      const key = event()
      composerKeyDown(send, mode)(key)
      expect(send).toHaveBeenCalledTimes(Number(mode === "always" || (mode === "automatic" && !coarse)))
      const before = send.mock.calls.length
      composerKeyDown(send, mode)(event({ shiftKey: true }))
      expect(send).toHaveBeenCalledTimes(before)
      composerKeyDown(send, mode)(event({ ctrlKey: true }))
      composerKeyDown(send, mode)(event({ metaKey: true }))
      expect(send).toHaveBeenCalledTimes(before + 2)
      composerKeyDown(send, mode)(event({ altKey: true }))
      composerKeyDown(send, mode)(event({ nativeEvent: { isComposing: true } }))
      expect(send).toHaveBeenCalledTimes(before + 2)
    }
  }
  vi.unstubAllGlobals()
})

it("names the key that submits, for the end of its button's hover, never Shift+Enter", () => {
  for (const coarse of [false, true]) {
    vi.stubGlobal("matchMedia", () => ({ matches: coarse }))
    expect(composerSubmitKey("always")).toBe("Enter")
    expect(composerSubmitKey("never")).toBe("Ctrl/Cmd+Enter")
    expect(composerSubmitKey("automatic")).toBe(coarse ? "Ctrl/Cmd+Enter" : "Enter")
  }
  vi.unstubAllGlobals()
})

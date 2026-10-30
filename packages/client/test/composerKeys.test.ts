import type { KeyboardEvent } from "react"
import { expect, it, vi } from "vitest"
import { composerKeyDown } from "../src/features/chat/composerKeys.ts"

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

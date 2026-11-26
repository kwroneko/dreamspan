// @vitest-environment jsdom
import { act, createElement, useState } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import { AUTO_OPEN, useAutoOpen } from "../src/features/chat/autoOpen.ts"

function Disclosure({ enabled }: { enabled: boolean }) {
  const [chosen, setChosen] = useState<boolean>()
  const automatic = useAutoOpen(true, true, enabled)
  return createElement("button", { onClick: () => setChosen(true) }, String(chosen ?? automatic))
}

it("clears automatic openness when disabled during streaming and preserves a manual choice", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  vi.useFakeTimers()
  const host = document.createElement("div")
  const root = createRoot(host)
  const render = (enabled: boolean) => act(() => root.render(createElement(Disclosure, { enabled })))
  const waitToOpen = () => act(() => void vi.advanceTimersByTime(AUTO_OPEN.afterMs))
  try {
    render(true)
    waitToOpen()
    expect(host.textContent).toBe("true")
    render(false)
    expect(host.textContent).toBe("false")

    render(true)
    expect(host.textContent).toBe("false")
    act(() => host.querySelector("button")!.click())
    waitToOpen()
    render(false)
    expect(host.textContent).toBe("true")
  } finally {
    act(() => root.unmount())
    vi.useRealTimers()
    vi.unstubAllGlobals()
  }
})

// A lazy chat-panel tab whose code is loaded mounts its content at once (night/tabperf): through
// React.lazy every first visit showed the fallback, which React keeps on screen for at least
// 300 ms, however fast the code and the tab's data came.
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { lazyPanel, type PanelProps, preloadPanel } from "../src/features/chat/panels.tsx"

const props = {} as PanelProps

describe("lazyPanel", () => {
  it("shows the fallback until its code is loaded, then its content with no fallback", async () => {
    let loads = 0
    const Panel = lazyPanel(async () => {
      loads++
      return { default: () => createElement("p", null, "The model tab") }
    }, "model")
    expect(renderToStaticMarkup(createElement(Panel, props))).toContain("Loading the model…")
    preloadPanel(Panel)
    await new Promise((done) => setTimeout(done, 0))
    const html = renderToStaticMarkup(createElement(Panel, props))
    expect(html).toContain("The model tab")
    expect(html).not.toContain("Loading the model…")
    // One load, whoever asked: the first render's and the preload's.
    expect(loads).toBe(1)
  })

  it("loads again after a failed load", async () => {
    let attempt = 0
    const Panel = lazyPanel(async () => {
      if (++attempt === 1) throw new Error("offline")
      return { default: () => createElement("p", null, "Loaded") }
    }, "notes")
    preloadPanel(Panel)
    await new Promise((done) => setTimeout(done, 0))
    preloadPanel(Panel)
    await new Promise((done) => setTimeout(done, 0))
    expect(attempt).toBe(2)
    expect(renderToStaticMarkup(createElement(Panel, props))).toContain("Loaded")
  })

  it("leaves a component that isn't lazy alone", () => {
    expect(() => preloadPanel(() => null)).not.toThrow()
  })
})

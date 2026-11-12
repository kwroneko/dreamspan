// @vitest-environment jsdom
import { act, createElement, useEffect } from "react"
import { createRoot } from "react-dom/client"
import { expect, it } from "vitest"
import { Markdown, messageRenderers, type MessageTextProps } from "../src/ui/Markdown.tsx"

it("contains renderer and effect failures to one body, with inert plain text and recovery", async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const host = document.createElement("div")
  document.body.append(host)
  const errors: unknown[] = []
  const root = createRoot(host, { onCaughtError: (error) => errors.push(error) })
  const hostile = '<img src="/should-not-load" onerror="alert(1)">'
  const render = (text: string) =>
    act(async () => {
      root.render(
        createElement(
          "main",
          null,
          createElement(Markdown, { text, streaming: false }),
          createElement(Markdown, { text: "Neighbour", streaming: false })
        )
      )
    })
  const dispose = messageRenderers.register({
    id: "synthetic-failure",
    order: 100,
    component: function SyntheticRenderer({ text }: MessageTextProps) {
      useEffect(() => {
        if (text === "Effect failure") throw new Error("synthetic effect failure")
      }, [text])
      if (text === hostile) throw new Error("synthetic render failure")
      return createElement("strong", null, text)
    }
  })
  let restore: (() => void) | undefined
  try {
    await render(hostile)
    expect(host.querySelector(".markdown")?.textContent).toBe(hostile)
    expect(host.querySelector("img")).toBeNull()
    expect(host.querySelector("strong")?.textContent).toBe("Neighbour")
    expect(JSON.parse(host.querySelector("[data-source-map]")!.getAttribute("data-source-map")!)).toEqual({
      chars: 0,
      length: hostile.length,
      start: 0,
      end: hostile.length
    })
    await render("Recovered")
    expect([...host.querySelectorAll("strong")].map((element) => element.textContent)).toEqual([
      "Recovered",
      "Neighbour"
    ])
    await render("Effect failure")
    expect(host.querySelector(".markdown")?.textContent).toBe("Effect failure")
    expect(host.querySelector("strong")?.textContent).toBe("Neighbour")
    await act(async () => {
      restore = messageRenderers.register({
        id: "synthetic-failure",
        order: 100,
        component: ({ text }) => createElement("em", null, text)
      })
    })
    expect([...host.querySelectorAll("em")].map((element) => element.textContent)).toEqual([
      "Effect failure",
      "Neighbour"
    ])
    expect(errors).toHaveLength(2)
  } finally {
    await act(async () => root.unmount())
    restore?.()
    dispose()
    host.remove()
  }
})

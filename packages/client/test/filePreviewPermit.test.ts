// @vitest-environment jsdom
// A file's HTML or Markdown preview (spec/FILES-AND-ENVIRONMENT.md §8.2) never takes a message's
// panel permit (review files4b finding 7): opened from a message whose sources allow scripts and
// the internet, its document frame still loads with scripts off. Synthetic text only.
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { afterAll, beforeAll, expect, it } from "vitest"
import { HtmlPreview, MarkdownPreview } from "../src/features/files/TextViewer.tsx"
import { messageRenderers } from "../src/ui/Markdown.tsx"
import { StMarkdown } from "../src/ui/StMarkdown.tsx"
import { HtmlMessageContext, type HtmlMessage } from "../src/ui/html/messageHtml.ts"
import { registerHtmlParts } from "../src/ui/html/register.ts"

let disposers: Array<() => void> = []
beforeAll(() => {
  // jsdom has no IntersectionObserver; the frame loads once in view, as everything is here.
  globalThis.IntersectionObserver = class {
    readonly seen: (entries: Array<{ isIntersecting: boolean }>) => void
    constructor(seen: (entries: Array<{ isIntersecting: boolean }>) => void) {
      this.seen = seen
    }
    observe() {
      this.seen([{ isIntersecting: true }])
    }
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return []
    }
  } as unknown as typeof IntersectionObserver
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {}
  })) as unknown as typeof window.matchMedia
  // The app's message renderer, as the app registers it.
  disposers = [
    ...registerHtmlParts(),
    messageRenderers.register({ id: "test.markdown", order: 0, component: StMarkdown })
  ]
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
afterAll(() => disposers.forEach((dispose) => dispose()))

const allowing: HtmlMessage = { key: "message", permit: { scripts: true, network: true, ask: null } }

const framesOf = async (child: ReturnType<typeof createElement>) => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(createElement(HtmlMessageContext, { value: allowing }, child)))
  // The Markdown renderer loads lazily: give it time to.
  for (let i = 0; i < 20 && !host.querySelector("iframe"); i++)
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
  const sources = [...host.querySelectorAll("iframe")].map((frame) => frame.getAttribute("src") ?? "")
  await act(async () => root.unmount())
  host.remove()
  return sources
}

it("an HTML file's preview runs no scripts inside a message that allows them", async () => {
  const sources = await framesOf(createElement(HtmlPreview, { text: "<!doctype html><p>Synthetic page</p>" }))
  expect(sources.length).toBeGreaterThan(0)
  for (const src of sources) expect(src).not.toContain("scripts=1")
})

it("a Markdown file's document blocks run no scripts inside a message that allows them", async () => {
  const sources = await framesOf(
    createElement(MarkdownPreview, {
      text: "Before.\n\n```html\n<html><body><p>Synthetic page</p></body></html>\n```\n\nAfter."
    })
  )
  expect(sources.length).toBeGreaterThan(0)
  for (const src of sources) expect(src).not.toContain("scripts=1")
})

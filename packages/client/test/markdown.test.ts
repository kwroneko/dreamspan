import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { Markdown } from "../src/ui/Markdown.tsx"

const render = (text: string, streaming = false) => renderToStaticMarkup(createElement(Markdown, { text, streaming }))

describe("Markdown", () => {
  it("resolves a reference link against a definition in another block", () => {
    const text =
      "The [harbor][h] at dusk.\n\n## Later\n\nBack to the [harbor].\n\n[h]: https://example.com/h\n[harbor]: https://example.com/harbor\n"
    const html = render(text)
    expect(html).toContain('href="https://example.com/h"')
    expect(html).toContain('href="https://example.com/harbor"')
    // Definitions render as nothing, wherever they're repeated.
    expect(html).not.toContain("example.com/h]")
    expect(html).not.toContain("[h]:")
  })

  it("resolves it while streaming, and keeps definitions out of a code block still open", () => {
    const text = "See [the map][m].\n\n[m]: https://example.com/map\n\n```\nconst x = 1"
    const html = render(text, true)
    expect(html).toContain('href="https://example.com/map"')
    expect(html).not.toContain("[m]:")
  })
})

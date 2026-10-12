import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { parseMarkdownIntoBlocks } from "streamdown"
import { Markdown } from "../src/ui/Markdown.tsx"
import { MAX_COPIED, withDefinitions } from "../src/ui/referenceDefinitions.ts"

const render = (text: string, streaming = false) => renderToStaticMarkup(createElement(Markdown, { text, streaming }))

/** Characters added to the blocks of `text` by copying definitions. */
const copied = (text: string) => {
  const blocks = parseMarkdownIntoBlocks(text)
  const total = (all: ReadonlyArray<string>) => all.reduce((sum, block) => sum + block.length, 0)
  return total(withDefinitions(text, blocks)) - total(blocks)
}

describe("reference definitions across blocks", () => {
  it("copies into each block only the definitions it refers to", () => {
    // 400 paragraphs, each followed by its own definition (27 KB): one copy each.
    const parts: Array<string> = []
    for (let i = 0; i < 400; i++) parts.push(`See [note ${i}].`, `[note ${i}]: https://example.com/${i}`)
    const text = parts.join("\n\n")
    const definitions = parts.filter((_, i) => i % 2 === 1).join("\n").length
    expect(copied(text)).toBeLessThan(2 * definitions)
  })

  it("stops copying past a cap, however many blocks refer to them", () => {
    const definitions = Array.from({ length: 100 }, (_, i) => `[d${i}]: https://example.com/${"x".repeat(60)}/${i}`)
    const refs = definitions.map((_, i) => `[d${i}]`).join(" ")
    const text = [...Array.from({ length: 400 }, () => `All of them: ${refs}`), ...definitions].join("\n\n")
    // Plus a separating blank line per block.
    expect(copied(text)).toBeLessThanOrEqual(MAX_COPIED + 4 * 500)
  })

  it("doesn't copy a definition into the block that holds it, and matches labels as CommonMark does", () => {
    const blocks = withDefinitions("A [Big  Ship].\n\n[big ship]: https://example.com/s\n", [
      "A [Big  Ship].\n\n",
      "[big ship]: https://example.com/s\n"
    ])
    expect(blocks).toEqual([
      "A [Big  Ship].\n\n[big ship]: https://example.com/s\n",
      "[big ship]: https://example.com/s\n"
    ])
  })
})

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

import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { parseMarkdownIntoBlocks } from "streamdown"
import { StMarkdown } from "../src/ui/StMarkdown.tsx"
import { fixMarkdown } from "../src/ui/stFormatting.ts"
import { Markdown, messageRenderers } from "../src/ui/Markdown.tsx"
import { MAX_COPIED, withDefinitions } from "../src/ui/referenceDefinitions.ts"

let dispose: () => void
beforeEach(() => {
  dispose = messageRenderers.register({ id: "markdown", order: 0, component: StMarkdown })
})
afterEach(() => dispose())

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

describe("ST 1.19 message formatting", () => {
  it.each(['"words"', "“words”", "«words»", "「words」", "『words』", "＂words＂"])(
    "colours quote style %s, keeping its glyphs",
    (text) => {
      const html = render(text)
      expect(html).toContain(`<q>${text.replaceAll('"', "&quot;")}</q>`)
    }
  )
  it("uses ST's nearest closing delimiter, including midword and empty quotes", () => {
    const html = render('a"one"b "" “first” second”')
    expect(html).toContain("a<q>&quot;one&quot;</q>b <q>&quot;&quot;</q> <q>“first”</q> second”")
    expect(render("“first\nsecond”")).not.toContain("<q>")
    expect(render("«unclosed")).not.toContain("<q>")
    expect(render('"one""two"')).toContain("<q>&quot;one&quot;</q><q>&quot;two&quot;</q>")
  })
  it.each([
    '`"code" *literal* __literal__`',
    '``"code"``',
    '```text\n"code" *literal* __literal__\n```',
    '~~~\n"code"\n~~~',
    '```\n"code"'
  ])("leaves quotes and formatting inside code as code: %s", (text) => {
    const html = render(text)
    expect(html).toContain("<code")
    expect(html).not.toContain("<q>")
    expect(html).not.toContain("<em>")
    expect(html).not.toContain("<u>")
  })
  it("renders both italics forms and nests emphasis inside quoted dialogue", () => {
    const html = render('*thought* _thought_ "say *this* and _that_"')
    expect(html).toContain("<em>thought</em> <em>thought</em> <q>&quot;say <em>this</em> and <em>that</em>&quot;</q>")
  })
  it("keeps code inside dialogue outside the quote colour", () => {
    const html = render("“say `literal` now”")
    expect(html).toMatch(/<q>“say <\/q>.*<code[^>]*>literal<\/code>.*<q> now”<\/q>/)
  })
  it("uses underline for double underscores while double stars stay bold", () => {
    const html = render("__underlined__ **bold** ___both___")
    expect(html).toContain("<u>underlined</u>")
    expect(html).toContain("<strong>bold</strong>")
    expect(html).toContain("<u>both</u>")
  })
  it("keeps single breaks and blank-line paragraphs", () => {
    const html = render("first\nsecond\n\nthird")
    expect(html).toContain("first<br/>")
    expect(html).toContain("second</p>")
    expect(html).toContain(">third</p>")
  })
  it.each([
    ["*open", "*open*"],
    ['"open', '"open"'],
    ["*open  \n*another", "*open*\n*another*"],
    ["* spaced * _ spaced _ ** bold ** __ underline __", "*spaced* _spaced_ **bold** __underline__"],
    ['* both "', '* both ""'],
    ["_open", "_open"],
    ["**open", "**open"],
    ["“open", "“open"],
    ["*line\nend*", "*line*\nend**"]
  ])("matches fixMarkdown display behavior for %s", (text, expected) => {
    expect(fixMarkdown(text)).toBe(expected)
  })
  it.each([false, true])("fixes every message, streaming=%s, without changing its source", (streaming) => {
    const text = '*unfinished\n\n"unfinished'
    expect(render(text, streaming)).toContain("<em>unfinished</em>")
    expect(render(text, streaming)).toContain("<q>&quot;unfinished&quot;</q>")
    expect(text).toBe('*unfinished\n\n"unfinished')
  })
  it("keeps line breaks in literal HTML and protects tag attributes as ST's default encode_tags=false does", () => {
    const html = render('<div title="plain">\nfirst\nsecond\n</div>')
    expect(html).toContain("&lt;div title=&quot;plain&quot;&gt;<br/>")
    expect(html).not.toContain("<q>")
    expect(html).toContain("first<br/>")
    expect(html).toContain("second<br/>")
    expect(html).not.toContain("<div title=")
  })
  it("colours dialogue beside literal tags without pairing it with straight attribute quotes", () => {
    const html = render('<span title="plain" data-note="other">"say *this*"</span> "outside"')
    expect(html).toContain("&lt;span title=&quot;plain&quot; data-note=&quot;other&quot;&gt;")
    expect(html).toContain("<q>&quot;say <em>this</em>&quot;</q>")
    expect(html).toContain("&lt;/span&gt; <q>&quot;outside&quot;</q>")
    expect(html.match(/<q>/g)).toHaveLength(2)
  })
  it("shows HTML as text and retains image and link protections", () => {
    const html = render(
      '<span title="synthetic">hello</span>\n<script>alert(1)</script>\n![tracker](https://example.com/track)\n[link](https://example.com/)'
    )
    expect(html).not.toContain("<span title=")
    expect(html).not.toContain("<script>")
    expect(html).toContain("&lt;span")
    expect(html).toContain("&lt;script&gt;")
    expect(html).not.toContain("<img")
    expect(html).toContain('rel="noopener noreferrer nofollow"')
  })
  it("allows replacement, wrapping, additions and disablement through the renderer registry", () => {
    const original = messageRenderers.get("markdown")!
    const replacement = messageRenderers.register({
      ...original,
      component: ({ text, ...props }) => createElement(original.component, { text: `__${text}__`, ...props })
    })
    expect(render("wrapped")).toContain("<u>wrapped</u>")
    const additional = messageRenderers.register({
      id: "synthetic",
      order: 10,
      component: ({ text }) => createElement("aside", null, text)
    })
    expect(render("alternate")).toContain("<aside>alternate</aside>")
    additional()
    const disabled = messageRenderers.disable("markdown")
    expect(render("<b>plain</b>")).toContain("&lt;b&gt;plain&lt;/b&gt;")
    disabled()
    replacement()
    expect(render("restored")).not.toContain("<u>")
  })
})

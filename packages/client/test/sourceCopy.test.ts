import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { decodeString } from "micromark-util-decode-string"
import { describe, expect, it } from "vitest"
import { StMarkdown } from "../src/ui/StMarkdown.tsx"
import { fixMarkdownMapped } from "../src/ui/stFormatting.ts"
import { selectedSource, type SourceMap } from "../src/ui/sourcePositions.ts"
import { messageCopyHandlers } from "../src/ui/messageCopy.tsx"

const decodeHtml = (text: string) =>
  text.replace(/&(?:#[xX][\da-fA-F]+|#\d+|[a-zA-Z][\da-zA-Z]*);/g, (entity) => decodeString(entity))

function rendered(text: string, sourceText = text) {
  const html = renderToStaticMarkup(createElement(StMarkdown, { text, sourceText, streaming: true }))
  const leaves = [...html.matchAll(/<(?:span|code|div|br)[^>]*data-source-map="([^"]+)"[^>]*>/g)].map((match) => {
    const map = JSON.parse(decodeHtml(match[1]!)) as SourceMap
    let tail = html.slice(match.index + match[0].length)
    if (map.code)
      tail = tail
        .slice(tail.indexOf("<code>") + 6)
        .split("</code>")[0]!
        .replaceAll("\n", "")
        .replace(/<span class="block">/g, "\n")
        .slice(1)
    const value = map.br ? "\n" : decodeHtml(tail.replace(/<[^>]*>/g, "")).slice(0, map.length)
    return { map, value }
  })
  return { html, leaves }
}
function copied(text: string, value: string, from = 0, to = value.length) {
  const leaf = rendered(text).leaves.find((leaf) => leaf.value === value)
  expect(leaf, `mapped text ${JSON.stringify(value)} in ${text}`).toBeDefined()
  const range = selectedSource(leaf!.map, from, to)
  return range ? text.slice(...range) : ""
}

describe("rendered message source offsets", () => {
  it.each(['"words"', "“words”", "«words»", "「words」", "『words』", "＂words＂"])(
    "keeps quote glyphs: %s",
    (quote) => {
      expect(copied(`Before ${quote} after`, quote)).toBe(quote)
      expect(copied(`Before ${quote} after`, quote, 2, 4)).toBe("or")
    }
  )
  it.each(["*", "_", "__", "___", "**", "~~"])("keeps exactly the selected edges of %s", (mark) => {
    const text = `Before ${mark}hello${mark} after`
    expect(copied(text, "hello")).toBe(`${mark}hello${mark}`)
    expect(copied(text, "hello", 0, 2)).toBe(`${mark}he`)
    expect(copied(text, "hello", 2, 5)).toBe(`llo${mark}`)
    expect(copied(text, "hello", 1, 3)).toBe("el")
  })
  it("retains italic positions inside dialogue and quote splits beside escaped entities", () => {
    const text = 'Before "say *hello* now" after'
    expect(copied(text, "hello")).toBe("*hello*")
    expect(copied(text, '"say ')).toBe('"say ')
    expect(copied('An &amp; "answer" beside \\*literal\\*.', '"answer"')).toBe('"answer"')
    expect(copied("An &amp; answer.", "An & answer.", 3, 4)).toBe("&amp;")
    expect(copied("An \\*answer\\*.", "An *answer*.", 3, 4)).toBe("\\*")
  })
  it("maps literal HTML, including newlines and quotes in attributes", () => {
    const text = '<div title="plain">\nfirst\nsecond\n</div>'
    expect(copied(text, '<div title="plain">')).toBe('<div title="plain">')
    expect(copied(text, "first")).toBe("first")
    expect(copied(text, "</div>")).toBe("</div>")
    expect(rendered(text).html).not.toContain('<div title="plain">')
  })
  it.each(["`hello`", "`` hello ``", "`hello\nthere`"])("maps code spans %s", (text) => {
    const value = text.includes("there") ? "hello there" : "hello"
    expect(copied(text, value)).toBe(text)
    expect(copied(`Before ${text} after`, value, 1, 3)).toBe("el")
  })
  it.each(["```js\nhello\n```", "~~~text\nhello\n~~~", "```\nhello", "    hello"])(
    "maps code bodies and stored fences: %s",
    (text) => {
      expect(copied(text, "hello")).toBe(text)
      expect(copied(text, "hello", 1, 3)).toBe("el")
      expect(rendered(text).leaves.filter((leaf) => leaf.map.code)).toHaveLength(1)
    }
  )
  it("keeps code literals and multiline offsets, excluding the displayed language label", () => {
    const text = "```js\n&amp; \\*hello\\*\nnext\n```"
    const value = "&amp; \\*hello\\*\nnext"
    expect(copied(text, value)).toBe(text)
    expect(copied(text, value, 1, 4)).toBe("amp")
    expect(
      rendered(text)
        .leaves.map((leaf) => leaf.value)
        .join("")
    ).not.toContain("js")
  })
  it("distinguishes code indentation from intentional leading spaces", () => {
    expect(copied("     a", " a", 0, 1)).toBe("     ")
    expect(copied("  ```\n   a\n  ```", " a", 0, 1)).toBe("```\n   ")
    expect(copied("> ```\n>  a\n> ```", " a", 0, 1)).toBe("> ```\n>  ")
  })
  it("keeps literal fence runs at the end of code lines", () => {
    const text = "````\nhello````"
    expect(copied(text, "hello````", 5, 9)).toBe("````")
    expect(copied(text, "hello````")).toBe(text)
    expect(copied("````\nhello\n```", "hello\n```", 6, 9)).toBe("```")
  })
  it("includes link syntax only at the selected label's edges", () => {
    const text = "Before [harbor](https://example.com/h) after"
    expect(copied(text, "harbor")).toBe("[harbor](https://example.com/h)")
    expect(copied(text, "harbor", 0, 3)).toBe("[har")
    expect(copied(text, "harbor", 3, 6)).toBe("bor](https://example.com/h)")
    expect(copied("See [harbor][h].\n\n[h]: https://example.com/h", "harbor")).toBe("[harbor][h]")
  })
  it("keeps lists' written numbers/markers, headings, blockquotes and table delimiters", () => {
    expect(copied("7. first\n9. second", "first")).toBe("7. first")
    expect(copied("7. first\n9. second", "second")).toBe("9. second")
    expect(copied("- first\n- second", "first")).toBe("- first")
    expect(copied("# Heading", "Heading")).toBe("# Heading")
    expect(copied("> Quoted", "Quoted")).toBe("> Quoted")
    expect(copied("| Column |\n| --- |\n| Value |", "Value")).toBe("| Value |")
  })
  it("preserves soft/hard breaks and paragraphs in a slice spanning their text", () => {
    for (const text of ["first\nsecond", "first  \nsecond", "first\n\nsecond", "> first\n> second"]) {
      const leaves = rendered(text).leaves
      const first = selectedSource(leaves[0]!.map, 0, leaves[0]!.map.length)!
      const last = selectedSource(leaves.at(-1)!.map, 0, leaves.at(-1)!.map.length)!
      expect(text.slice(first[0], last[1])).toBe(text)
    }
  })
  it("maps a selected line break, including its stored hard-break spaces or CRLF", () => {
    expect(copied("first\nsecond", "\n")).toBe("\n")
    expect(copied("first  \nsecond", "\n")).toBe("  \n")
    expect(copied("first\r\nsecond", "\n")).toBe("\r\n")
  })
  it("maps multiple/repeated blocks independently, including copied reference definitions", () => {
    const text = "*hello*\n\n*hello*\n\nSee [harbor][h].\n\n[h]: https://example.com/h"
    const leaves = rendered(text).leaves
    expect(leaves.slice(0, 2).map(({ map }) => selectedSource(map, 0, 5))).toEqual([
      [0, 7],
      [9, 16]
    ])
    expect(copied(text, "harbor")).toBe("[harbor][h]")
  })
  it("never copies fixMarkdown's added closings; removed display whitespace stays stored", () => {
    expect(copied("*hello", "hello")).toBe("*hello")
    expect(copied('"hello', '"hello"')).toBe('"hello')
    expect(copied('"hello', '"hello"', 6, 7)).toBe("")
    expect(copied("Before * spaced * after", "spaced")).toBe("* spaced *")
    const fixed = fixMarkdownMapped('*hello  \n"world')
    expect(fixed.offsets.filter((offset) => offset === null)).toHaveLength(2)
    expect(fixed.offsets.at(-2)).toBe(14)
  })
  it("uses UTF-16 offsets, preserving emoji and non-Latin text", () => {
    expect(copied("Before *猫😀hi* after", "猫😀hi", 1, 3)).toBe("😀")
  })
  it("maps displayed replacements to their stored range", () => {
    const stored = "Hello {{user}}."
    const leaf = rendered("Hello Ada.", stored).leaves[0]!
    const range = selectedSource(leaf.map, 6, 9)!
    expect(stored.slice(...range)).toBe("{{user}}")
  })
  it("keeps CRLF offsets in normalized code and soft breaks", () => {
    expect(copied("Before `hello\r\nthere` after", "hello there", 6, 11)).toBe("there`")
    expect(copied("first\r\nsecond", "second", 1, 4)).toBe("eco")
    expect(copied("```js\r\nhello\r\nthere\r\n```", "hello\nthere", 6, 9)).toBe("the")
  })
  it("maps individual code line breaks, including blank lines and CRLF", () => {
    expect(copied("```\na\nb\n```", "a\nb", 1, 2)).toBe("\n")
    expect(copied("```\na\n\nb\n```", "a\n\nb", 1, 2)).toBe("\n")
    expect(copied("```\na\n\nb\n```", "a\n\nb", 2, 3)).toBe("\n")
    expect(copied("```\r\na\r\nb\r\n```", "a\nb", 1, 2)).toBe("\r\n")
  })
  it("maps a blocked image's displayed alt text, excluding its generated label", () => {
    const text = "Before ![harbor](https://example.com/h.png) after"
    const value = "[Image blocked: harbor]"
    expect(copied(text, value)).toBe("![harbor](https://example.com/h.png)")
    expect(copied(text, value, 16, 19)).toBe("![har")
    expect(copied(text, value, 17, 19)).toBe("ar")
    expect(copied(text, value, 0, 15)).toBe("")
    expect(copied("![](https://example.com/h.png)", "[Image blocked: No description]")).toBe("")
    expect(rendered("```js\n\n```").leaves[0]!.map).toMatchObject({ code: true, length: 0 })
  })
  it("allows copy plugins to replace, disable and restore the effective handler", () => {
    const dispose = messageCopyHandlers.register({ id: "synthetic", order: 0, copy: () => null })
    const replace = messageCopyHandlers.register({
      id: "synthetic",
      order: 1,
      copy: () => ({ text: "raw", html: "<em>raw</em>" })
    })
    expect(messageCopyHandlers.get("synthetic")!.order).toBe(1)
    const enable = messageCopyHandlers.disable("synthetic")
    expect(messageCopyHandlers.get("synthetic")).toBeUndefined()
    enable()
    replace()
    expect(messageCopyHandlers.get("synthetic")!.order).toBe(0)
    dispose()
  })
})

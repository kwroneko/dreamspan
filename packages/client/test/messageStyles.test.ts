// @vitest-environment jsdom
// The message editor's styling ranges (ui/messageStyles.ts): which stored characters the editor
// shows as dialogue, italics, bold and the rest, and that they are the ones the message renders so.
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Markdown, messageRenderers } from "../src/ui/Markdown.tsx"
import { exampleMessages, messageStyleRanges, styleCache, styleList, type StyleKind } from "../src/ui/messageStyles.ts"
import { StMarkdown } from "../src/ui/StMarkdown.tsx"

/** The ranges as [kind, the text they cover]. */
const styled = (text: string, html = false) =>
  styleList(messageStyleRanges(text, { html })).map(({ from, to, kind }) => [kind, text.slice(from, to)])

describe("styling ranges", () => {
  it("styles dialogue, italics, bold and underline, and marks their Markdown", () => {
    expect(styled(`*She smiled.* "Hello," she said. **Bold** and __under__.`)).toEqual([
      ["em", "*She smiled.*"],
      ["syntax", "*"],
      ["syntax", "*"],
      ["quote", `"Hello,"`],
      ["strong", "**Bold**"],
      ["syntax", "**"],
      ["syntax", "**"],
      ["underline", "__under__"],
      ["syntax", "__"],
      ["syntax", "__"]
    ])
  })

  it("matches every quote the renderer matches, and none in code", () => {
    expect(styled('“Curly”, «angled», 「corner」 and `"code"`')).toEqual([
      ["quote", "“Curly”"],
      ["quote", "«angled»"],
      ["quote", "「corner」"],
      ["code", '`"code"`'],
      ["syntax", "`"],
      ["syntax", "`"]
    ])
  })

  it("puts the quote around emphasis it covers, and emphasis around a quote inside it", () => {
    expect(styled(`*"All of it"* and *she said "part" softly*`)).toEqual([
      ["quote", `*"All of it"*`],
      ["em", `*"All of it"*`],
      ["syntax", "*"],
      ["syntax", "*"],
      ["em", `*she said "part" softly*`],
      ["syntax", "*"],
      ["quote", `"part"`],
      ["syntax", "*"]
    ])
  })

  it("follows the display fixes: an unclosed quote or asterisk runs to the line's end, spaced emphasis is emphasis", () => {
    expect(styled(`"Wait,\nshe said. *open`)).toEqual([
      ["quote", `"Wait,`],
      ["em", "*open"],
      ["syntax", "*"]
    ])
    expect(styled("Then * spaced * here")).toEqual([
      ["em", "* spaced *"],
      ["syntax", "*"],
      ["syntax", "*"]
    ])
  })

  it("leaves quotes inside a tag's attributes alone, with HTML shown as text or as HTML", () => {
    const text = `<span title="no">"yes"</span>`
    expect(styled(text)).toEqual([["quote", `"yes"`]])
    expect(styled(text, true)).toEqual([["quote", `"yes"`]])
  })

  it("styles headings, block quotes, links, strikethrough and fenced code", () => {
    expect(styled('# Title\n\n> "Said"\n\n[a link](https://example.com) ~~gone~~\n\n```\nx = "y"\n```')).toEqual([
      ["h1", "# Title"],
      ["syntax", "# "],
      ["blockquote", `> "Said"`],
      ["syntax", "> "],
      ["quote", `"Said"`],
      ["link", "[a link](https://example.com)"],
      ["syntax", "["],
      ["syntax", "](https://example.com)"],
      ["strike", "~~gone~~"],
      ["syntax", "~~"],
      ["syntax", "~~"],
      ["pre", '```\nx = "y"\n```'],
      ["syntax", "```"],
      ["syntax", "```"]
    ])
  })

  it("gives the same ranges reusing blocks across edits as from scratch", () => {
    let text = Array.from(
      { length: 40 },
      (_, i) => `*Paragraph ${i}* "said ${i}," and **bold ${i}** with __u__ and \`c\`.`
    ).join("\n\n")
    const cache = styleCache()
    messageStyleRanges(text, {}, cache)
    // Deterministic edits: typing, deleting, an asterisk and a quote that change the pairing.
    const edits = ["x", '"', "*", "", "\n\n", "**", "_"]
    let seed = 7
    for (let step = 0; step < 120; step++) {
      seed = (seed * 48271) % 2147483647
      const at = seed % (text.length + 1)
      const insert = edits[step % edits.length]!
      text = insert === "" ? text.slice(0, at) + text.slice(at + 1) : text.slice(0, at) + insert + text.slice(at)
      expect(Array.from(messageStyleRanges(text, {}, cache))).toEqual(Array.from(messageStyleRanges(text)))
    }
  })
})

describe("example dialogue", () => {
  const examples = (text: string, html = false) =>
    styleList(messageStyleRanges(text, { html, examples: true })).map(({ from, to, kind }) => [
      kind,
      text.slice(from, to)
    ])
  const DIALOGUE = [
    "<START>",
    `{{user}}: *waves* "Hi, {{char}}."`,
    `{{char}}: "Hello," she says. *smiles*`,
    `  and goes on *here*`,
    "<start>",
    "{{Char}}: **Bold** reply"
  ].join("\n")

  it("styles each message on its own, leaving the <START> lines and speaker prefixes as they are", () => {
    for (const html of [false, true])
      expect(examples(DIALOGUE, html)).toEqual([
        ["em", "*waves*"],
        ["syntax", "*"],
        ["syntax", "*"],
        ["quote", `"Hi, {{char}}."`],
        ["quote", `"Hello,"`],
        ["em", "*smiles*"],
        ["syntax", "*"],
        ["syntax", "*"],
        ["em", "*here*"],
        ["syntax", "*"],
        ["syntax", "*"],
        ["strong", "**Bold**"],
        ["syntax", "**"],
        ["syntax", "**"]
      ])
  })

  it("finds the messages between the separators and prefixes", () => {
    expect(exampleMessages(DIALOGUE).map(([from, to]) => DIALOGUE.slice(from, to))).toEqual([
      `*waves* "Hi, {{char}}."`,
      `"Hello," she says. *smiles*\n  and goes on *here*`,
      "**Bold** reply"
    ])
    expect(exampleMessages("No prefix *at all*").map(([from, to]) => [from, to])).toEqual([[0, 18]])
    expect(exampleMessages("<START>\n<START>\n")).toEqual([])
  })

  it("is the same with a kept cache as from scratch", () => {
    const cache = styleCache()
    messageStyleRanges(DIALOGUE, { examples: true }, cache)
    const edited = DIALOGUE.replace("smiles", "grins")
    expect(Array.from(messageStyleRanges(edited, { examples: true }, cache))).toEqual(
      Array.from(messageStyleRanges(edited, { examples: true }))
    )
  })
})

describe("the same as the message renders", () => {
  let dispose: () => void
  beforeEach(() => {
    dispose = messageRenderers.register({ id: "markdown", order: 0, component: StMarkdown })
  })
  afterEach(() => dispose())

  /** Letters and digits only: the renderer drops the marks and adds a closing quote or asterisk. */
  const words = (text: string) => text.replace(/[^\p{L}\p{N}]+/gu, "")
  const TAGS: Partial<Record<StyleKind, string>> = {
    quote: "q",
    em: "em",
    strong: "strong",
    underline: "u",
    strike: "del",
    code: "code"
  }

  /** For each styled kind, the words of each element of it, in order: rendered, and from the ranges. */
  const compare = (text: string) => {
    const host = document.createElement("div")
    host.innerHTML = renderToStaticMarkup(createElement(Markdown, { text, streaming: false }))
    const ranges = styleList(messageStyleRanges(text))
    const syntax = ranges.filter((range) => range.kind === "syntax")
    for (const [kind, tag] of Object.entries(TAGS)) {
      const rendered = [...host.querySelectorAll(tag)].map((element) => words(element.textContent ?? ""))
      const ours = ranges
        .filter((range) => range.kind === kind)
        .map(({ from, to }) => {
          let shown = ""
          for (let at = from; at < to; at++)
            if (!syntax.some((mark) => mark.from <= at && at < mark.to) || kind === "code") shown += text[at]
          return words(kind === "code" ? shown.replace(/^`+|`+$/g, "") : shown)
        })
      expect(ours, `${kind} in ${JSON.stringify(text)}`).toEqual(rendered)
    }
  }

  it.each([
    `*She looks up.* "You're late," she says. **Very** late. __Noted.__`,
    `"An unclosed line of dialogue\n*and an unclosed aside`,
    `She says "one *two* three" and *four "five" six*.`,
    `* spaced * and ** spaced bold ** and _under_score_ words`,
    `“Curly” and «angled» with \`"code" here\` and ~~struck~~`,
    `# A "titled" heading\n\n> A quoted "line"\n> *more*\n\n- item "one"\n- *item* two`,
    `<b class="x">"bold tag"</b> and <i>"italic"</i> as text`,
    `___triple___ and ***both*** and **bold "quote" inside**`,
    `Line one "open\nline two "closed" here\n\nNew paragraph *with\nan em across* lines`
  ])("%s", (text) => compare(text))
})

// The context form of an older message's HTML (spec/HTML-MESSAGES.md §3.6, `context.htmlDepth`).
import { describe, expect, it } from "vitest"
import { slowIt } from "./support/slow.ts"
import { htmlDepthForm } from "../src/assembler/htmlDepth.ts"

describe("htmlDepthForm", () => {
  it("removes HTML's tags and keeps their text", () => {
    expect(htmlDepthForm('<div class="hp">HP <b>12</b>/20</div>', "text")).toBe("HP 12/20")
    expect(htmlDepthForm("Mira <i>sighs</i>.<br>Then &quot;tea&quot; &amp; cake.", "text")).toBe(
      'Mira sighs.\nThen "tea" & cake.'
    )
    expect(htmlDepthForm("<ul><li>one</li><li>two</li></ul>", "text")).toBe("one\ntwo")
    expect(htmlDepthForm("<table><tr><td>HP</td><td>12</td></tr></table>", "text")).toBe("HP 12")
  })

  it("drops what isn't text: styles, scripts, comments", () => {
    expect(htmlDepthForm("<style>.a{color:red}</style><p>Kept.</p><!-- note --><script>x()</script>", "text")).toBe(
      "Kept."
    )
  })

  it("leaves text without HTML, and tags HTML doesn't define, as written", () => {
    const plain = "Mira pours the tea. 3 < 5, and 5 > 3."
    expect(htmlDepthForm(plain, "text")).toBe(plain)
    expect(htmlDepthForm("<status>HP 9</status> <thinking>hm</thinking>", "panels")).toBe(
      "<status>HP 9</status> <thinking>hm</thinking>"
    )
  })

  it("keeps code as written, reduces document blocks to their text or drops them", () => {
    const code = "```js\nconst a = '<b>x</b>'\n```"
    expect(htmlDepthForm(`See:\n\n${code}`, "text")).toBe(`See:\n\n${code}`)
    expect(htmlDepthForm("Use `<b>` for bold.", "text")).toBe("Use `<b>` for bold.")
    const doc = "```html\n<html><body><h1>Board</h1><p>Day 3</p></body></html>\n```"
    expect(htmlDepthForm(`The board.\n\n${doc}\n\nAfter.`, "text")).toBe("The board.\n\nBoard\nDay 3\n\nAfter.")
    expect(htmlDepthForm(`The board.\n\n${doc}\n\nAfter.`, "panels")).toBe("The board.\n\nAfter.")
  })

  it("reads bad character references as HTML does, without throwing", () => {
    expect(htmlDepthForm("<b>&#0;&#xD800;&#x110000;&#65;</b>", "text")).toBe("���A")
  })
})

it("reduces unfinished document content and decodes HTML's full entity set", () => {
  expect(htmlDepthForm("<p>Caf&eacute; &copy; &ndash; &#128;</p>", "text")).toBe("Café © – €")
  expect(htmlDepthForm("<div>Kept.</div><script>unfinished()", "text")).toBe("Kept.")
  expect(htmlDepthForm("```html\n<!doctype html><html><body><p>Board</p></body></html>\n```", "text")).toBe("Board")
})

it("removes standard embedded HTML, SVG and MathML elements while preserving custom markers", () => {
  expect(htmlDepthForm("<object><iframe>Fallback</iframe></object><slot>Slot</slot>", "text")).toBe("FallbackSlot")
  expect(htmlDepthForm("<math><mfrac><mi>x</mi><mn>2</mn></mfrac></math>", "text")).toBe("x2")
  expect(htmlDepthForm("<svg><textPath>Map</textPath></svg><status>HP 9</status>", "text")).toBe(
    "Map<status>HP 9</status>"
  )
})

for (const body of [
  "<script>const x = `HIDDEN_SCRIPT`;</script><p>Kept.</p>",
  "<template><template>hidden</template>HIDDEN_TEMPLATE</template><p>Kept.</p>",
  "<!-- `HIDDEN_COMMENT` --><p>Kept.</p>",
  "<style>.x { content: `HIDDEN_STYLE`; }</style><p>Kept.</p>"
]) {
  it(`removes complete non-text nodes from prose: ${body}`, () => {
    expect(htmlDepthForm(body, "text")).toBe("Kept.")
  })
  it(`removes complete non-text nodes from document fences: ${body}`, () => {
    expect(htmlDepthForm("```html\n<body>" + body + "</body>\n```", "text")).toBe("Kept.")
  })
}

it("keeps literal HTML examples inside inline and fenced code", () => {
  expect(htmlDepthForm("Use `<script>x()</script>` and <b>bold</b>.", "text")).toBe(
    "Use `<script>x()</script>` and bold."
  )
  expect(htmlDepthForm("```js\nconst x = `<script>literal</script>`\n```", "text")).toBe(
    "```js\nconst x = `<script>literal</script>`\n```"
  )
})

// The client parses message HTML with parse5 (rehype-raw). The reduction must tokenize it the
// same way, or the model is sent something other than what the user sees.
describe("tokenizes HTML as the renderer does", () => {
  it("keeps custom elements whose names start like a non-text element", () => {
    expect(htmlDepthForm("<style-note>Visible</style-note> and more.", "text")).toBe(
      "<style-note>Visible</style-note> and more."
    )
    expect(htmlDepthForm("<head-line>Breaking</head-line> news, <b>today</b>.", "text")).toBe(
      "<head-line>Breaking</head-line> news, today."
    )
    expect(htmlDepthForm("<script-box>Shown</script-box><p>Kept.</p>", "text")).toBe(
      "<script-box>Shown</script-box>Kept."
    )
  })
  it("leaves the text of raw-text elements as the reader sees it", () => {
    expect(htmlDepthForm("<p>Type:</p><textarea><b>bold</b> &amp; more</textarea>", "text")).toBe(
      "Type:\n<b>bold</b> & more"
    )
  })
  it("reads tags with unquoted or odd attributes and comments as HTML does", () => {
    expect(htmlDepthForm('<div title=a>b class="x">Text</div>', "text")).toBe('b class="x">Text')
    expect(htmlDepthForm("<p>Kept</p><!-->Shown", "text")).toBe("Kept\nShown")
  })
  it("keeps what Markdown shows as text though HTML's tokenizer would hide it", () => {
    expect(htmlDepthForm("Bye </3 see <b>you</b> > soon", "text")).toBe("Bye </3 see you > soon")
    expect(htmlDepthForm("What <? is <i>this</i>", "text")).toBe("What <? is this")
    expect(htmlDepthForm("Wow <!! <b>ok</b> > yes </> <b>x</b>", "text")).toBe("Wow <!! ok > yes </> x")
    expect(htmlDepthForm("<p>a</p><?php hidden ?>b", "text")).toBe("a\nb")
  })
  it("is deterministic and linear on adversarial markup", () => {
    const text = "<b>x</b>" + "</3 <? <!x ".repeat(20_000)
    const started = Date.now()
    const first = htmlDepthForm(text, "text")
    expect(htmlDepthForm(text, "text")).toBe(first)
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})

it("bounds reduction without silently truncating oversized source", () => {
  const source = "<div>".repeat(40001) + "Visible tail"
  expect(htmlDepthForm(source, "text")).toBe(source)
})
it("is deterministic across deeply nested, foreign and malformed HTML", () => {
  for (const source of [
    "<div>".repeat(10000) + "Visible" + "</div>".repeat(10000),
    "<svg><foreignObject><textarea>&lt;b&gt;x</textarea></foreignObject></svg>",
    "<math><mtext><style-note>shown</style-note></mtext></math>",
    '<div title="unterminated'
  ]) {
    const first = htmlDepthForm(source, "text")
    expect(htmlDepthForm(source, "text")).toBe(first)
    expect(htmlDepthForm(source, "text")).toBe(first)
  }
})

it("handles long unmatched code delimiters without regex backtracking", () => {
  const source = "`".repeat(40000) + "x<div>visible</div>"
  expect(htmlDepthForm(source, "text")).toBe("`".repeat(40000) + "xvisible")
})

slowIt("reduces maximum-sized hostile HTML within two seconds without stack recursion", () => {
  for (const source of [
    "<div>".repeat(15000) + "visible" + "</div>".repeat(15000),
    "`".repeat(199980) + "x<div>visible</div>",
    "`x`<template>\n".repeat(14000)
  ]) {
    const start = performance.now()
    const first = htmlDepthForm(source, "text")
    expect(htmlDepthForm(source, "text")).toBe(first)
    expect(performance.now() - start).toBeLessThan(2000)
  }
})

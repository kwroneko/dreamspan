// The context form of an older message's HTML (spec/HTML-MESSAGES.md §3.6, `context.htmlDepth`).
import { describe, expect, it } from "vitest"
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

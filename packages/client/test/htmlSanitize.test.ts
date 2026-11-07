// The message sanitizer against DOMPurify, which ST sanitizes messages with (spec/HTML-MESSAGES.md
// §3.2): on a fixed synthetic corpus the schema keeps what DOMPurify keeps, less the documented
// differences; known mutation-XSS strings run nothing through the whole pipeline; and the
// generated lists match the installed DOMPurify.
import { readFileSync } from "node:fs"
import createDOMPurify from "dompurify"
import { JSDOM } from "jsdom"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import rehypeRaw from "rehype-raw"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { generate, OUTPUT } from "../scripts/htmlSchema.ts"
import { StMarkdown } from "../src/ui/StMarkdown.tsx"
import { htmlPartsRevision } from "../src/ui/html/parts.ts"
import { HtmlMessageContext } from "../src/ui/html/messageHtml.ts"
import { registerHtmlParts } from "../src/ui/html/register.ts"
import { htmlSanitize } from "../src/ui/html/rehypeHtml.ts"

let disposers: Array<() => void> = []
beforeAll(() => {
  disposers = registerHtmlParts()
})
afterAll(() => disposers.forEach((dispose) => dispose()))

const window = new JSDOM("").window
const purify = createDOMPurify(window as never)

interface Node {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: Node[]
}
const parse = (markup: string) =>
  rehypeRaw()({ type: "root", children: [{ type: "raw", value: markup }] } as never, undefined as never) as Node

/** A tree as comparable text: tags, sorted properties and text, without positions. */
function canonical(node: Node): string {
  if (node.type === "text") return node.value ?? ""
  const inner = (node.children ?? []).map(canonical).join("")
  if (node.type !== "element") return inner
  const properties = Object.entries(node.properties ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => ` ${key}=${JSON.stringify(value)}`)
    .join("")
  return `<${node.tagName}${properties}>${inner}</${node.tagName}>`
}

/** The schema alone (as rehypeHtml.ts runs it), on what the parser made of the markup. */
const ours = (markup: string) => canonical(htmlSanitize({ parts: htmlPartsRevision() })(parse(markup)))

/**
 * DOMPurify's result with the schema's documented differences applied (schema.ts): `style` and
 * `title` go with their content, `form`, `template` and the document's own elements leave their
 * content, and form submission and popover attributes go.
 */
const LEFT_OUT_WITH_CONTENT = new Set(["style", "title"])
const UNWRAPPED = new Set(["form", "template", "html", "head", "body"])
const LEFT_OUT_PROPERTIES = new Set(["action", "method", "encType", "formAction", "formMethod", "popover", "nonce"])
function differences(node: Node): Node[] {
  if (node.type !== "element") return [node]
  const children = (node.children ?? []).flatMap(differences)
  if (LEFT_OUT_WITH_CONTENT.has(node.tagName!)) return []
  if (UNWRAPPED.has(node.tagName!)) return children
  const properties = Object.fromEntries(
    Object.entries(node.properties ?? {}).filter(([key]) => !LEFT_OUT_PROPERTIES.has(key))
  )
  return [{ ...node, properties, children }]
}
const theirs = (markup: string) => {
  const tree = parse(purify.sanitize(markup))
  return canonical({ ...tree, children: (tree.children ?? []).flatMap(differences) })
}

/** Synthetic markup of the kinds cards write: status boxes, tables, SVG, MathML, fields, and bad tags. */
const CORPUS = [
  '<div class="box" id="hp" title="Health" data-x="1" aria-label="Health" lang="en" dir="ltr">HP <b>12</b>/<i>20</i></div>',
  '<span style="color: red; font-weight: bold">Mira</span> <small>quietly</small> <mark>noted</mark>',
  '<table border="1"><thead><tr><th colspan="2" scope="col">Stats</th></tr></thead><tbody><tr><td rowspan="1">STR</td><td>9</td></tr></tbody></table>',
  "<details open><summary>Inventory</summary><ul><li>Rope</li><li>Lamp</li></ul></details>",
  '<img src="https://example.com/a.png" alt="A map" width="10" height="10" loading="lazy">',
  '<a href="https://example.com/" target="_blank" rel="noopener">A link</a> <abbr title="hit points">HP</abbr>',
  '<svg viewBox="0 0 10 10" width="10"><defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs><circle cx="5" cy="5" r="4" fill="url(#g)"/><text x="1" y="9">t</text></svg>',
  '<svg><filter id="f"><feGaussianBlur stdDeviation="2"/></filter><rect width="4" height="4" filter="url(#f)"/></svg>',
  "<math><mi>x</mi><mo>=</mo><mfrac><mn>1</mn><mn>2</mn></mfrac></math>",
  "<ruby>kan<rp>(</rp><rt>k</rt><rp>)</rp></ruby> <kbd>Ctrl</kbd> <sub>2</sub><sup>3</sup>",
  '<input type="checkbox" id="t" checked><label for="t">Open</label><select name="s"><option value="a" selected>A</option><option>B</option></select><textarea rows="2">notes</textarea><button type="button" disabled>Go</button>',
  '<form action="/rpc" method="post"><input type="text" placeholder="Name"><button formaction="/other">Send</button></form>',
  "<custom-tag>kept text</custom-tag> <Status>also kept</Status> <blink>blink</blink>",
  '<script>alert(1)</script>after <noscript>gone</noscript> <iframe src="https://example.com"></iframe><object data="x"></object><embed src="x">',
  "<style>.box { color: red }</style><title>T</title>after",
  '<p onclick="x()" onmouseover="y()">handlers</p><div popover id="p">pop</div>',
  '<audio controls src="https://example.com/a.mp3"></audio><video width="10" poster="https://example.com/p.png"><source src="https://example.com/v.mp4" type="video/mp4"></video>',
  '<font color="red" size="2">old</font> <center>centered</center> <hr><br><blockquote cite="https://example.com/">q</blockquote>',
  '<ol start="3" reversed><li value="5">five</li></ol><dl><dt>Term</dt><dd>Definition</dd></dl>',
  "<!-- a comment --><template><b>inert</b></template>"
]

describe("the schema against DOMPurify", () => {
  it.each(CORPUS)("keeps what DOMPurify keeps: %s", (markup) => {
    expect(ours(markup)).toBe(theirs(markup))
  })
})

/** Known mutation-XSS and filter-evasion strings (public, synthetic). */
const MXSS = [
  '<svg></p><style><a id="</style><img src=1 onerror=alert(1)>">',
  '<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;/mglyph&gt;&lt;img&Tab;src=1&Tab;onerror=alert(1)&gt;">',
  '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
  "<form><math><mtext></form><form><mglyph><style></math><img src onerror=alert(1)>",
  '<a href="jav&#x09;ascript:alert(1)">x</a><a href=" javascript:alert(1)">y</a><a href="JaVaScRiPt:alert(1)">z</a>',
  '<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>',
  '<svg><animate attributeName="href" values="javascript:alert(1)"/><a><text>x</text></a></svg>',
  '<svg><use href="https://example.com/a.svg#x"/></svg>',
  '<div style="background: url(javascript:alert(1)); width: expression(alert(1))">x</div>',
  '<meta http-equiv="refresh" content="0;url=https://example.com"><base href="https://example.com/"><link rel="stylesheet" href="https://example.com/a.css">',
  '<iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"></iframe><object data="javascript:alert(1)"></object>',
  "<img src=x onerror=alert(1)//",
  '<details open ontoggle="alert(1)"><summary>s</summary></details><body onload="alert(1)">',
  '<a href="data:text/html,&lt;script&gt;alert(1)&lt;/script&gt;">d</a><img src="data:image/svg+xml,&lt;svg onload=alert(1)&gt;">',
  '<button form="f" formaction="javascript:alert(1)">b</button><input type="image" src="https://example.com/a.png">'
]

describe("mutation XSS", () => {
  it.each(MXSS)("runs nothing: %s", (markup) => {
    const out = renderToStaticMarkup(
      createElement(
        HtmlMessageContext,
        { value: { key: "slot" } },
        createElement(StMarkdown, { text: markup, streaming: false })
      )
    )
    const document = new JSDOM(`<body>${out}</body>`).window.document
    expect(document.querySelectorAll("script, iframe, object, embed, base, meta, link, style, form, use")).toHaveLength(
      0
    )
    for (const element of document.querySelectorAll("*")) {
      for (const attribute of element.attributes) {
        expect(attribute.name).not.toMatch(/^on/i)
        expect(attribute.value.replace(/[\s\0-\x1f]/g, "")).not.toMatch(/^(?:javascript|vbscript|data:text):?/i)
        if (["href", "src", "xlink:href", "action", "formaction"].includes(attribute.name))
          expect(attribute.value).toMatch(/^(?:https?:|mailto:|#|data:image\/)/i)
      }
    }
  })
})

describe("the generated lists", () => {
  it("match the installed DOMPurify", () => {
    expect(readFileSync(OUTPUT, "utf8")).toBe(generate())
  })
})

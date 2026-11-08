// HTML in messages (spec/HTML-MESSAGES.md §3.2): what renders inline, under the five fixes, as
// React renders it through the registered parts. Every fixture is synthetic.
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { StMarkdown } from "../src/ui/StMarkdown.tsx"
import { scopeStyles } from "../src/ui/html/css.ts"
import { extractStyles, HtmlMessageContext, HtmlSettingsContext, type PanelPermit } from "../src/ui/html/messageHtml.ts"
import { htmlClassifiers, htmlSchemas, isDocumentBlock } from "../src/ui/html/parts.ts"
import { registerHtmlParts } from "../src/ui/html/register.ts"
import { htmlSchema } from "../src/ui/html/schema.ts"

let disposers: Array<() => void> = []
beforeAll(() => {
  disposers = registerHtmlParts()
})
afterAll(() => disposers.forEach((dispose) => dispose()))

/** The rendered markup, without the copy metadata or the wrapper. */
const render = (
  text: string,
  {
    html = true,
    streaming = false,
    panelDepth = null as number | null,
    fromTip = null as number | null,
    permit = undefined as PanelPermit | undefined
  } = {}
) =>
  renderToStaticMarkup(
    createElement(
      HtmlSettingsContext,
      { value: { html, panelDepth } },
      createElement(
        HtmlMessageContext,
        { value: { key: "slot", streaming, fromTip, ...(permit ? { permit } : {}) } },
        createElement(StMarkdown, { text, streaming })
      )
    )
  )
    .replace(/<span data-source-map="[^"]*">([^<]*)<\/span>/g, "$1")
    .replace(/ data-source-map="[^"]*"/g, "")
    .replace(/^<div class="[^"]*">([\s\S]*)<\/div>$/, "$1")

describe("inline HTML", () => {
  it("renders a card's markup sanitized, its classes prefixed", () => {
    const out = render(
      '<div class="hp" style="color: red" onclick="alert(1)">HP <b>12</b>/20</div><script>alert(1)</script>'
    )
    expect(out).toBe('<div class="custom-hp" style="color:red">HP <b>12</b>/20</div>')
  })

  it("marks the body as contained and scoped", () => {
    const out = renderToStaticMarkup(
      createElement(
        HtmlMessageContext,
        { value: { key: "slot" } },
        createElement(StMarkdown, { text: "<b>x</b>", streaming: false })
      )
    )
    expect(out).toMatch(/class="[^"]*markdown markdown-html message-html"/)
  })

  it("keeps the text of tags it doesn't know, each line on its own", () => {
    expect(render("Mira pours the tea. <Status>HP 12/20\nDay 3</Status>")).toBe(
      "<p>Mira pours the tea. HP 12/20<br/>\nDay 3</p>"
    )
    expect(render("<Status>\nHP 12/20\nDay 3\n</Status>")).toBe("<br/>HP 12/20<br/>Day 3<br/>")
  })

  it("drops what can't show safely: scripts, handlers, titles, styles", () => {
    const out = render(
      '<p onmouseover="x()">a</p><script>x()</script><title>T</title><style>.a{}</style><iframe src="https://example.com"></iframe>'
    )
    expect(out).toBe("<p>a</p>")
  })

  it("makes forms divs, without their actions (fix 2)", () => {
    const out = render(
      '<form action="/rpc" method="get"><input type="checkbox" id="t" checked><label for="t">Open</label><button formaction="https://example.com" form="f">Go</button></form>'
    )
    expect(out).toBe(
      '<div><input type="checkbox" id="user-content-t" checked=""/><label for="user-content-t">Open</label><button>Go</button></div>'
    )
  })

  it("prefixes ids and names, and links to them (fix 3)", () => {
    const out = render('<a href="#x">jump</a> <a name="x" id="x">here</a>')
    expect(out).toBe('<p><a href="#user-content-x">jump</a> <a name="user-content-x" id="user-content-x">here</a></p>')
  })

  it("renames in-document references in SVG", () => {
    const out = render(
      '<svg viewBox="0 0 10 10"><defs><linearGradient id="g"></linearGradient></defs><rect fill="url(#g)"/></svg>'
    )
    expect(out).toContain('id="user-content-g"')
    expect(out).toContain('fill="url(#user-content-g)"')
  })

  it("reads SVG links as the browser does: padded fragments renamed, xlink-only links in a new tab", () => {
    const out = render(
      '<svg viewBox="0 0 10 10"><a xlink:href=" #root"><text>in</text></a><a href="#ro&#10;ot"><text>tab</text></a><a xlink:href="https://example.com/x"><text>out</text></a></svg>'
    )
    expect(out).not.toMatch(/href="\s*#root"/)
    expect(out).toContain('xlink:href="#user-content-root"')
    expect(out).toContain('href="#user-content-root"')
    expect(out).toMatch(/<a xlink:href="https:\/\/example.com\/x" target="_blank" rel="noopener noreferrer nofollow">/)
    const map = render('<img src="data:image/png;base64,AA==" usemap=" #m"><map name="m"></map>')
    expect(map).toContain('useMap="#user-content-m"')
  })

  it("keeps only web and mail links, opening in a new tab (fix 4)", () => {
    const out = render(
      '<a href="javascript:alert(1)">a</a> <a href="https://example.com">b</a> <a href="mailto:x@example.com">c</a> <a href="ftp://example.com">d</a>'
    )
    expect(out).toContain("<a>a</a>")
    expect(out).toContain('<a href="https://example.com/" target="_blank" rel="noopener noreferrer nofollow">b</a>')
    expect(out).toContain('href="mailto:x@example.com"')
    expect(out).toContain("<a>d</a>")
  })

  it("keeps Font Awesome and note class names (fix 5)", () => {
    expect(render('<i class="fa-solid fa-heart note-x monospace hp"></i>')).toBe(
      '<p><i class="fa-solid fa-heart note-x monospace custom-hp"></i></p>'
    )
  })

  it("loads data: images and blocks the rest", () => {
    const out = render(
      '<img src="https://example.com/a.png" alt="remote"><img src="data:image/png;base64,iVBORw0KGgo=" alt="inline">'
    )
    expect(out).toContain('<img src="data:image/png;base64,iVBORw0KGgo=" alt="inline"/>')
    expect(out).not.toContain("example.com")
  })

  it("takes out styles that load from elsewhere", () => {
    const out = render('<div style="color: red; background: url(https://example.com/a.png)">x</div>')
    expect(out).toBe('<div style="color:red">x</div>')
  })

  it("keeps whitespace in pre and text in fields", () => {
    expect(render("<pre>  keep\n  space</pre>")).toBe("<pre>  keep\n  space</pre>")
    expect(render("<textarea>notes</textarea>")).toContain("notes</textarea>")
  })

  it("leaves Markdown's own elements as they were", () => {
    expect(render("**bold** <b>x</b>\n\n[^1]\n\n[^1]: note")).not.toContain("custom-")
  })

  it("shows HTML as text with the preference off", () => {
    expect(render('<div class="hp">x</div>', { html: false })).toBe(
      "<p>&lt;div class=&quot;hp&quot;&gt;x&lt;/div&gt;</p>"
    )
  })

  it("shows HTML as text with the schema part disabled", () => {
    disposers.forEach((dispose) => dispose())
    try {
      expect(htmlSchemas.snapshot().entries).toEqual([])
      expect(render("<b>x</b>")).toBe("<p>&lt;b&gt;x&lt;/b&gt;</p>")
    } finally {
      disposers = registerHtmlParts()
    }
  })
})

describe("styles", () => {
  it("takes a message's styles from outside code", () => {
    expect(extractStyles("<style>.a{color:red}</style>\n```\n<style>.b{}</style>\n```\n<style>.c{}</style>")).toEqual([
      ".a{color:red}",
      ".c{}"
    ])
  })

  it("scopes each style on its own, so a broken one leaves the rest", () => {
    expect(scopeStyles(extractStyles('<style>.a { color: red }</style><style><a id="</style>')).css).toBe(
      ".message-html .custom-a { color: red }"
    )
  })
})

describe("document blocks", () => {
  it("classifies as Tavern Helper does", () => {
    expect(isDocumentBlock("<!DOCTYPE html><html><body>x</body></html>")).toBe(true)
    expect(isDocumentBlock("<head><style></style></head>")).toBe(true)
    expect(isDocumentBlock("<body>x</body>")).toBe(true)
    expect(isDocumentBlock("<div>x</div>")).toBe(false)
    expect(isDocumentBlock("const html = 1")).toBe(false)
  })

  const documentBlock = "```html\n<html><body>x</body></html>\n```"
  it("shows a document block in a frame", () => {
    const out = render(documentBlock)
    expect(out).not.toContain("&lt;html&gt;")
    expect(out).toContain('aria-hidden="true"')
  })

  it("shows Panel loading while its reply streams", () => {
    expect(render(documentBlock, { streaming: true })).toContain("Panel loading")
  })

  it("leaves an older message's panel for Run panel", () => {
    expect(render(documentBlock, { panelDepth: 2, fromTip: 2 })).toContain("Run panel")
    expect(render(documentBlock, { panelDepth: 2, fromTip: 1 })).not.toContain("Run panel")
    expect(render(documentBlock, { fromTip: 50 })).not.toContain("Run panel")
  })

  it("says a panel has scripts that don't run, with the button that allows its card's", () => {
    const scripted = "```html\n<html><body><p>HP</p><script>document.body.append('!')</script></body></html>\n```"
    const asking: PanelPermit = {
      scripts: false,
      network: false,
      ask: { name: "Lantern Inn", allow: async () => true }
    }
    expect(render(scripted, { permit: asking })).toContain("Run scripts from Lantern Inn")
    expect(render(scripted, { permit: asking })).toContain("This panel has scripts.")
    // Running, without scripts of its own, or with no one to ask: no strip.
    expect(render(scripted, { permit: { scripts: true, network: false, ask: null } })).not.toContain("Run scripts")
    expect(render(documentBlock, { permit: asking })).not.toContain("Run scripts")
    expect(render(scripted)).not.toContain("Run scripts")
  })

  it("leaves a document block as code without a frame renderer", () => {
    disposers.forEach((dispose) => dispose())
    const partial = [
      htmlSchemas.register({ id: "html.inline", order: 0, schema: htmlSchema }),
      htmlClassifiers.register({ id: "html.classifier", order: 0, isDocument: isDocumentBlock })
    ]
    try {
      expect(render(documentBlock)).toContain("&lt;html&gt;")
    } finally {
      partial.forEach((dispose) => dispose())
      disposers = registerHtmlParts()
    }
  })
})

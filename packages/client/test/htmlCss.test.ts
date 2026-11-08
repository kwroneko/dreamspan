// A message's CSS under the message-body scope (ui/html/css.ts, spec/HTML-MESSAGES.md §3.2).
import { describe, expect, it } from "vitest"
import { cleanStyle, loads, renameSelector, scopeCss } from "../src/ui/html/css.ts"

const scoped = (css: string) => scopeCss(css).css.replace(/\s+/g, " ").trim()

describe("scopeCss", () => {
  it("prefixes every selector and renames classes and ids", () => {
    expect(scoped(".box, #hp > p.x { color: red }")).toBe(
      ".message-html .custom-box, .message-html #user-content-hp > p.custom-x { color: red }"
    )
  })

  it("keeps Font Awesome and note class names", () => {
    expect(scoped(".fa-heart, .note-x, .monospace { color: red }")).toBe(
      ".message-html .fa-heart, .message-html .note-x, .message-html .monospace { color: red }"
    )
  })

  it("leaves strings and attribute selectors as written", () => {
    expect(renameSelector('a[href="#x.y"]::after')).toBe('a[href="#x.y"]::after')
    expect(renameSelector('.a:not([data-x=".b"])')).toBe('.custom-a:not([data-x=".b"])')
  })

  it("scopes inside @media and @supports, and unwraps @layer", () => {
    expect(scoped("@media (max-width: 600px) { .a { color: red } } @layer x { .b { color: blue } }")).toBe(
      "@media (max-width: 600px) { .message-html .custom-a { color: red } } .message-html .custom-b { color: blue }"
    )
  })

  it("renames nested rules without scoping them again", () => {
    expect(scoped(".a { color: red; .b { color: blue } }")).toBe(
      ".message-html .custom-a { color: red; .custom-b { color: blue } }"
    )
  })

  it("drops @import and other global at-rules", () => {
    expect(
      scoped(
        '@import url("https://example.com/a.css"); @import "b.css"; @namespace svg url(x); @page { margin: 0 } .a { color: red }'
      )
    ).toBe(".message-html .custom-a { color: red }")
  })

  it("drops declarations that load from elsewhere, and reports remote ones", () => {
    const result = scopeCss(
      ".a { background: url(https://example.com/a.png); color: red } .b { background-image: url(data:image/png;base64,AA==) } .c { background: url(a.png) }"
    )
    expect(result.blocked).toBe(true)
    expect(result.css.replace(/\s+/g, " ")).toBe(
      ".message-html .custom-a { color: red } .message-html .custom-b { background-image: url(data:image/png;base64,AA==) } .message-html .custom-c { }"
    )
  })

  it("sees through escapes and comments", () => {
    expect(loads("u\\72l(https://example.com/a.png)").loads).toBe(true)
    expect(loads("url(/**/https://example.com/a.png)").loads).toBe(true)
    expect(loads('image-set("a.png" 1x)').loads).toBe(true)
    expect(loads("expression(alert(1))").loads).toBe(true)
    expect(loads("url(#g)").loads).toBe(false)
  })

  it("renames keyframes and fonts with their uses, and drops fonts that load", () => {
    expect(
      scoped(
        "@keyframes pulse { from { opacity: 0 } to { opacity: 1 } } .a { animation: pulse 1s } @font-face { font-family: Card; src: url(https://example.com/f.woff2) } .b { font-family: Card, serif }"
      )
    ).toBe(
      "@keyframes custom-pulse { from { opacity: 0 } to { opacity: 1 } } .message-html .custom-a { animation: custom-pulse 1s } .message-html .custom-b { font-family: custom-Card, serif }"
    )
  })

  it("renames in-document references", () => {
    expect(scoped(".a { fill: url(#g) }")).toBe(".message-html .custom-a { fill: url(#user-content-g) }")
  })

  it("drops font faces whose families cannot be safely renamed", () => {
    for (const family of [String.raw`"\49 nter"`, String.raw`\49 nter`, '"SF Mono"'])
      expect(scopeCss(`@font-face { font-family: ${family}; src: local("FreeMono") }`).css).toBe("")
    expect(scopeCss(String.raw`@font-face { f\6f nt-family: Inter; src: local("FreeMono") }`).css).toBe("")
    expect(scoped('@font-face { font-family: "Card"; src: local("FreeMono") }')).toContain('"custom-Card"')
  })

  it("leaves unparsable CSS out whole", () => {
    expect(scopeCss(".a { color: red").css).toBe("")
    expect(scopeCss('.a { content: "').css).toBe("")
  })

  it("rejects selectors that can escape through a sibling or a nesting alternative", () => {
    for (const selector of ["+ main", "~ main", "/* card */ + main"])
      expect(scopeCss(`${selector} { color: red }`).css).not.toContain("color: red")
    for (const selector of [":is(&, body) main", "body &", "& + :is(&, body) main"])
      expect(scopeCss(`.box { ${selector} { color: red } }`).css).not.toContain("color: red")
    expect(scoped(".box { &:hover { color: red } & > span { color: blue } }")).toBe(
      ".message-html .custom-box { &:hover { color: red } & > span { color: blue } }"
    )
  })

  it("handles invalid Unicode escapes in hostile declarations without throwing", () => {
    expect(() => scopeCss(String.raw`.box { color: \ffffff }`)).not.toThrow()
    expect(() => cleanStyle(String.raw`color: \110000`)).not.toThrow()
    expect(() => loads(String.raw`url(\ffffff)`)).not.toThrow()
  })
})

describe("cleanStyle", () => {
  it("keeps declarations that load nothing", () => {
    expect(cleanStyle("color: red; background: url(https://example.com/a.png); fill: url(#g)")).toEqual({
      style: "color: red; fill: url(#user-content-g)",
      blocked: true
    })
  })

  it("splits at semicolons outside strings and brackets", () => {
    expect(cleanStyle('content: "a; b"; color: red').style).toBe('content: "a; b"; color: red')
  })
})

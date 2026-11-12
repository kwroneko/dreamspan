// A message's CSS under the message-body scope (ui/html/css.ts, spec/HTML-MESSAGES.md §3.2).
import { describe, expect, it } from "vitest"
import { cleanPresentation, cleanStyle, scopeCss, type ScopeMode } from "../src/ui/html/css.ts"
import { stylesheetViolations, valueViolations } from "./support/cssInvariants.ts"

const scoped = (css: string, mode: ScopeMode = "prefix") => scopeCss(css, null, mode).css

describe("scopeCss", () => {
  it("prefixes every selector and renames classes and ids", () => {
    expect(scoped(".box, #hp > p.x { color: red }")).toBe(
      ".message-html .custom-box,.message-html #user-content-hp > p.custom-x{color: red;}"
    )
  })

  it("wraps rules in @scope where the browser has it, with the same specificity", () => {
    expect(scoped(".box, #hp > p.x { color: red }", "scope")).toBe(
      "@scope (.message-html){:scope .custom-box,:scope #user-content-hp > p.custom-x{color: red;}}"
    )
    expect(scoped("@keyframes k { to { opacity: 1 } } .a { animation: k 1s }", "scope")).toBe(
      "@keyframes custom-k{to {opacity: 1;}}@scope (.message-html){:scope .custom-a{animation: custom-k 1s;}}"
    )
    expect(scoped("@import url(x.css);", "scope")).toBe("")
  })

  it("keeps Font Awesome and note class names", () => {
    expect(scoped(".fa-heart, .note-x, .monospace { color: red }")).toBe(
      ".message-html .fa-heart,.message-html .note-x,.message-html .monospace{color: red;}"
    )
  })

  it("leaves strings and attribute selectors as written", () => {
    expect(scoped('a[href="#x.y"]::after { content: "." }')).toBe('.message-html a[href="#x.y"]::after{content: ".";}')
    expect(scoped('.a:not([data-x=".b"]) { color: red }')).toBe(
      '.message-html .custom-a:not([data-x=".b"]){color: red;}'
    )
  })

  it("scopes inside @media and @supports, and unwraps @layer", () => {
    expect(scoped("@media (max-width: 600px) { .a { color: red } } @layer x { .b { color: blue } }")).toBe(
      "@media (max-width: 600px){.message-html .custom-a{color: red;}}.message-html .custom-b{color: blue;}"
    )
  })

  it("renames nested rules without scoping them again", () => {
    expect(scoped(".a { color: red; .b { color: blue } }")).toBe(
      ".message-html .custom-a{color: red;.custom-b{color: blue;}}"
    )
  })

  it("drops @import and other global at-rules", () => {
    expect(
      scoped(
        '@import url("https://example.com/a.css"); @import "b.css"; @namespace svg url(x); @page { margin: 0 } @property --x { syntax: "*" } .a { color: red }'
      )
    ).toBe(".message-html .custom-a{color: red;}")
  })

  it("drops declarations that load from elsewhere, and reports remote ones", () => {
    const result = scopeCss(
      ".a { background: url(https://example.com/a.png); color: red } .b { background-image: url(data:image/png;base64,AA==) } .c { background: url(a.png) }",
      null,
      "prefix"
    )
    expect(result.blocked).toBe(true)
    expect(result.css).toBe(
      '.message-html .custom-a{color: red;}.message-html .custom-b{background-image: url("data:image/png;base64,AA==");}.message-html .custom-c{}'
    )
  })

  it("refuses escaped, commented and indirect loading forms", () => {
    for (const value of [
      String.raw`u\72l(https://example.com/a.png)`,
      "url(/**/https://example.com/a.png)",
      'image-set("a.png" 1x)',
      'image("a.png")',
      "cross-fade(url(data:image/png,a), red)",
      "element(#x)",
      "paint(worklet)",
      'src("a.png")',
      "expression(alert(1))",
      "-webkit-image-set(url(data:image/png,a) 1x)",
      "attr(data-src type(<url>))"
    ])
      expect(scoped(`.a { background: ${value}; color: red }`)).toBe(".message-html .custom-a{color: red;}")
    expect(scoped(".a { fill: url(#g) }")).toBe('.message-html .custom-a{fill: url("#user-content-g");}')
  })

  it("renames keyframes and fonts with their uses, and drops fonts that load", () => {
    expect(
      scoped(
        "@keyframes pulse { from { opacity: 0 } to { opacity: 1 } } .a { animation: pulse 1s } @font-face { font-family: Card; src: url(https://example.com/f.woff2) } .b { font-family: Card, serif }"
      )
    ).toBe(
      "@keyframes custom-pulse{from {opacity: 0;}to {opacity: 1;}}.message-html .custom-a{animation: custom-pulse 1s;}.message-html .custom-b{font-family: custom-Card, serif;}"
    )
  })

  it("renames escaped family names as read, and drops faces whose families aren't one plain name", () => {
    expect(
      scoped(String.raw`@font-face { font-family: "\49 nter"; src: local("FreeMono") } .a { font-family: Inter }`)
    ).toBe(
      '@font-face{font-family: "custom-Inter";src: local("FreeMono");}.message-html .custom-a{font-family: custom-Inter;}'
    )
    expect(scoped(String.raw`@font-face { font-family: \49 nter; src: local("FreeMono") }`)).toContain("custom-Inter")
    for (const family of ['"SF Mono"', "SF Mono", "a, b"])
      expect(scoped(`@font-face { font-family: ${family}; src: local("FreeMono") }`)).toBe("")
    expect(scoped(String.raw`@font-face { f\6f nt-family: Inter; src: local("FreeMono") }`)).toBe("")
    expect(scoped('@font-face { font-family: "Card"; src: local("FreeMono") format("woff2") }')).toBe(
      '@font-face{font-family: "custom-Card";src: local("FreeMono") format("woff2");}'
    )
  })

  it("leaves CSS out whole when the tokenizer or parser reports an error", () => {
    for (const css of [".a { color: red", '.a { content: "', ".a { color: red } /* open", ".a{x:1}}", ".a{x:(}"])
      expect(scoped(css)).toBe("")
  })

  it("rejects selectors that can escape through a sibling or a nesting alternative", () => {
    for (const selector of ["+ main", "~ main", "/* card */ + main", "|| main"])
      expect(scoped(`${selector} { color: red }`)).not.toContain("color: red")
    for (const selector of [":is(&, body) main", "body &", "& + :is(&, body) main"])
      expect(scoped(`.box { ${selector} { color: red } }`)).not.toContain("color: red")
    expect(scoped(".box { &:hover { color: red } & > span { color: blue } }")).toBe(
      ".message-html .custom-box{&:hover{color: red;}& > span{color: blue;}}"
    )
  })

  it("handles invalid Unicode escapes in hostile declarations without throwing", () => {
    expect(() => scopeCss(String.raw`.box { color: \ffffff }`)).not.toThrow()
    expect(() => cleanStyle(String.raw`color: \110000`)).not.toThrow()
    expect(() => cleanPresentation(String.raw`url(\ffffff)`)).not.toThrow()
  })

  it("keeps grid functions and font formats", () => {
    expect(scoped(".g { grid-template-columns: repeat(3, minmax(0, 1fr)) }")).toBe(
      ".message-html .custom-g{grid-template-columns: repeat(3, minmax(0, 1fr));}"
    )
  })
})

/**
 * The class review 2 and this audit found: postcss read a string across a line break where the
 * browser ends it (a "bad string"), so text after it was a selector to us and a new global rule
 * to the browser. The CSS Syntax tokenizer refuses bad strings, and the written output is
 * tokenized again before it's used.
 */
describe("parser differentials", () => {
  const ESCAPES = [
    '.a[title="x\n]{}body{color:red}/*"]{color:blue}',
    '@media x"\n{}body{color:red}/*"{.a{color:blue}}',
    '.a{color:red}\n.b"\n{}body{background:red}/*"{color:blue}',
    '.a{--x:"\n;}body{color:red}/*"}',
    ".a { color: red\\7d html\\7b display\\3a none }",
    '.a { content: "\\\n}body{color:red}" }',
    ".a{color:red;}<!--}body{color:red}-->",
    ".a{width:calc(1px + 2px}body{color:red}",
    ".a{color:red\\}body{color:red}",
    ".a{x:url(a\n}body{color:red})}",
    String.raw`.a\{{color:red}body{color:red}`,
    "@media all{.a{color:red}}}body{color:red}",
    ".c { content: \"' } html { display: none } '\" }",
    '.b { content: "url(https://media.invalid/p.png)" }'
  ]
  it.each(ESCAPES)("keeps every rule in the message: %j", (css) => {
    for (const mode of ["scope", "prefix"] as const)
      for (const consent of [false, true]) {
        const out = scopeCss(css, consent ? "chat=s" : null, mode).css
        expect(stylesheetViolations(out, consent)).toEqual([])
      }
  })

  it("never decodes an escape into syntax", () => {
    const css = ".a { color: red\\7d html\\7b display\\3a none; background: url(https://media.invalid/p.png) }"
    const out = scopeCss(css, "chat=synthetic", "prefix").css
    expect(stylesheetViolations(out, true)).toEqual([])
    // One identifier, its braces escaped as written: never a rule end.
    expect(out).toContain(String.raw`color: red\}html\{display\:none;`)
  })

  it("proxies plain url()s with consent, keeps quotes out of proxy addresses, and leaves url() in strings alone", () => {
    const out = scopeCss(
      [
        '.a { background: url("https://media.invalid/it\'s.png") }',
        '.b { content: "url(https://media.invalid/p.png)" }',
        ".c { background: url('https://media.invalid/p.png') }"
      ].join("\n"),
      "chat=s",
      "prefix"
    )
    expect(stylesheetViolations(out.css, true)).toEqual([])
    expect(out.css).toContain('url("/media/external?chat=s&url=https%3A%2F%2Fmedia.invalid%2Fit%27s.png")')
    expect(out.css).toContain('content: "url(https://media.invalid/p.png)"')
    expect(out.media).toHaveLength(2)
    // The browser reads an escaped url( as url( too, so it is the same address, proxied or refused.
    const escaped = String.raw`.a { background: u\72l(https://media.invalid/p.png) }`
    expect(scopeCss(escaped, "chat=s", "prefix").css).toContain(
      "/media/external?chat=s&url=https%3A%2F%2Fmedia.invalid"
    )
    expect(scopeCss(escaped, null, "prefix").css).toBe(".message-html .custom-a{}")
  })

  it("does not let custom properties carry an address into a loading function", () => {
    const out = scoped('.a{--x:"/media/external?chat=other&url=example";background:image-set(var(--x))}')
    expect(out).not.toContain("background")
    expect(scoped(".a{--x:url(https://example.com/a.png);background:var(--x)}")).toBe(
      ".message-html .custom-a{background: var(--x);}"
    )
  })

  it("bounds nesting and size before anything recursive walks the input", () => {
    expect(scoped("@media all{".repeat(5000) + ".a{color:red}" + "}".repeat(5000))).toBe("")
    expect(scoped(".a{width:" + "calc(".repeat(100_000) + "1px" + ")".repeat(100_000) + "}")).toBe("")
    expect(scopeCss(" ".repeat(200_001)).css).toBe("")
  })
})

describe("cleanStyle", () => {
  it("keeps declarations that load nothing, as a style object", () => {
    expect(cleanStyle("color: red; background: url(https://example.com/a.png); fill: url(#g)")).toEqual({
      style: { color: "red", fill: 'url("#user-content-g")' },
      blocked: true
    })
  })

  it("names properties as React does and keeps strings whole", () => {
    expect(
      cleanStyle('content: "a; b"; -webkit-text-stroke: 1px red; -ms-transform: none; --x: 1; Color: red').style
    ).toEqual({
      content: '"a; b"',
      WebkitTextStroke: "1px red",
      msTransform: "none",
      "--x": "1",
      color: "red"
    })
  })

  it("never lets a value hold declaration syntax", () => {
    for (const style of [
      'content: "\\22 ; } html { x: y"; color: red',
      'content: "a\n; background: url(https://example.com/x)"',
      "color: red/*;background-image:url(/x)*/",
      "a{color:red} color: blue",
      "background: u\\72l(/x)"
    ]) {
      const cleaned = cleanStyle(style, "chat=s").style ?? {}
      for (const value of Object.values(cleaned)) expect(valueViolations(value, true)).toEqual([])
    }
  })
})

describe("cleanPresentation", () => {
  it("keeps in-document references, renamed, and refuses every other address", () => {
    expect(cleanPresentation("url(#g)")).toBe('url("#user-content-g")')
    expect(cleanPresentation("red")).toBe("red")
    for (const value of [
      "url(https://example.com/x.svg#g)",
      "url(/x.svg#g)",
      String.raw`u\72l(/x.svg#g)`,
      "url(data:image/svg+xml,x)",
      'image-set("x" 1x)'
    ])
      expect(cleanPresentation(value)).toBeNull()
  })
})

// Negative controls: a checker that merely accepts the current output proves nothing.
describe("the independent CSS checker", () => {
  it.each([
    "body{color:red}",
    ".message-html + main{color:red}",
    "@scope (body){body{color:red}}",
    ".message-html .a{:is(&,body) main{color:red}}",
    ".message-html .a{main &{color:red}}",
    ".message-html .a{background:url(https://media.invalid/x)}",
    '@import "https://media.invalid/x";',
    '.message-html .a{background:image-set("https://media.invalid/x")}'
  ])("refuses unsafe output: %s", (css) => {
    expect(stylesheetViolations(css, false).length).toBeGreaterThan(0)
  })
})

it("scopes many sibling nested rules without rescanning their suffixes", { tags: ["slow"] }, () => {
  const started = performance.now()
  const result = scoped(".a{" + "b{}".repeat(15_000) + "color:red}")
  expect(result).toBe(".message-html .custom-a{" + "b{}".repeat(15_000) + "color: red;}")
  expect(performance.now() - started).toBeLessThan(2000)
})

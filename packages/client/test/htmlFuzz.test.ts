// Generated hostile input against the message HTML boundary's invariants: whatever CSS or HTML a
// message holds, the scoper's output keeps every rule inside the message and loads nothing it
// may not, and the rendered tree keeps nothing that runs or loads. Inputs come from a seeded
// generator, so a failure names its seed and repeats. The fast cases run with every check; the
// slow ones (`npm run test:slow`) run many more.
import { JSDOM } from "jsdom"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { StMarkdown } from "../src/ui/StMarkdown.tsx"
import { cleanPresentation, cleanStyle, scopeCss } from "../src/ui/html/css.ts"
import { HtmlMessageContext } from "../src/ui/html/messageHtml.ts"
import { registerHtmlParts } from "../src/ui/html/register.ts"
import { declarationListViolations, stylesheetViolations, valueViolations } from "./support/cssInvariants.ts"

/** mulberry32: a small seeded generator. */
function generator(seed: number) {
  let state = seed >>> 0
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32
  }
  const int = (below: number) => Math.floor(next() * below)
  const pick = <T>(list: ReadonlyArray<T>): T => list[int(list.length)]!
  const some = (count: number, make: () => string, join = "") => Array.from({ length: 1 + int(count) }, make).join(join)
  return { next, int, pick, some }
}
type Random = ReturnType<typeof generator>

// CSS pieces: what parsers disagree on (strings across lines, escapes, comments, CDO/CDC, bad
// urls), what loads (url forms, image functions), what escapes the scope (global selectors and
// at-rules), and plain syntax characters dropped anywhere.
const NASTY = [
  '"',
  "'",
  "\n",
  "\\",
  "\\\n",
  "/*",
  "*/",
  "<!--",
  "-->",
  "{",
  "}",
  ";",
  ":",
  ",",
  "(",
  ")",
  "[",
  "]",
  "@",
  "\\7d ",
  "\\7b ",
  "\\3a ",
  "\\22 ",
  "\\0 ",
  "\\",
  "\u0000",
  "�",
  "\r\n",
  "\f",
  "!important",
  "&",
  "|"
]
const LOADS = [
  "url(https://media.invalid/a.png)",
  'url("https://media.invalid/b.png")',
  "url( 'https://media.invalid/c.png' )",
  "url(//media.invalid/d.png)",
  "url(a.png)",
  "url(/library/media?x)",
  "url(/media/external?chat=s&url=x)",
  "url(data:image/png;base64,AA==)",
  "url(#ref)",
  "url(javascript:alert(1))",
  String.raw`u\72l(https://media.invalid/e.png)`,
  String.raw`\75 rl(https://media.invalid/f.png)`,
  "URL(https://media.invalid/g.png)",
  'image-set("https://media.invalid/h.png" 1x)',
  'src("https://media.invalid/i.png")',
  "cross-fade(url(https://media.invalid/j.png), red)",
  "element(#x)",
  "paint(x)",
  "attr(data-x url)",
  "expression(alert(1))",
  "url(https://media.invalid/k.png",
  'url("https://media.invalid/l.png\n")',
  "url(https://media.invalid/(m).png)",
  "var(--x, url(https://media.invalid/n.png))"
]
const VALUES = [
  "red",
  "rgb(1, 2, 3)",
  "calc(1px + 2px)",
  "var(--x)",
  "env(safe-area-inset-top)",
  "1px solid red",
  '"text"',
  "'te;xt}'",
  '"a\\"b"',
  "linear-gradient(red, blue)",
  "k 1s infinite",
  "none",
  "inherit",
  "-webkit-box",
  "0 0 1px #fff",
  "repeat(2, 1fr)",
  ...LOADS
]
const PROPERTIES = [
  "color",
  "background",
  "background-image",
  "content",
  "animation",
  "font-family",
  "src",
  "cursor",
  "list-style",
  "border-image",
  "mask",
  "filter",
  "position",
  "--x",
  "--y",
  "behavior",
  "-moz-binding",
  "-webkit-mask-image",
  "COLOR",
  "c\\olor",
  "unicode-range"
]
const SELECTORS = [
  ".a",
  "#b",
  "p",
  "*",
  "body",
  "html",
  ":root",
  ":is(body) .a",
  ":where(html, .a)",
  ":has(> .b)",
  "a[href^=https]",
  '[title="x"]',
  "[title='}body{color:red}']",
  ".a::before",
  "&",
  "& .b",
  "> .c",
  "+ .d",
  "~ .e",
  "|f",
  "*|*",
  ":host",
  "::slotted(p)",
  ":scope",
  ".message-html",
  ".a,",
  ".\\31 x",
  ".a\\{",
  "#\\7d"
]
const AT_RULES = [
  "@import url(https://media.invalid/a.css);",
  '@import "b.css";',
  "@namespace svg url(x);",
  '@charset "utf-8";',
  "@layer x;",
  "@layer x { ",
  "@media (max-width: 600px) { ",
  '@media x"\n{}body{',
  "@supports (display: grid) { ",
  "@supports selector(:has(a)) { ",
  "@container (min-width: 1px) { ",
  "@starting-style { ",
  "@scope (body) { ",
  "@scope (.a) to (.b) { ",
  "@document url(https://media.invalid/) { ",
  "@-moz-document url-prefix() { ",
  "@page { ",
  "@property --x { ",
  "@font-feature-values x { ",
  "@keyframes k { ",
  "@-webkit-keyframes k { ",
  "@font-face { ",
  "@font-face { font-family: Inter; src: url(https://media.invalid/i.woff2) format('woff2') } ",
  "@keyframes k { from { background: url(https://media.invalid/k.png) } to { opacity: 1 } } "
]
const LEGIT = [
  ".box { color: red; background: linear-gradient(red, blue) } #hp > p.x { width: calc(100% - 2px) }",
  "@media (max-width: 600px) { .a { color: red } } @layer x { .b { color: blue } }",
  ".a { color: red; .b { color: blue } &:hover { color: green } }",
  "@keyframes pulse { from { opacity: 0 } to { opacity: 1 } } .p { animation: pulse 1s infinite }",
  "@font-face { font-family: Inter; src: url(data:font/woff2;base64,AA==) } .t { font-family: Inter, sans-serif }",
  '.q::before { content: "\\201C"; color: rgb(1 2 3 / 50%) } .q:not([data-x=".b"]) { margin: 0 auto }',
  ".g { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); background: url(#pattern) }",
  ".h { background-image: url(https://media.invalid/bg.png); border: 1px solid #ccc }"
]

const declaration = (random: Random) =>
  `${random.pick(PROPERTIES)}${random.pick([":", ": ", " : ", ":\n"])}${random.some(2, () => random.pick(VALUES), " ")}${random.pick(["", " !important", "", ""])}`

/** A construct one reader ends where another doesn't (a string or comment across a line), with a
 * global rule in between and a comment hiding the rest from the other reader: the shape the
 * parser-differential escapes took. */
const PAIRS = [
  ['"', '"'],
  ["'", "'"],
  ["url(", ")"],
  ["/*", "*/"],
  ['[title="x', '"]'],
  ["[title='x", "']"],
  [':not([x="', '"])'],
  ['@media x"', '"'],
  ["<!--", "-->"],
  ["\\", ""],
  ["(", ")"]
] as const
const BREAKS = ["\n", "\r\n", "\r", "\f", "\\\n", "", "\n"]
const MIDDLES = ["]{}", "{}", "}", ")}", ";}", "", "]){}"]
function splitRule(random: Random): string {
  const declarations = () => random.some(2, () => declaration(random), ";")
  const [open, close] = random.pick(PAIRS)
  const hide = random.pick(["/*", "/*", "", "<!--"])
  return `${random.pick(SELECTORS)}${open}${random.pick(BREAKS)}${random.pick(MIDDLES)}${random.pick(["body", "html", "*", ":root", "a"])}{${declarations()}}${hide}${close}${random.pick(["", "]", ")"])}{${declarations()}}`
}

function hostileCss(random: Random): string {
  const split = () => splitRule(random)
  const rule = (): string => {
    switch (random.int(7)) {
      case 0:
        return random.pick(AT_RULES) + rule() + random.pick(["}", "", "}}"])
      case 1:
        return random.some(3, () => random.pick(NASTY))
      case 2:
        return split()
      default:
        return `${random.some(2, () => random.pick(SELECTORS), random.pick([", ", " ", ","]))} { ${random.some(3, () => declaration(random), random.pick(["; ", ";", ";\n"]))} }`
    }
  }
  const css = random.some(5, rule, random.pick(["\n", " ", ""]))
  return random.next() < 0.3 ? mutate(random, css) : css
}

/** A legitimate stylesheet, or any text, with pieces inserted, deleted and repeated at random. */
function mutate(random: Random, text: string): string {
  let out = text
  for (let edit = 0, edits = 1 + random.int(6); edit < edits; edit++) {
    const at = random.int(out.length + 1)
    switch (random.int(3)) {
      case 0:
        out = out.slice(0, at) + random.pick([...NASTY, ...LOADS, ...SELECTORS]) + out.slice(at)
        break
      case 1:
        out = out.slice(0, at) + out.slice(at + 1 + random.int(8))
        break
      default:
        out = out.slice(0, at) + out.slice(at, at + 1 + random.int(12)).repeat(2) + out.slice(at)
    }
  }
  return out
}

const cssInput = (random: Random) => (random.next() < 0.25 ? mutate(random, random.pick(LEGIT)) : hostileCss(random))

const PLAIN_STYLE_NAME = /^(?:--[-\w]+|[a-zA-Z][a-zA-Z0-9]*)$/

function checkCss(seed: number) {
  const random = generator(seed)
  const css = cssInput(random)
  const where = `seed ${seed}: ${JSON.stringify(css)}`
  for (const mode of ["scope", "prefix"] as const)
    for (const consent of [false, true]) {
      const out = scopeCss(css, consent ? "chat=s" : null, mode)
      expect(stylesheetViolations(out.css, consent), `${where} (${mode}, consent ${consent}) -> ${out.css}`).toEqual([])
    }
  const style = random.some(4, () => (random.next() < 0.2 ? random.pick(NASTY) : declaration(random)), "; ")
  for (const consent of [false, true]) {
    const cleaned = cleanStyle(style, consent ? "chat=s" : null).style ?? {}
    for (const [name, value] of Object.entries(cleaned)) {
      expect(name, `seed ${seed}: style ${JSON.stringify(style)}`).toMatch(PLAIN_STYLE_NAME)
      expect(valueViolations(value, consent), `seed ${seed}: style ${JSON.stringify(style)} -> ${value}`).toEqual([])
    }
  }
  const presentation = random.some(2, () => random.pick([...VALUES, ...NASTY]), random.pick([" ", ""]))
  const kept = cleanPresentation(presentation)
  if (kept !== null)
    expect(valueViolations(kept, false, true), `seed ${seed}: ${JSON.stringify(presentation)} -> ${kept}`).toEqual([])
}

// HTML pieces: the elements and attributes sanitizers have been bypassed with, namespace
// switches (svg, math), raw-text elements, comments and CDATA, entity-encoded schemes, and
// Markdown around and inside them.
const TAGS = [
  "div",
  "p",
  "span",
  "b",
  "a",
  "img",
  "svg",
  "math",
  "mtext",
  "mglyph",
  "malignmark",
  "foreignObject",
  "desc",
  "title",
  "style",
  "script",
  "noscript",
  "template",
  "textarea",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
  "plaintext",
  "form",
  "input",
  "button",
  "select",
  "option",
  "table",
  "td",
  "object",
  "embed",
  "base",
  "meta",
  "link",
  "use",
  "image",
  "feImage",
  "animate",
  "set",
  "details",
  "summary",
  "video",
  "audio",
  "source",
  "picture",
  "rp-frame",
  "rp-media-blocked",
  "font",
  "center",
  "marquee"
]
const ATTRIBUTES = [
  "onerror=alert(1)",
  'onload="alert(1)"',
  "ontoggle=alert(1)",
  'href="javascript:alert(1)"',
  'href="jav&#x09;ascript:alert(1)"',
  'href=" JaVaScRiPt:alert(1)"',
  'href="data:text/html,x"',
  'href="https://media.invalid/"',
  'href="#x"',
  'xlink:href="https://media.invalid/a.svg#g"',
  'src="https://media.invalid/a.png"',
  "src=//media.invalid/b.png",
  'src="data:image/png;base64,AA=="',
  'src="data:image/svg+xml,&lt;svg onload=alert(1)&gt;"',
  'srcset="https://media.invalid/c.png 1x"',
  'poster="https://media.invalid/d.png"',
  'background="https://media.invalid/e.png"',
  'action="/auth/logout"',
  'formaction="javascript:alert(1)"',
  'style="color: red; background: url(https://media.invalid/f.png)"',
  'style="width: expression(alert(1)); color: blue"',
  'style="content: &quot;a;b&quot;; color: red"',
  'style="--x: &quot;\\&quot;; color: red"',
  'style="color: red\\; background: url(https://media.invalid/g.png)"',
  'style="behavior: url(x.htc)"',
  'fill="url(https://media.invalid/h.svg#g)"',
  'fill="url(#g)"',
  'stroke="u\\72l(https://media.invalid/i.svg#g)"',
  'filter="url(&quot;https://media.invalid/j.svg#f&quot;)"',
  'mask="url(#m)"',
  'cursor="url(https://media.invalid/k.cur), auto"',
  'class="a b"',
  'id="hp"',
  'name="user-content-x"',
  'attributeName="href"',
  'values="javascript:alert(1)"',
  'title="&lt;/style&gt;&lt;img src=x onerror=alert(1)&gt;"',
  'data-x="1"',
  "open",
  'is="x-y"',
  'slot="s"',
  'popover="auto"',
  'nonce="n"',
  'http-equiv="refresh" content="0;url=https://media.invalid/"'
]
const TEXT = [
  "text",
  " ",
  "\n",
  "\n\n",
  "**bold**",
  "*em*",
  "`<i>code</i>`",
  "```html\n<b>block</b>\n```\n",
  "```\n",
  "![alt](https://media.invalid/l.png)",
  "[link](javascript:alert(1))",
  "[ref]: https://media.invalid/m",
  "<!-- c -->",
  "<!--",
  "-->",
  "<![CDATA[",
  "]]>",
  "&lt;script&gt;",
  "&#60;img src=x onerror=alert(1)&#62;",
  "<",
  ">",
  '"',
  "'",
  "</",
  "/>",
  "|a|b|\n|-|-|\n",
  "> quote\n",
  "- item\n",
  "{{char}}",
  ".a { color: red }",
  "body { color: red }"
]

function hostileHtml(random: Random): string {
  const open = () => {
    const tag = random.pick(TAGS)
    const attributes = random.int(3) ? ` ${random.some(2, () => random.pick(ATTRIBUTES), " ")}` : ""
    return `<${random.next() < 0.1 ? tag.toUpperCase() : tag}${attributes}${random.pick([">", ">", "/>", " >", ""])}`
  }
  const node = (): string => {
    switch (random.int(5)) {
      case 0:
        return random.pick(TEXT)
      case 1:
        return `</${random.pick(TAGS)}>`
      case 2:
        return `<style>${hostileCss(random)}</style>`
      default:
        return open() + (random.next() < 0.5 ? node() : random.pick(TEXT))
    }
  }
  const html = random.some(8, node)
  return random.next() < 0.2 ? mutate(random, html) : html
}

/** Attributes the browser fetches, by element (`*`: any): without consent never from another site. */
const FETCHING: Record<string, ReadonlyArray<string>> = {
  "*": ["background"],
  img: ["src", "srcset"],
  source: ["src", "srcset"],
  video: ["src", "poster"],
  audio: ["src"],
  track: ["src"],
  input: ["src"],
  image: ["href", "xlink:href"],
  feimage: ["href", "xlink:href"]
}
/** An address the URL parser reads as another site's (or any scheme but data: images). */
const remote = (value: string) => {
  const address = value.replace(/[\t\n\r]/g, "").replace(/^[\0-\x20]+/, "")
  return /^(?:[a-z][a-z\d+.-]*:|[\\/]{2})/i.test(address) && !/^data:image\//i.test(address)
}
const PRESENTATION = new Set([
  "fill",
  "stroke",
  "filter",
  "clip-path",
  "mask",
  "marker-start",
  "marker-mid",
  "marker-end",
  "cursor"
])
/** Where the URL parser takes a link from a page of the app (`none:` if nowhere), `data:` images apart. */
function linkProtocol(value: string): string {
  try {
    const { protocol } = new URL(value, "https://app.invalid/chats/c")
    return protocol === "data:" && /^[\0-\x20]*data:image\//i.test(value) ? "data-image:" : protocol
  } catch {
    return "none:"
  }
}
/** One window for every case: a window per case runs the slow suite out of memory. */
const PARSER = new new JSDOM("").window.DOMParser()
const FORBIDDEN =
  "script, iframe, object, embed, base, meta, link, style, form, use, template, noscript, frame, frameset"

function checkHtml(seed: number) {
  const html = hostileHtml(generator(seed))
  const where = `seed ${seed}: ${JSON.stringify(html)}`
  let out: string
  try {
    out = renderToStaticMarkup(
      createElement(
        HtmlMessageContext,
        { value: { key: "slot" } },
        createElement(StMarkdown, { text: html, streaming: false })
      )
    )
  } catch (error) {
    throw new Error(`${where} threw`, { cause: error })
  }
  const document = PARSER.parseFromString(`<body>${out}</body>`, "text/html")
  expect(document.querySelectorAll(FORBIDDEN).length, `${where} -> ${out}`).toBe(0)
  for (const element of document.body.querySelectorAll("*"))
    for (const attribute of element.attributes) {
      const name = attribute.name.toLowerCase()
      const value = attribute.value
      const context = `${where}: <${element.localName} ${name}=${JSON.stringify(value)}>`
      expect(name, context).not.toMatch(/^on/)
      expect(["action", "formaction", "http-equiv", "srcdoc", "nonce", "popover", "is"], context).not.toContain(name)
      expect(value.replace(/[\s\0-\x1f]/g, ""), context).not.toMatch(/^(?:javascript|vbscript|data:text)/i)
      // A link goes where the URL parser takes it: the web, mail, or a place in the app or message.
      if (name === "href" || name === "xlink:href")
        expect(linkProtocol(value), context).toMatch(/^(?:https?|mailto|data-image|none):$/)
      const fetching = [...FETCHING["*"]!, ...(FETCHING[element.localName.toLowerCase()] ?? [])]
      if (fetching.includes(name))
        for (const address of name === "srcset" ? value.split(",") : [value])
          expect(remote(address), context).toBe(false)
      if (name === "style") expect(declarationListViolations(value, false), context).toEqual([])
      if (PRESENTATION.has(name)) expect(valueViolations(value, false, true), context).toEqual([])
    }
}

let disposers: Array<() => void> = []
beforeAll(() => {
  disposers = registerHtmlParts()
})
afterAll(() => disposers.forEach((dispose) => dispose()))

const seeds = (from: number, count: number) => Array.from({ length: count }, (_, index) => from + index)

describe("generated CSS keeps the stylesheet invariants", () => {
  it("on a fixed set of seeds", () => {
    const started = performance.now()
    for (const seed of seeds(1, 60)) checkCss(seed)
    // Each case scopes four times: a pathological one would show here as seconds.
    expect(performance.now() - started).toBeLessThan(10_000)
  })

  it("on many more", { tags: ["slow"], timeout: 120_000 }, () => {
    for (const seed of seeds(1_000, 1_500)) checkCss(seed)
  })
})

describe("generated HTML renders nothing that runs or loads", () => {
  it("on a fixed set of seeds", () => {
    for (const seed of seeds(1, 40)) checkHtml(seed)
  })

  it("on many more", { tags: ["slow"], timeout: 300_000 }, () => {
    for (const seed of seeds(1_000, 600)) checkHtml(seed)
  })
})

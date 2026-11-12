// @vitest-environment jsdom
// Message HTML reaches the DOM as the sanitized tree, built with DOM calls, never as markup text a
// parser reads again: so no mutation-XSS round trip (serialize, re-parse differently) exists. The
// renderer runs in a DOM here with every HTML string sink watched. Also: the text scans around the
// renderer give what their regexes gave, in linear time.
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { StMarkdown } from "../src/ui/StMarkdown.tsx"
import { extractStyles, hasImageSyntax, HtmlMessageContext, panelHasScripts } from "../src/ui/html/messageHtml.ts"
import { registerHtmlParts } from "../src/ui/html/register.ts"

let disposers: Array<() => void> = []
beforeAll(() => {
  disposers = registerHtmlParts()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
afterAll(() => disposers.forEach((dispose) => dispose()))

/** Every way a string becomes markup in a document, recording what it was given. */
function watchSinks(): { calls: string[]; restore: () => void } {
  const calls: string[] = []
  const restores: Array<() => void> = []
  const wrapSetter = (proto: object, name: string) => {
    const descriptor = Object.getOwnPropertyDescriptor(proto, name)
    if (!descriptor?.set) return
    Object.defineProperty(proto, name, {
      ...descriptor,
      set(value: unknown) {
        calls.push(`${name}: ${String(value)}`)
        descriptor.set!.call(this, value)
      }
    })
    restores.push(() => Object.defineProperty(proto, name, descriptor))
  }
  const wrapMethod = (proto: Record<string, unknown>, name: string) => {
    const original = proto[name]
    if (typeof original !== "function") return
    proto[name] = function (this: unknown, ...args: unknown[]) {
      calls.push(`${name}: ${args.map(String).join(", ")}`)
      return (original as (...args: unknown[]) => unknown).apply(this, args)
    }
    restores.push(() => (proto[name] = original))
  }
  wrapSetter(Element.prototype, "innerHTML")
  wrapSetter(Element.prototype, "outerHTML")
  wrapSetter(HTMLIFrameElement.prototype, "srcdoc")
  for (const [proto, name] of [
    [Element.prototype, "insertAdjacentHTML"],
    [Element.prototype, "setHTMLUnsafe"],
    [Document.prototype, "write"],
    [Document.prototype, "writeln"],
    [DOMParser.prototype, "parseFromString"],
    [Range.prototype, "createContextualFragment"]
  ] as const)
    wrapMethod(proto as unknown as Record<string, unknown>, name)
  return { calls, restore: () => restores.forEach((restore) => restore()) }
}

const HOSTILE = [
  '<svg></p><style><a id="</style><img src=1 onerror=alert(1)>">',
  '<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;/mglyph&gt;&lt;img&Tab;src=1&Tab;onerror=alert(1)&gt;">',
  '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
  "<form><math><mtext></form><form><mglyph><style></math><img src onerror=alert(1)>",
  '<div style="color: red; background: url(https://example.com/x)" title="&lt;script&gt;">styled</div>',
  '<svg><rect fill="url(https://example.com/x.svg#g)" stroke="url(#s)"/></svg>',
  "<template><img src=x onerror=alert(1)></template><textarea></textarea><img src=x onerror=alert(1)></textarea>",
  "**bold** <b>raw</b> `<i>code</i>` ![x](https://example.com/a.png)",
  "```mermaid\ngraph TD; A-->B\n```",
  "<details open><summary>s</summary><p onclick=x()>p</p></details>"
]

describe("the DOM is built from the tree", () => {
  it("passes no markup string to an HTML parser, and keeps nothing that runs", async () => {
    const container = document.createElement("div")
    document.body.append(container)
    const root = createRoot(container)
    const { calls, restore } = watchSinks()
    // The watch sees a sink when one is used.
    document.createElement("div").innerHTML = "<b>seen</b>"
    new DOMParser().parseFromString("<b>seen</b>", "text/html")
    expect(calls).toHaveLength(2)
    calls.length = 0
    let styled: HTMLElement | undefined
    try {
      for (const text of HOSTILE) {
        await act(async () => {
          root.render(
            createElement(HtmlMessageContext, { value: { key: "slot" } }, createElement(StMarkdown, { text, streaming: false }))
          )
        })
        expect(
          container.querySelectorAll("script, iframe, object, embed, style, form, template, noscript")
        ).toHaveLength(0)
        for (const element of container.querySelectorAll("*"))
          for (const attribute of element.attributes) {
            expect(attribute.name).not.toMatch(/^on/i)
            expect(attribute.value).not.toMatch(/example\.com/)
          }
        styled ??= container.querySelector<HTMLElement>("div[title]") ?? undefined
        // A kept style attribute is set property by property: its loading part is gone.
        if (styled) {
          expect(styled.style.color).toBe("red")
          expect(styled.style.background).toBe("")
        }
      }
    } finally {
      restore()
    }
    expect(styled).toBeDefined()
    expect(calls).toEqual([])
    root.unmount()
    container.remove()
  })
})

describe("text scans", () => {
  const OLD_SCRIPTS = /<script\b|<[^>]*\son[a-z]+\s*=/i
  const OLD_IMAGE = /!\[.*?\]/
  const OLD_STYLE = /<style\b[^>]*>([\s\S]*?)(?:<\/style\s*>|$)/gi
  const PIECES = [
    "<",
    ">",
    "<style",
    "<STYLE ",
    "</style>",
    "</style  >",
    "<style-note>",
    " on",
    "onclick=",
    "=",
    "![",
    "]",
    "\n",
    "x",
    " ",
    "<script",
    "a{b}"
  ]
  const random = (seed: number) => () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31

  it("give what their regexes gave on random text", () => {
    const next = random(7)
    for (let run = 0; run < 2000; run++) {
      const text = Array.from(
        { length: 1 + Math.floor(next() * 12) },
        () => PIECES[Math.floor(next() * PIECES.length)]
      ).join("")
      expect(panelHasScripts(text)).toBe(OLD_SCRIPTS.test(text))
      expect(hasImageSyntax(text)).toBe(OLD_IMAGE.test(text))
      expect(extractStyles(text)).toEqual([...text.matchAll(OLD_STYLE)].map((match) => match[1]))
    }
  })

  it("finish quickly on runs the regexes took seconds over", { tags: ["slow"] }, () => {
    const started = performance.now()
    extractStyles("<style ".repeat(40_000))
    panelHasScripts("< on".repeat(70_000))
    hasImageSyntax("![".repeat(140_000))
    expect(performance.now() - started).toBeLessThan(1000)
  })
})

// A heading is never repeated right under itself (owner, 2026-11-23: a "Created after" popover
// over a field labelled "Created after"), and no visible label is a generic word stuck before a
// parameter's or panel's name ("All sites", "Any creator", "Any of these tags"): those come from
// code that turns whatever a source sends into a generic control, which the app doesn't have.
// The shared components refuse a repeat at run time (ui/titledContainer.tsx); the layout audit
// reports one on screen (e2e/support/layoutAudit.ts, "repeat"); this checks the code.
import { readdirSync, readFileSync } from "node:fs"
import { relative, resolve } from "node:path"
import { createElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import ts from "typescript"
import { describe, expect, it } from "vitest"
import { Checkbox, Switch } from "../src/ui/Choice.tsx"
import { Field, Fieldset, Input } from "../src/ui/Field.tsx"
import { InlinePanel } from "../src/ui/InlinePanel.tsx"
import { Slider } from "../src/ui/Slider.tsx"
import { Disclosure } from "../src/ui/Surface.tsx"
import { TitledContainer, TitleRepeated, shownText, titleWords } from "../src/ui/titledContainer.tsx"
import { TooltipProvider } from "../src/ui/Tooltip.tsx"

const root = resolve(import.meta.dirname, "../..")
const sources = (dir: string): Array<string> =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name)
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(path)
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts") ? [path] : []
  })
const files = ["client/src", "server/src", "shared/src"].flatMap((dir) => sources(resolve(root, dir)))
const parse = (file: string) =>
  ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
const walk = (node: ts.Node, visit: (node: ts.Node) => void) => {
  visit(node)
  node.forEachChild((child) => walk(child, visit))
}
const where = (file: string, source: ts.SourceFile, node: ts.Node) =>
  `${relative(root, file)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`

/** A generic word, then a name: a label made from whatever was passed in. */
const GENERIC = /(?:^|\s)(?:All|Any|Any of these|Every)\s+$/
/** What names a parameter or a panel, never a count ("All ${versions.length}" is a number). */
const NAMED = /(?:label|title|name|unit|group|param|heading|kind|id)\b/i
const COUNT = /\.(?:length|size|total|count)\b|toLocaleString|\bcount\b/i

/**
 * Generic labels a file may still hold while it's being rebuilt, by file. Lower each count as
 * they go and delete the entry at zero: the check fails until it matches. None now.
 */
const PENDING: Record<string, number> = {}

describe("generic labels built from names", () => {
  const found = files.flatMap((file) => {
    const source = parse(file)
    const hits: Array<string> = []
    const named = (expr: ts.Node | undefined) => {
      const text = expr?.getText(source) ?? ""
      return NAMED.test(text) && !COUNT.test(text)
    }
    walk(source, (node) => {
      if (ts.isTemplateExpression(node)) {
        if (GENERIC.test(node.head.text) && named(node.templateSpans[0]?.expression))
          hits.push(`${where(file, source, node)} ${node.getText(source).slice(0, 80)}`)
        for (const [i, span] of node.templateSpans.entries())
          if (GENERIC.test(span.literal.text) && named(node.templateSpans[i + 1]?.expression))
            hits.push(`${where(file, source, node)} ${node.getText(source).slice(0, 80)}`)
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
        ts.isStringLiteralLike(node.left) &&
        GENERIC.test(node.left.text) &&
        named(node.right)
      )
        hits.push(`${where(file, source, node)} ${node.getText(source).slice(0, 80)}`)
      else if (ts.isJsxText(node) && GENERIC.test(node.text.replace(/\s+$/, " "))) {
        const siblings = node.parent
          .getChildren(source)
          .flatMap((c) => (c.kind === ts.SyntaxKind.SyntaxList ? c.getChildren(source) : [c]))
        const next = siblings[siblings.indexOf(node) + 1]
        if (next && ts.isJsxExpression(next) && named(next.expression))
          hits.push(`${where(file, source, node)} ${node.text.trim()} {${next.expression?.getText(source)}}`)
      }
    })
    return hits
  })

  it("finds none outside the archive filter bar being rebuilt", () => {
    const outside = found.filter((hit) => !Object.keys(PENDING).some((file) => hit.startsWith(file)))
    expect(outside).toEqual([])
    for (const [file, count] of Object.entries(PENDING))
      expect(
        found.filter((hit) => hit.startsWith(file)),
        `${file}: lower PENDING as labels go`
      ).toHaveLength(count)
  })

  it("catches the shapes it looks for", () => {
    expect(GENERIC.test("All ")).toBe(true)
    expect(GENERIC.test("Any of these ")).toBe(true)
    expect(GENERIC.test("Install ")).toBe(false)
    expect(NAMED.test("panel.title.toLowerCase()") && !COUNT.test("panel.title.toLowerCase()")).toBe(true)
    expect(NAMED.test("versions.length") && !COUNT.test("versions.length")).toBe(false)
  })
})

/** Containers whose title names what they hold, and the attribute their title is in. */
const TITLED: Record<string, string> = {
  Popover: "title",
  Dialog: "title",
  ConfirmDialog: "title",
  Sheet: "title",
  InlinePanel: "title",
  Disclosure: "title",
  Fieldset: "legend"
}
/** The shared components that show their label (Segmented's, a toolbar's, are names only), and where. */
const SHOWN: Record<string, string> = {
  Field: "label",
  Slider: "label",
  ...TITLED
}

describe("titled containers in the code", () => {
  it("never pass their title as a visible label inside", () => {
    const hits = files
      .filter((file) => file.endsWith(".tsx") && !file.includes("/ui/"))
      .flatMap((file) => {
        const source = parse(file)
        const out: Array<string> = []
        const attr = (el: ts.JsxOpeningLikeElement, name: string) =>
          el.attributes.properties.find(
            (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText(source) === name
          )
        const value = (a: ts.JsxAttribute | undefined) => {
          const init = a?.initializer
          if (!init) return undefined
          if (ts.isStringLiteral(init)) return `"${init.text}"`
          if (ts.isJsxExpression(init) && init.expression)
            return ts.isStringLiteralLike(init.expression)
              ? `"${init.expression.text}"`
              : init.expression.getText(source)
          return undefined
        }
        walk(source, (node) => {
          if (!ts.isJsxElement(node)) return
          const tag = node.openingElement.tagName.getText(source)
          const title = value(attr(node.openingElement, TITLED[tag] ?? ""))
          if (!TITLED[tag] || title === undefined) return
          for (const child of node.children)
            walk(child, (inner) => {
              const el = ts.isJsxElement(inner)
                ? inner.openingElement
                : ts.isJsxSelfClosingElement(inner)
                  ? inner
                  : undefined
              if (!el || attr(el, "labelHidden") || attr(el, "titleHidden")) return
              const name = SHOWN[el.tagName.getText(source)]
              if (name && value(attr(el, name)) === title)
                out.push(`${where(file, source, el)} <${tag} ${TITLED[tag]}=${title}> holds ${name}=${title}`)
              if (ts.isJsxElement(inner) && /^(Checkbox|Switch)$/.test(el.tagName.getText(source))) {
                const text = inner.children
                  .map((c) => (ts.isJsxText(c) ? c.text : `{${c.getText(source)}}`))
                  .join("")
                  .trim()
                if (text === `{${title}}` || `"${text}"` === title)
                  out.push(
                    `${where(file, source, el)} <${tag} ${TITLED[tag]}=${title}> holds a checkbox labelled ${title}`
                  )
              }
            })
        })
        return out
      })
    expect(hits).toEqual([])
  })
})

describe("the shared components refuse a repeat", () => {
  const render = (node: ReactNode) => renderToStaticMarkup(createElement(TooltipProvider, null, node))
  const inside = (title: string, node: ReactNode) => render(createElement(TitledContainer, { title, children: node }))
  const field = (label: ReactNode, extra: object = {}) =>
    createElement(Field, { label, ...extra, children: createElement(Input, { defaultValue: "" }) })

  it("compares the words shown, not case, spacing or punctuation", () => {
    expect(titleWords("Created after ?")).toBe("created after")
    expect(shownText(["Created", createElement("span", { className: "sr-only" }, " (hidden)"), " after"])).toBe(
      "Created   after"
    )
  })

  it("throws for a field, checkbox, switch, slider, legend, panel or section titled like its container", () => {
    expect(() => inside("Created after", field("Created after"))).toThrow(TitleRepeated)
    expect(() => inside("Created after", field(createElement("span", null, "created  after:")))).toThrow(TitleRepeated)
    expect(() =>
      inside(
        "Hide forks",
        createElement(Checkbox, { checked: false, onCheckedChange: () => {}, children: "Hide forks" })
      )
    ).toThrow(TitleRepeated)
    expect(() =>
      inside("Hide forks", createElement(Switch, { checked: false, onCheckedChange: () => {}, children: "Hide forks" }))
    ).toThrow(TitleRepeated)
    expect(() =>
      inside(
        "Width",
        createElement(Slider, {
          label: "Width",
          value: 1,
          min: 0,
          max: 2,
          step: 1,
          valueText: String,
          onValueChange: () => {},
          onValueCommitted: () => {}
        })
      )
    ).toThrow(TitleRepeated)
    expect(() => inside("Sites", createElement(Fieldset, { legend: "Sites", children: "x" }))).toThrow(TitleRepeated)
    expect(() =>
      inside("Find", createElement(InlinePanel, { title: "Find", onClose: () => {}, children: "x" }))
    ).toThrow(TitleRepeated)
    expect(() => inside("Advanced", createElement(Disclosure, { title: "Advanced", children: "x" }))).toThrow(
      TitleRepeated
    )
    // Nested: the legend gives its own title to the fields under it.
    expect(() => render(createElement(Fieldset, { legend: "Dates", children: field("Dates") }))).toThrow(TitleRepeated)
    expect(() =>
      render(createElement(InlinePanel, { title: "Find", onClose: () => {}, children: field("Find") }))
    ).toThrow(TitleRepeated)
    expect(() =>
      render(createElement(Disclosure, { title: "Advanced", defaultOpen: true, children: field("Advanced") }))
    ).toThrow(TitleRepeated)
  })

  it("are given by every titled container to what it holds", () => {
    // Popovers, dialogs and sheets render into a portal, which a static render leaves out.
    for (const name of ["Popover", "Dialog", "Sheet"]) {
      const text = readFileSync(resolve(import.meta.dirname, `../src/ui/${name}.tsx`), "utf8")
      expect(text, name).toMatch(/<TitledContainer title=\{title\}>\{children\}<\/TitledContainer>/)
    }
    const dialogs = readFileSync(resolve(import.meta.dirname, "../src/ui/Dialog.tsx"), "utf8")
    expect(dialogs.match(/<TitledContainer title=\{title\}>/g)).toHaveLength(2)
  })

  it("lets the title name a field whose label is hidden, and other words show", () => {
    expect(inside("Created after", field("Created after", { labelHidden: true }))).toContain("sr-only")
    expect(inside("Created", field("From"))).toContain("From")
    expect(render(field("Created after"))).toContain("Created after")
    // A panel whose own title is hidden leaves its field to show the words.
    expect(
      render(
        createElement(InlinePanel, { title: "Find", titleHidden: true, onClose: () => {}, children: field("Find") })
      )
    ).toContain("Find")
  })
})

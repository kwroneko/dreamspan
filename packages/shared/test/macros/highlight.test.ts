import { describe, expect, it } from "vitest"
import { highlightMacros } from "../../src/macros/highlight.ts"
import { builtinRegistry } from "./support.ts"

const registry = builtinRegistry()
const spans = (text: string) =>
  highlightMacros(text, registry).map((token) => [text.slice(token.from, token.to), token.kind])

describe("macro highlighting", () => {
  it("classifies every builtin and alias from the registry", () => {
    const directives = new Set([
      "space",
      "newline",
      "noop",
      "trim",
      "if",
      "else",
      "reverse",
      "//",
      "comment",
      "banned",
      ...["", "global"].flatMap((infix) => [
        `set${infix}var`,
        `add${infix}var`,
        `inc${infix}var`,
        `dec${infix}var`,
        `delete${infix}var`,
        `flush${infix}var`,
        `set${infix}varkey`,
        `set${infix}varindex`
      ])
    ])
    for (const entry of registry.list()) {
      expect(entry.kind, entry.id).toBe(directives.has(entry.id) ? "directive" : "value")
      expect(entry.kind).toBe(registry.get(entry.name.toLowerCase())?.kind)
    }
    for (const name of directives) expect(registry.get(name)?.kind, name).toBe("directive")
  })

  it("uses nested parser spans and :: arguments", () => {
    expect(spans("Hello {{random::{{char}}::{{user}}}} {{setvar::x::{{roll::1d6}}}}")).toEqual([
      ["{{random::", "value"],
      ["{{char}}", "value"],
      ["::", "value"],
      ["{{user}}", "value"],
      ["}}", "value"],
      ["{{setvar::x::", "directive"],
      ["{{roll::1d6}}", "value"],
      ["}}", "directive"]
    ])
  })

  it("dims whole comments, including macros in their arguments and scoped content", () => {
    expect(spans("{{// ignore {{char}}}} {{COMMENT::{{user}}}} {{//}}body {{roll::6}}{{///}}")).toEqual([
      ["{{// ignore {{char}}}}", "comment"],
      ["{{COMMENT::{{user}}}}", "comment"],
      ["{{//}}body {{roll::6}}{{///}}", "comment"]
    ])
  })

  it("marks scoped openers and closers as directives without coloring their prose", () => {
    expect(spans("{{#if::1}}yes {{trim}} {{char}} {{/trim}}{{else}}no{{/IF}}")).toEqual([
      ["{{#if::1}}", "directive"],
      ["{{trim}}", "directive"],
      ["{{char}}", "value"],
      ["{{/trim}}", "directive"],
      ["{{else}}", "directive"],
      ["{{/IF}}", "directive"]
    ])
  })

  it("leaves unknown and malformed macros unstyled while finding known children", () => {
    expect(spans("{{unknown::{{user}}}} {{unknown}}hello{{/unknown}} {{not known")).toEqual([["{{user}}", "value"]])
    expect(spans("{{random::{{unknown}}::{{user}}}}")).toEqual([
      ["{{random::", "value"],
      ["::", "value"],
      ["{{user}}", "value"],
      ["}}", "value"]
    ])
    expect(spans("{{char's}} {{getvar::x}} {{.x}} {{.x=2}} {{$x++}}")).toEqual([
      ["{{char's}}", "value"],
      ["{{getvar::x}}", "value"],
      ["{{.x}}", "value"],
      ["{{.x=2}}", "directive"],
      ["{{$x++}}", "directive"]
    ])
  })
})

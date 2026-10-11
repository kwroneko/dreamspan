// Vectors from SillyTavern's tests/frontend/MacroEngine.e2e.js (at 06bde939), run against
// test macros that behave like ST's, with ST's test names "User" and "Character". Vectors
// marked "unsure" were derived from reading ST's source rather than from its tests.
import { describe, expect, it } from "vitest"
import { evaluateMacros } from "../../src/macros/engine.ts"
import { parse } from "../../src/macros/parse.ts"
import type { MacroSpec } from "../../src/macros/registry.ts"
import { registryWith } from "./support.ts"

const flagsSeen: Array<string> = []
const order: Array<string> = []
const specs: ReadonlyArray<MacroSpec> = [
  { name: "user", handler: (call) => call.context.names.user },
  { name: "char", handler: (call) => call.context.names.char },
  { name: "group", aliases: ["charIfNotGroup"], handler: (call) => call.context.names.char },
  {
    name: "newline",
    args: [{ name: "count", optional: true, type: "integer" }],
    handler: (c) => "\n".repeat(Number(c.args[0] ?? 1))
  },
  { name: "reverse", args: [{ name: "value" }], handler: (call) => Array.from(call.args[0]!).reverse().join("") },
  {
    name: "trim",
    args: [{ name: "content", optional: true }],
    handler: (c) => (c.isScoped ? (c.args[0] ?? "") : "{{trim}}")
  },
  { name: "join", list: true, handler: (call) => call.list.join("|") },
  {
    name: "bounded",
    args: [{ name: "a" }],
    list: { min: 1, max: 2 },
    handler: (c) => [...c.args, ...c.list].join("|")
  },
  { name: "three", args: [{ name: "a" }, { name: "b" }, { name: "c" }], handler: (c) => c.args.join("-") },
  { name: "strict-int", args: [{ name: "v", type: "integer" }], handler: (c) => `#${c.args[0]}#` },
  { name: "loose-int", args: [{ name: "v", type: "integer" }], strictArgs: false, handler: (c) => `#${c.args[0]}#` },
  {
    name: "flags",
    handler: (call) => {
      flagsSeen.push(call.flags)
      return `[${[...call.flags].join(",") || "none"}]`
    }
  },
  { name: "scoped", args: [{ name: "content" }], handler: (call) => `isScoped:${call.isScoped}` },
  {
    name: "outer",
    args: [{ name: "content" }],
    handler: (call) => {
      order.push("outer")
      return `[outer:${call.args[0]}]`
    }
  },
  {
    name: "inner",
    handler: () => {
      order.push("inner")
      return "INNER"
    }
  },
  { name: "raw", args: [{ name: "content" }], delayArgResolution: true, handler: (call) => `<${call.args[0]}>` },
  { name: "fails", handler: () => JSON.parse("{") as string }
]
const registry = registryWith(specs)
const run = (text: string) =>
  evaluateMacros(text, { registry, context: { names: { user: "User", char: "Character" } } })

const vectors = (cases: ReadonlyArray<readonly [string, string]>) =>
  it.each(cases)("%j → %j", (input, output) => expect(run(input)).toBe(output))

describe("basic evaluation", () => {
  vectors([
    ["Hello world, no macros here.", "Hello world, no macros here."],
    ["Start {{newline}} end.", "Start \n end."],
    ["{{char}}{{user}}", "CharacterUser"],
    ["{{  user  }}", "User"],
    ["{{USER}} {{User}}", "User User"]
  ])
})

describe("arguments", () => {
  vectors([
    ["Reversed: {{reverse::abc}}!", "Reversed: cba!"],
    ["Reversed: {{reverse:abc}}!", "Reversed: cba!"],
    // After a single colon or a space, the rest is one argument, separators included.
    ["Reversed: {{reverse:abc::def}}!", "Reversed: fed::cba!"],
    ["Reversed: {{reverse:abc:def}}!", "Reversed: fed:cba!"],
    ["Values: {{reverse abc def}}!", "Values: fed cba!"],
    ["{{reverse::  spaced  }}", "decaps"],
    ["{{reverse::with:single:colons}}", "snoloc:elgnis:htiw"],
    ["Result: {{reverse::first line\nsecond line}}", "Result: enil dnoces\nenil tsrif"],
    ["{{join::a::b::c}}", "a|b|c"],
    ["{{join::}}", ""],
    ["{{join ::a::b}}", "a|b"],
    ["{{join::a:::b}}", "a|:b"]
  ])
})

describe("nested macros", () => {
  vectors([
    ["Result: {{reverse::{{user}}{{char}}}}", "Result: retcarahCresU"],
    ["{{join::{{user}}::{{reverse::{{char}}}}}}", "User|retcarahC"]
  ])
})

describe("unknown macros stay as written, with nested macros expanded", () => {
  vectors([
    ["Test: {{unknown::{{newline}}}}", "Test: {{unknown::\n}}"],
    ["Test: {{unknown::my {{newline}} example}}", "Test: {{unknown::my \n example}}"],
    ["{{toString}} {{constructor}} {{hasOwnProperty}}", "{{toString}} {{constructor}} {{hasOwnProperty}}"]
  ])
})

describe("braces around and inside macros", () => {
  vectors([
    ["Test§ {{reverse::my { test}}", "Test§ tset { ym"],
    ["Test§ {{reverse::my } test}}", "Test§ tset } ym"],
    ["Test {{ hehe", "Test {{ hehe"],
    ["Test {{§§ hehe", "Test {{§§ hehe"],
    ["Before {{ hehe After", "Before {{ hehe After"],
    ["Test {{ hehe {{user}}", "Test {{ hehe User"],
    ["Test {{&& hehe {{user}}", "Test {{&& hehe User"],
    ["{{{char}}", "{Character"],
    ["{{char}}}", "Character}"],
    ["{{{char}}}", "{Character}"],
    ["{{{{char}}", "{{Character"],
    ["{{char}}}}", "Character}}"],
    ["{{{{char}}}}", "{{Character}}"],
    ["Result: {{reverse::pre-{ {{user}} }-post}}", "Result: tsop-} resU {-erp"],
    ["{{char}}{ {{user}} }", "Character{ User }"],
    ["Line1 {{char}}\r\n{Line2}", "Line1 Character\r\n{Line2}"],
    ["Foo }} bar", "Foo }} bar"],
    ["Foo }} {{user}}", "Foo }} User"],
    ["Foo {{user}} }}", "Foo User }}"],
    ["{{}}", "{{}}"],
    ["{{!}}", "{{!}}"],
    // Escaped braces lose their backslash after evaluation.
    ["a \\{\\{user\\}\\} b", "a {{user}} b"]
  ])
})

describe("lexer recovery after an identifier (unsure)", () => {
  // Chevrotain drops characters that can't follow an identifier, up to the next
  // whitespace, ":", "|" or "}", so these resolve as if the junk weren't there.
  vectors([
    ["{{char's}}", "Character"],
    ["{{reverse's abc}}", "cba"],
    ["{{inside{{macro}}me}}", "{{inside{{macro}}me}}"]
  ])
})

describe("arity and types", () => {
  vectors([
    ["Start {{char::extra}} end.", "Start {{char::extra}} end."],
    ["Result: {{reverse}}", "Result: {{reverse}}"],
    ["Result: {{reverse::a::b}}", "Result: {{reverse::a::b}}"],
    ["A {{bounded::base}} B {{bounded::base::x::y::z}}", "A {{bounded::base}} B {{bounded::base::x::y::z}}"],
    ["{{bounded::base::x::y}}", "base|x|y"],
    ["Result: {{user Something {{char}}}}", "Result: {{user Something Character}}"],
    ["Value: {{strict-int::abc}}", "Value: {{strict-int::abc}}"],
    ["Value: {{strict-int:: 12 }}", "Value: #12#"],
    ["Value: {{loose-int::abc}}", "Value: #abc#"],
    ["{{fails}}", "{{fails}}"]
  ])
})

describe("flags", () => {
  vectors([
    ["Hello {{#user}}!", "Hello User!"],
    ["{{/unknown}}", "{{/unknown}}"],
    ["{{/user}}", "{{/user}}"],
    ["{{/reverse::test}}", "{{/reverse::test}}"],
    ["Hello {{user}}, this {{/char}} is raw, bye {{char}}!", "Hello User, this {{/char}} is raw, bye Character!"],
    ["{{flags}} / {{!flags}} / {{!?flags}}", "[none] / [!] / [!,?]"],
    ["{{ ! ? > flags }}", "[!,?,>]"],
    ["{{!reverse::hello}}", "olleh"]
  ])
})

describe("scoped blocks", () => {
  vectors([
    ["{{reverse}}hello{{/reverse}}", "olleh"],
    ["{{reverse}}{{/reverse}}", ""],
    ["{{reverse}}\n  abc  \n{{/reverse}}", "cba"],
    ["{{#reverse}}\n  abc  \n{{/reverse}}", "\n  cba  \n"],
    ["{{reverse}}hello{{/REVERSE}}", "olleh"],
    ["{{trim}}  hello world  {{/trim}}", "hello world"],
    ["{{trim}}  outer {{trim}}  inner  {{/trim}} outer  {{/trim}}", "outer inner outer"],
    ["{{trim}}  Hello {{user}}  {{/trim}}", "Hello User"],
    ["{{scoped}}content{{/scoped}} {{scoped::content}}", "isScoped:true isScoped:false"],
    // A macro that takes no block stays as written, and its contents are evaluated.
    ["{{user}}Hello {{char}}!{{/user}}", "{{user}}Hello Character!{{/user}}"],
    // So does one whose arguments are already full, unevaluated.
    ["{{reverse::x}}a{{user}}b{{/reverse}}", "{{reverse::x}}aUserb{{/reverse}}"],
    ["{{three::first}}second{{/three}}", "{{three::first}}second{{/three}}"],
    ["{{three::a::b}}c{{/three}}", "a-b-c"],
    ["Before {{/reverse}} After", "Before {{/reverse}} After"],
    ["{{reverse}}ab{{/reverse}}{{/reverse}}", "ba{{/reverse}}"],
    ["{{reverse}}x{{/char}}", "{{reverse}}x{{/char}}"],
    ["{{reverse}}a{{reverse}}bc{{/reverse}}d{{/reverse}}", "dbca"],
    ["{{join}}a{{/join}}", "{{join}}a{{/join}}"],
    ["{{reverse}}  line1\n    line2\n  line3{{/reverse}}", "3enil\n2enil  \n1enil"],
    // A delayed macro gets its block raw and untrimmed.
    ["{{raw}} {{user}} {{/raw}}", "< {{user}} >"],
    // Unknown macros accept a block and are written back the way ST builds them (unsure).
    ["{{foo}}bar{{/foo}}", "{{foo}}bar}}"],
    ["{{foo::x}}\n bar \n{{/foo}}", "{{foo::x}}bar}}"]
  ])

  it("evaluates the block before the macro", () => {
    order.length = 0
    expect(run("{{outer}}before {{inner}} after{{/outer}}")).toBe("[outer:before INNER after]")
    expect(order).toEqual(["inner", "outer"])
  })
})

describe("legacy syntax", () => {
  vectors([
    ["foo\n\n{{trim}}\n\nbar", "foobar"],
    ["A\n\n{{trim}}\n\nB\n\n{{trim}}\n\nC", "ABC"],
    ["A\r\n{{TRIM}}\r\nB", "AB"],
    ["A\r\r\n{{trim}}\n\rB", "A\r\rB"],
    ["Hello <USER>!", "Hello User!"],
    ["Bot: <BOT>, Char: <CHAR>.", "Bot: Character, Char: Character."],
    ["Group: <GROUP>, CharIfNotGroup: <CHARIFNOTGROUP>.", "Group: Character, CharIfNotGroup: Character."],
    ["{{setvar::x::<user>}}", "{{setvar::x::User}}"]
  ])
})

describe("parse", () => {
  it("trims arguments and keeps nested macros by position", () => {
    const text = "{{a:: x {{b}} ::y}}"
    const nodes = parse(text, 8)
    expect(nodes).not.toBe("depth")
    const [node] = nodes as ReadonlyArray<{ kind: string; args: ReadonlyArray<{ start: number; end: number }> }>
    expect(node!.args.map((arg) => text.slice(arg.start, arg.end))).toEqual(["x {{b}}", "y"])
  })

  it.each([
    ["{{.my-var}}", "my-var", undefined, undefined],
    ["{{ .x += 5 }}", "x", "+=", "5"],
    ["{{$counter--}}", "counter", "--", undefined],
    ["{{.myvar--5}}", "myvar--5", undefined, undefined],
    ["{{.x-=2}}", "x", "-=", "2"],
    ["{{.x ??= {{user}} }}", "x", "??=", "{{user}}"]
  ])("parses the variable shorthand %j", (text, name, operator, value) => {
    const nodes = parse(text, 8)
    expect(nodes).not.toBe("depth")
    const node = (nodes as ReadonlyArray<import("../../src/macros/parse.ts").Node>)[0]!
    expect(node.kind).toBe("var")
    if (node.kind !== "var") return
    expect(node.name).toBe(name)
    expect(node.operator).toBe(operator)
    expect(node.value && text.slice(node.value.start, node.value.end)).toBe(value)
  })

  it.each(["{{.x++5}}", "{{.x -- 5}}", "{{.}}", "{{.x ~ 1}}", "{{a:}}", "{{a: }}"])("leaves %j literal", (text) => {
    expect(parse(text, 8)).toEqual([])
  })
})

// Variable vectors. Most come from SillyTavern's tests/frontend/MacroEngine.e2e.js (at
// 06bde939); those derived from reading public/scripts/variables.js are marked unsure.
import { describe, expect, it } from "vitest"
import type { MacroContext } from "../../src/macros/context.ts"
import { expand, type TextOrigin } from "../../src/macros/expand.ts"
import { builtinRegistry } from "./support.ts"

const registry = builtinRegistry()

type Vars = { readonly local?: Record<string, unknown>; readonly global?: Record<string, unknown> }

const run = (
  text: string,
  variables: Vars = {},
  origin: TextOrigin = { kind: "preset" },
  card?: MacroContext["card"]
) =>
  expand({
    text,
    origin,
    registry,
    context: {
      names: { user: "User", char: "Character" },
      now: 0,
      timeZone: "UTC",
      variables,
      ...(card ? { card } : {})
    },
    random: () => 0.5
  })

const vectors = (cases: ReadonlyArray<readonly [string, string]>, variables: Vars = {}) =>
  it.each(cases)("%j → %j", (input, output) => expect(run(input, variables).text).toBe(output))

describe("variable macros", () => {
  vectors([
    ["A {{setvar::test::4}}{{getvar::test}} B {{setvar::test::2}}{{getvar::test}} C", "A 4 B 2 C"],
    ["Result: {{setvar::test::0}}{{reverse::{{addvar::test::100}}{{getvar::test}}}}{{setvar::test::0}}", "Result: 001"],
    [
      "Result: {{setvar::addvname::test}}{{addvar::{{getvar::addvname}}::{{setvar::test::5}}{{getvar::test}}}}{{getvar::test}}",
      "Result: 10"
    ],
    ["{{setvar::flag::}}[{{getvar::flag}}]", "[]"],
    ["{{incvar::n}}{{incvar::n}}{{decvar::m}}", "12-1"],
    ["{{setglobalvar::g::x}}{{getglobalvar::g}}[{{getvar::g}}]", "x[]"],
    ["{{addglobalvar::g::2}}{{incglobalvar::g}}{{decglobalvar::g}}{{getglobalvar::g}}", "322"],
    ["{{hasvar::myvar}}{{deletevar::myvar}}{{hasvar::myvar}}", "falsefalse"],
    ["{{setvar::a::1}}{{varexists::a}}{{flushvar::a}}{{varexists::a}}", "truefalse"],
    // An empty name is an error in ST, so the macro stays as written.
    ["{{setvar::::x}}|{{incvar::}}", "{{setvar::::x}}|{{incvar::}}"]
  ])
  vectors([["{{hasvar::myvar}}{{deletevar::myvar}}{{hasvar::myvar}}", "truefalse"]], { local: { myvar: "value" } })
  vectors([["{{hasvar::myvar}}", "true"]], { local: { myvar: "" } })
  vectors([["{{hasglobalvar::myvar}}{{deleteglobalvar::myvar}}{{hasglobalvar::myvar}}", "truefalse"]], {
    global: { myvar: "value" }
  })
  vectors([["{{if {{hasvar::myvar}} == true}}exists{{else}}missing{{/if}}", "exists"]], { local: { myvar: "" } })
})

describe("ST's value handling (unsure)", () => {
  vectors([
    // Numeric text reads back as a number.
    ["{{setvar::a::007}}{{getvar::a}}|{{setvar::b:: 5 }}{{getvar::b}}|{{setvar::c::1e3}}{{getvar::c}}", "7|5|1000"],
    // addvar's start is `value || 0`, so "0" then text drops the 0.
    ["{{setvar::z::0}}{{addvar::z::abc}}{{getvar::z}}", "abc"],
    ["{{setvar::s::abc}}{{addvar::s::1}}{{getvar::s}}", "abc1"],
    ["{{setvar::n::5}}{{addvar::n::3}}{{getvar::n}}", "8"],
    ["{{setvar::arr::[1,2]}}{{addvar::arr::3}}{{getvar::arr}}|{{incvar::arr}}", '[1,2,"3"]|[1,2,"3",1]'],
    ["{{setvarkey::obj::a::1}}{{getvarkey::obj::a}}|{{getvar::obj}}", '1|{"a":"1"}'],
    ["{{setvarindex::list::1::x}}{{getvar::list}}|{{getvarindex::list::1}}", '[null,"x"]|x'],
    // "}}" ends a macro even after a backslash, so JSON objects go in a block.
    ['{{setvar::o}}{"a":{"b":2}}{{/setvar}}{{getvarkey::o::a}}', '{"b":2}'],
    ['{{setvar::o::{"a":1\\}}}', "}"],
    // getvarkey on a value that isn't JSON returns all of it; on JSON null, 0.
    ["{{setvar::p::plain}}{{getvarkey::p::0}}|{{setvar::q::null}}{{getvarkey::q::0}}", "plain|0"],
    ['{{setvar::str::"abc"}}{{getvarkey::str::1}}', "b"],
    // A key on a primitive is dropped, as ST's strict-mode assignment is.
    ["{{setvar::num::5}}{{setvarkey::num::k::v}}{{getvar::num}}", "5"],
    ["{{setglobalvarkey::go::k::v}}{{getglobalvarkey::go::k}}", "v"]
  ])
})

describe("scoped variable blocks", () => {
  vectors([
    ["{{setvar::myvar}}Hello World{{/setvar}}{{getvar::myvar}}", "Hello World"],
    ["{{setvar::myvar::test value}}{{getvar::myvar}}", "test value"],
    ["{{setvar::myvar}}test value{{/setvar}}{{getvar::myvar}}", "test value"],
    ["{{setvar::myvar}}Hello {{user}}!{{/setvar}}{{getvar::myvar}}", "Hello User!"],
    [
      "{{setvar::outer}}before {{setvar::inner}}nested{{/setvar}} after{{/setvar}}{{getvar::outer}} | {{getvar::inner}}",
      "before  after | nested"
    ],
    ["{{setvar::a}}first{{/setvar}}{{setvar::b}}second{{/setvar}}[{{getvar::a}}][{{getvar::b}}]", "[first][second]"],
    ["{{setvar::myvar}}content{{/setvar}}{{/setvar}}{{getvar::myvar}}", "{{/setvar}}content"],
    ["{{setvar::empty}}{{/setvar}}[{{getvar::empty}}]", "[]"],
    ["{{setvar::multi}}Line 1\nLine 2\nLine 3{{/setvar}}{{getvar::multi}}", "Line 1\nLine 2\nLine 3"],
    ["Before {{setvar::x}}value{{/setvar}} After {{getvar::x}}", "Before  After value"],
    [
      "{{setvar::l1}}A{{setvar::l2}}B{{setvar::l3}}C{{/setvar}}B{{/setvar}}A{{/setvar}}{{getvar::l1}}|{{getvar::l2}}|{{getvar::l3}}",
      "AA|BB|C"
    ],
    ["{{setvar::x}}content{{/getvar}}{{getvar::x}}", "{{setvar::x}}content{{/getvar}}"],
    ["{{setvar::special}}Hello { world } :: test{{/setvar}}{{getvar::special}}", "Hello { world } :: test"],
    ["{{setvar::myvar::existing}}extra{{/setvar}}{{getvar::myvar}}", "{{setvar::myvar::existing}}extra{{/setvar}}"],
    ["{{setvar::outer}}A{{setvar::inner}}B{{/setvar}}C{{/setvar}}{{getvar::outer}}|{{getvar::inner}}", "AC|B"],
    ["{{setvar::ws}}   {{/setvar}}[{{getvar::ws}}]", "[]"],
    ["{{#setvar::ws}}   {{/setvar}}[{{getvar::ws}}]", "[   ]"],
    ["{{setvar::x}}value{{/setvar}}result:{{getvar::x}}", "result:value"],
    ["prefix {{setvar::x}}value{{/setvar}}", "prefix "],
    [
      "{{setvar::a}}1{{/setvar}}{{setvar::b}}2{{/setvar}}{{setvar::c}}3{{/setvar}}{{getvar::a}}{{getvar::b}}{{getvar::c}}",
      "123"
    ],
    ["{{setvar::x}}{{user}}{{/setvar}}{{getvar::x}}", "User"],
    [
      "{{setvar::a}}first{{/setvar}}middle{{setvar::b}}second{{/setvar}}[{{getvar::a}}][{{getvar::b}}]",
      "middle[first][second]"
    ],
    ["{{setvar::x}}value{{/setvar}}{{/user}}{{getvar::x}}", "{{/user}}value"],
    ["{{setvar::testvar::{{reverse}}hello{{/reverse}}}} {{getvar::testvar}}", " olleh"],
    ["{{setvar::testvar::{{if true}}true branch{{/if}}}} {{getvar::testvar}}", " true branch"],
    ["{{setvar::testvar::{{if 0}}wrong{{else}}correct{{/if}}}} {{getvar::testvar}}", " correct"],
    ["{{setvar::testvar::{{reverse}}ab{{/reverse}}-{{reverse}}cd{{/reverse}}}} {{getvar::testvar}}", " ba-dc"],
    ["{{setvar::outer::{{setvar::inner::{{reverse}}xyz{{/reverse}}}}{{getvar::inner}}}} {{getvar::outer}}", " zyx"],
    ["{{setvar::testvar::before {{reverse}}mid{{/reverse}} after}} {{getvar::testvar}}", " before dim after"],
    ["{{setvar::myvar::prefix-{{reverse}}abc{{/reverse}}-suffix}}{{getvar::myvar}}", "prefix-cba-suffix"],
    ["{{setvar::testvar::{{if true}}\ntrue\nbranch\n{{/if}}}} {{getvar::testvar}}", " true\nbranch"]
  ])
})

describe("scoped content is trimmed and dedented", () => {
  vectors([
    ["{{setvar::myvar}}\n  content with whitespace  \n{{/setvar}}[{{getvar::myvar}}]", "[content with whitespace]"],
    ["{{setvar::myvar}}\n\n\ntext{{/setvar}}[{{getvar::myvar}}]", "[text]"],
    ["{{setvar::myvar}}text\n\n\n{{/setvar}}[{{getvar::myvar}}]", "[text]"],
    ["{{setvar::myvar}}\n  line1\n  line2  \n{{/setvar}}[{{getvar::myvar}}]", "[line1\nline2]"],
    ["{{#setvar::myvar}}\n  content  \n{{/setvar}}[{{getvar::myvar}}]", "[\n  content  \n]"],
    ["{{#setvar::myvar}}\n\ntext{{/setvar}}[{{getvar::myvar}}]", "[\n\ntext]"],
    ["{{#setvar::myvar}}text\n\n{{/setvar}}[{{getvar::myvar}}]", "[text\n\n]"],
    ["{{#setvar::myvar}}\n  {{char}}  \n{{/setvar}}[{{getvar::myvar}}]", "[\n  Character  \n]"],
    ["{{setvar::myvar}}\n  {{char}}  \n{{/setvar}}[{{getvar::myvar}}]", "[Character]"],
    ["{{setvar::myvar}}\n  # Heading\n  Content here\n{{/setvar}}[{{getvar::myvar}}]", "[# Heading\nContent here]"],
    ["{{setvar::myvar}}\n    line1\n    line2\n    line3\n{{/setvar}}[{{getvar::myvar}}]", "[line1\nline2\nline3]"],
    ["{{setvar::myvar}}\n  parent\n    child\n  sibling\n{{/setvar}}[{{getvar::myvar}}]", "[parent\n  child\nsibling]"],
    [
      "{{setvar::myvar}}\n  # Header\n    - item1\n    - item2\n  Paragraph\n{{/setvar}}[{{getvar::myvar}}]",
      "[# Header\n  - item1\n  - item2\nParagraph]"
    ],
    ["{{#setvar::myvar}}\n  # Heading\n  Content\n{{/setvar}}[{{getvar::myvar}}]", "[\n  # Heading\n  Content\n]"],
    ["{{setvar::myvar}}\n  single line\n{{/setvar}}[{{getvar::myvar}}]", "[single line]"],
    ["{{setvar::myvar}}\n  line1\n\n  line2\n{{/setvar}}[{{getvar::myvar}}]", "[line1\n\nline2]"],
    [
      "{{setvar::myvar}}\n  First Line\n    Second Line, more indented\n  Third line\n    Fourth line, also more indented\n{{/setvar}}[{{getvar::myvar}}]",
      "[First Line\n  Second Line, more indented\nThird line\n  Fourth line, also more indented]"
    ]
  ])
})

describe("if with variables", () => {
  vectors([
    ["{{setvar::flag::yes}}{{if {{getvar::flag}}}}shown{{/if}}", "shown"],
    ["{{setvar::flag::}}{{if {{getvar::flag}}}}hidden{{/if}}[end]", "[end]"],
    ["{{setvar::flag::false}}{{if {{getvar::flag}}}}hidden{{/if}}[end]", "[end]"],
    ["{{setvar::emptyVar::}}{{if !{{getvar::emptyVar}}}}Empty var{{/if}}", "Empty var"],
    ["{{setvar::bangVar::!hello}}{{if {{getvar::bangVar}}}}Has value{{else}}No value{{/if}}", "Has value"],
    ["{{.ready = yes}}{{if .ready}}Ready!{{/if}}", "Ready!"],
    ["{{if .nonexistent}}Yes{{else}}No{{/if}}", "No"]
  ])
  vectors([["{{if .flag}}Yes{{/if}}|{{if !.flag}}Not set{{/if}}", "Yes|"]], { local: { flag: "1" } })
  vectors([["[{{if .flag}}Yes{{/if}}]{{if !.flag}}Not set{{/if}}{{if ! .flag}}!{{/if}}", "[]Not set!"]], {
    local: { flag: "" }
  })
  vectors([["{{if $enabled}}Active{{/if}}{{if !$disabled}}Enabled{{/if}}", "ActiveEnabled"]], {
    global: { enabled: "true", disabled: "" }
  })
  vectors([["{{if .active}}On{{else}}Off{{/if}}{{if .is-valid}}Valid{{/if}}", "OnValid"]], {
    local: { active: "yes", "is-valid": "1" }
  })
  vectors([["{{if .count}}Count: {{.count}}{{/if}}", "Count: 42"]], { local: { count: "42" } })
  vectors([["{{if .count}}Has count{{else}}No count{{/if}}", "No count"]], { local: { count: "0" } })

  it.each([
    ["{{if 0}}{{setvar::v::should-not-set}}{{/if}}", []],
    ["{{if 1}}{{setvar::v::was-set}}{{/if}}", [["v", "was-set"]]],
    ["{{if 0}}{{setvar::v::then-branch}}{{else}}{{setvar::v::else-branch}}{{/if}}", [["v", "else-branch"]]],
    ["{{if 1}}{{setvar::v::then-branch}}{{else}}{{setvar::v::else-branch}}{{/if}}", [["v", "then-branch"]]],
    [
      "{{if 0}}{{setvar::a::wrong}}{{setvar::b::wrong}}{{else}}{{setvar::a::right}}{{setvar::b::right}}{{/if}}",
      [
        ["a", "right"],
        ["b", "right"]
      ]
    ],
    [
      "{{if 1}}{{setvar::outer::yes}}{{if 0}}{{setvar::inner::wrong}}{{else}}{{setvar::inner::correct}}{{/if}}{{/if}}",
      [
        ["outer", "yes"],
        ["inner", "correct"]
      ]
    ]
  ])("only the chosen branch writes: %j", (text, writes) => {
    expect(run(text).effects.map((e) => [e.name, e.value])).toEqual(writes)
  })
})

describe("shorthands", () => {
  const cases: ReadonlyArray<readonly [string, Vars, string]> = [
    ["{{.myvar}}", { local: { myvar: "hello" } }, "hello"],
    ["{{$myvar}}", { global: { myvar: "world" } }, "world"],
    ["{{.myvar = test}}Value: {{.myvar}}", {}, "Value: test"],
    ["{{.counter++}}", { local: { counter: "5" } }, "6"],
    ["{{$counter--}}", { global: { counter: "10" } }, "9"],
    ["{{.myvar += 3}}Then: {{.myvar}}", { local: { myvar: "7" } }, "Then: 10"],
    ["{{.greeting = Hello {{user}}}}{{.greeting}}", {}, "Hello User"],
    ["{{ .myvar = spaced }}{{.myvar}}", {}, "spaced"],
    ["{{.my-var}}|{{.my_var}}", { local: { "my-var": "hyphenated", my_var: "underscored" } }, "hyphenated|underscored"],
    ["Value:[{{.nonexistent}}]", {}, "Value:[]"],
    ["{{.newcounter++}}", {}, "1"],
    ["{{.x = 5}}{{.x++}}{{.x += 10}}{{.x}}", {}, "616"],
    ["{{.myvar -= 3}}Then: {{.myvar}}", { local: { myvar: "10" } }, "Then: 7"],
    ["{{$myvar -= 5}}{{$myvar}}", { global: { myvar: "20" } }, "15"],
    ["{{.myvar || fallback}}", { local: { myvar: "" } }, "fallback"],
    ["{{.myvar || fallback}}", { local: { myvar: "0" } }, "fallback"],
    ["{{.myvar || fallback}}", { local: { myvar: "existing" } }, "existing"],
    ["{{.nonexistent || default}}", {}, "default"],
    ["{{.myvar ?? fallback}}", {}, "fallback"],
    ["[{{.myvar ?? fallback}}]", { local: { myvar: "" } }, "[]"],
    ["{{.myvar ?? fallback}}", { local: { myvar: "0" } }, "0"],
    ["{{.myvar ?? fallback}}", { local: { myvar: "value" } }, "value"],
    ["{{.myvar ||= newval}}{{.myvar}}", { local: { myvar: "" } }, "newvalnewval"],
    ["{{.myvar ||= newval}}{{.myvar}}", { local: { myvar: "existing" } }, "existingexisting"],
    ["{{.myvar ||= created}}{{.myvar}}", {}, "createdcreated"],
    ["{{.myvar ??= created}}{{.myvar}}", {}, "createdcreated"],
    ["[{{.myvar ??= newval}}][{{.myvar}}]", { local: { myvar: "" } }, "[][]"],
    ["{{.myvar ??= newval}}{{.myvar}}", { local: { myvar: "0" } }, "00"],
    ["{{.myvar == hello}}|{{.myvar == world}}", { local: { myvar: "hello" } }, "true|false"],
    ["{{.myvar ==}}|{{.myvar !=}}", { local: { myvar: "" } }, "true|false"],
    ["{{.myvar == 42}}|{{.myvar != 99}}", { local: { myvar: "42" } }, "true|true"],
    ["{{.myvar != world}}|{{.myvar != hello}}|{{.myvar != }}", { local: { myvar: "hello" } }, "true|false|true"],
    [
      "{{.myvar > 5}}|{{.myvar > 10}}|{{.myvar >= 10}}|{{.myvar < 11}}|{{.myvar <= 9}}",
      { local: { myvar: "10" } },
      "true|false|true|true|false"
    ],
    ["{{.myvar > 5}}|{{.myvar < 5}}", { local: { myvar: "abc" } }, "false|false"],
    ["{{.myvar > -5}}", { local: { myvar: "0" } }, "true"],
    ["{{.myvar < 0}}", { local: { myvar: "-5" } }, "true"],
    ["{{.myvar >= 3.14}}|{{.myvar <= 2.5}}", { local: { myvar: "3.14" } }, "true|false"],
    ["{{$myvar || globaldefault}}", { global: { myvar: "" } }, "globaldefault"],
    ["{{$myvar ?? globaldefault}}", {}, "globaldefault"],
    ["{{$myvar ||= gset}}{{$myvar}}", { global: { myvar: "" } }, "gsetgset"],
    ["{{$myvar ??= gcreated}}{{$myvar}}", {}, "gcreatedgcreated"],
    ["{{$myvar == test}}", { global: { myvar: "test" } }, "true"],
    ["{{.myvar || Hello {{user}}}}|{{.myvar ?? Hello {{user}}}}", {}, "Hello User|Hello User"],
    ["{{ .myvar || spaced }}|{{ .myvar ?? spaced }}", {}, "spaced|spaced"],
    // Lazy values: only expanded when needed, and only once.
    ["{{.myvar ?? {{.tracker = evaluated}}fallback}}[{{.tracker}}]", { local: { myvar: "exists" } }, "exists[]"],
    ["{{.myvar ?? {{.tracker = evaluated}}fallback}}[{{.tracker}}]", {}, "fallback[evaluated]"],
    ["{{.myvar || {{.tracker = evaluated}}fallback}}[{{.tracker}}]", { local: { myvar: "truthy" } }, "truthy[]"],
    ["{{.myvar || {{.tracker = evaluated}}fallback}}[{{.tracker}}]", { local: { myvar: "" } }, "fallback[evaluated]"],
    ["{{.myvar ??= {{.tracker = evaluated}}newval}}[{{.tracker}}]", { local: { myvar: "exists" } }, "exists[]"],
    ["{{.myvar ??= {{.tracker = evaluated}}newval}}[{{.tracker}}]", {}, "newval[evaluated]"],
    ["{{.myvar ||= {{.tracker = evaluated}}newval}}[{{.tracker}}]", { local: { myvar: "truthy" } }, "truthy[]"],
    ["{{.myvar ||= {{.tracker = evaluated}}newval}}[{{.tracker}}]", { local: { myvar: "" } }, "newval[evaluated]"],
    ["{{.myvar = {{.tracker = evaluated}}value}}[{{.tracker}}]", {}, "[evaluated]"],
    ["{{.myvar += {{.tracker = evaluated}}5}}[{{.tracker}}]", { local: { myvar: "10" } }, "[evaluated]"],
    ["{{.myvar == {{.tracker = evaluated}}test}}[{{.tracker}}]", { local: { myvar: "test" } }, "true[evaluated]"],
    ["{{.counter = 0}}{{.myvar ??= {{.counter += 1}}value}}{{.counter}}", {}, "value1"],
    // Edge cases.
    ["{{.myvar = }}[{{.myvar}}]", {}, "[]"],
    ["{{.myvar += }}[{{.myvar}}]", { local: { myvar: "existing" } }, "[existing]"],
    ["{{.myvar -= }}[{{.myvar}}]", { local: { myvar: "10" } }, "[10]"],
    ["[{{.myvar || }}]", { local: { myvar: "" } }, "[]"],
    ["[{{.myvar ?? }}]", {}, "[]"],
    ["{{.myvar == }}", { local: { myvar: "value" } }, "false"],
    ["{{.myvar++5}}", { local: { myvar: "5" } }, "{{.myvar++5}}"],
    ["[{{.myvar--5}}]", { local: { myvar: "10" } }, "[]"],
    ["{{.myvar -- 5}}", { local: { myvar: "10" } }, "{{.myvar -- 5}}"],
    // The value's macros are evaluated one by one, so a block inside doesn't pair (unsure).
    ["{{.x = {{if 1}}b{{/if}}}}{{.x}}", {}, "{{if 1}}b{{/if}}"],
    // The value is trimmed after expansion (unsure).
    ["{{.x = a{{newline}}}}[{{.x}}]", {}, "[a]"]
  ]
  it.each(cases)("%j with %j → %j", (text, variables, output) => expect(run(text, variables).text).toBe(output))
})

describe("effects", () => {
  it("returns writes in order, deletions as null, and the variables after", () => {
    const result = run("{{setvar::a::1}}{{incvar::a}}{{setglobalvar::g::x}}{{deletevar::old}}{{deletevar::none}}", {
      local: { old: "o", keep: 3 }
    })
    expect(result.effects).toEqual([
      { scope: "local", name: "a", value: "1" },
      { scope: "local", name: "a", value: 2 },
      { scope: "global", name: "g", value: "x" },
      { scope: "local", name: "old", value: null }
    ])
    expect(result.variables).toEqual({ local: { a: 2, keep: 3 }, global: { g: "x" } })
  })

  it("threads variables from one text to the next", () => {
    const first = run("{{setvar::mood::happy}}")
    expect(run("{{getvar::mood}}", first.variables).text).toBe("happy")
  })

  it("records writes made by card fields and comments", () => {
    const card = { description: "{{setvar::seen::yes}}A knight." }
    const result = run("{{description}}{{// {{setvar::hidden::1}} }}", {}, { kind: "card" }, card)
    expect(result.text).toBe("A knight.")
    expect(result.effects.map((e) => e.name)).toEqual(["seen", "hidden"])
  })

  it("never writes from text that isn't expanded, or through the display rule", () => {
    const text = "{{setvar::x::1}}{{getvar::x}}"
    expect(run(text, {}, { kind: "user", macroMode: "verbatim" })).toMatchObject({ text, effects: [] })
    expect(run(text, {}, { kind: "model", displayRule: false })).toMatchObject({ text, effects: [] })
    expect(run(text, { local: { y: 1 } }, { kind: "model", displayRule: true })).toEqual({
      text: "1",
      frozen: {},
      effects: [],
      variables: { local: { y: 1 }, global: {} }
    })
    expect(run(text, {}, { kind: "user", macroMode: "template" }).effects).toHaveLength(1)
  })
})

describe("variable names can't reach object prototypes", () => {
  vectors(
    [
      ["[{{getvar::constructor}}][{{getvar::toString}}][{{.constructor}}][{{getglobalvar::__proto__}}]", "[][][][]"],
      // ST reads inherited properties here and says "true"; only own names count.
      ["{{hasvar::constructor}}|{{hasvar::hasOwnProperty}}", "false|false"],
      ["{{setvar::__proto__::x}}{{getvar::__proto__}}", "x"],
      ["{{setvarkey::o::__proto__::x}}{{getvar::o}}|{{getvarkey::o::__proto__}}", "{}|"],
      ['{{setvar::j}}{"a":1}{{/setvar}}{{getvarkey::j::constructor}}|{{getvarkey::j::toString}}', "|"]
    ],
    { local: { real: "1" } }
  )

  it("leaves Object.prototype alone", () => {
    const result = run(
      "{{setvar::__proto__::polluted}}{{setvarkey::o::__proto__::{{user}}}}{{setvar::constructor::x}}",
      {
        local: JSON.parse('{"__proto__": {"inherited": "yes"}}') as Record<string, unknown>
      }
    )
    expect(({} as Record<string, unknown>).inherited).toBeUndefined()
    expect(Object.getPrototypeOf({})).toBe(Object.prototype)
    expect(Object.hasOwn(result.variables.local, "__proto__")).toBe(true)
    expect(result.variables.local.__proto__).toBe("polluted")
  })
})

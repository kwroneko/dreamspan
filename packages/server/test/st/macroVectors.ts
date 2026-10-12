// Macro test vectors for the differential harness: each text is expanded by ST's engine and
// by ours, and the outputs and variables after it are compared.
//
// Most come from the macro engine's own tests (packages/shared/test/macros/), kept where
// ST can evaluate them: built-in macros only, no `{{random}}` (ST draws it from entropy),
// no `{{pick}}` (seeded differently, ARCHITECTURE §10), nothing about origins, freezing or
// limits, which ST doesn't have. ST evaluates each with the fixture character's chat open,
// so card and chat macros read the fixture card and chat, and our engine gets the same.
// A vector whose difference ARCHITECTURE documents cites the text as its `deviation`.

type VarValue = string | number

export interface MacroContextInput {
  readonly user: string
  readonly char: string
  readonly local: Readonly<Record<string, VarValue>>
  readonly global: Readonly<Record<string, VarValue>>
}

export interface MacroVector {
  readonly text: string
  /** Overrides of the default context. */
  readonly context?: Partial<MacroContextInput>
  /** A documented deviation from ST: where ARCHITECTURE explains why ours differs. */
  readonly deviation?: string
}

/** What an engine made of a text. */
export interface MacroOutcome {
  readonly output: string
  /** The chat's and the global variables after the text. */
  readonly local: Record<string, unknown>
  readonly global: Record<string, unknown>
}

/** The fixed clock both engines see: 2026-01-02 15:04:05 UTC, a Friday. */
export const MACRO_NOW = Date.UTC(2026, 0, 2, 15, 4, 5)
/** The time zone ST's pages run in (`openPage`). */
export const MACRO_TIME_ZONE = "UTC"
/** Seeds `Math.random` before each vector, which `{{roll}}` draws from. */
export const MACRO_SEED = 1234

/**
 * Mulberry32: the same draws in the page and here. Its source is sent to the page, so the
 * body has no type annotations for Node's type stripping to blank out.
 */
export const seededRandom: (seed: number) => () => number = function (seed) {
  let state = seed >>> 0
  return function () {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// The engine tests' names.
export const DEFAULT_MACRO_CONTEXT: MacroContextInput = { user: "User", char: "Character", local: {}, global: {} }
// The fixture persona's and character's names, as ST's page has them.
const FIXTURE_NAMES = { user: "Tobin", char: "Mira Vance" }

/**
 * The deviations ARCHITECTURE documents, each by its section's heading and text the section
 * contains (a test checks it, so an edit that drops or moves the text updates the citation).
 */
export const DEVIATIONS = {
  instructOff: {
    section: "10. Macros",
    quote: "the instruct, system-prompt and context-template macros resolve as in ST"
  },
  noExtensions: { section: "10. Macros", quote: "`{{hasExtension}}` is always false" },
  ownKeys: { section: "10. Macros", quote: "Names are own keys only" },
  cardFieldNames: {
    section: "10. Macros",
    quote: "Names inside a card field's macros resolve against the same bindings"
  }
}
const cite = ({ section, quote }: { readonly section: string; readonly quote: string }) =>
  `ARCHITECTURE.md § ${section}: "${quote}"`
const INSTRUCT_OFF = cite(DEVIATIONS.instructOff)
const NO_EXTENSIONS = cite(DEVIATIONS.noExtensions)
const OWN_KEYS = cite(DEVIATIONS.ownKeys)
const CARD_FIELD_NAMES = cite(DEVIATIONS.cardFieldNames)

type Vars = Partial<Pick<MacroContextInput, "local" | "global">>
const plain = (texts: ReadonlyArray<string>): Array<MacroVector> => texts.map((text) => ({ text }))
const withVars = (context: Vars, texts: ReadonlyArray<string>): Array<MacroVector> =>
  texts.map((text) => ({ text, context }))

/** The harness's own first vectors. */
const local: ReadonlyArray<MacroVector> = [
  ...plain([
    "{{user}} greets {{char}}.",
    "<USER> meets <BOT>.",
    "a{{newline}}b{{space}}c",
    "line one\n{{trim}}\nline two"
  ]),
  { text: "{{user}} and {{char}}", context: { user: "Ada", char: "Bram" } },
  ...plain(["kept{{// a comment}}", "{{noop}}x{{noop}}", "{{unknown::{{user}}}}"]),
  ...withVars({ local: { count: 1 } }, ["{{addvar::count::2}}{{getvar::count}}"]),
  ...withVars({ local: { count: 5 } }, ["{{incvar::count}} {{decvar::count}}"]),
  ...withVars({ local: { mood: "calm" } }, ["{{if {{getvar::mood}}}}yes{{else}}no{{/if}}"]),
  ...plain(["{{date}} {{time}} {{weekday}}", "{{isodate}} {{isotime}}", "{{roll:d6}} {{roll::2d20}}"])
]

/** engine.test.ts, where only built-in macros are used. */
const engine: ReadonlyArray<MacroVector> = plain([
  "Hello world, no macros here.",
  "Start {{newline}} end.",
  "{{char}}{{user}}",
  "{{  user  }}",
  "{{USER}} {{User}}",
  "Reversed: {{reverse::abc}}!",
  "Reversed: {{reverse:abc}}!",
  "Reversed: {{reverse:abc::def}}!",
  "Reversed: {{reverse:abc:def}}!",
  "Values: {{reverse abc def}}!",
  "{{reverse::  spaced  }}",
  "{{reverse::with:single:colons}}",
  "Result: {{reverse::first line\nsecond line}}",
  "Result: {{reverse::{{user}}{{char}}}}",
  "Test: {{unknown::{{newline}}}}",
  "Test: {{unknown::my {{newline}} example}}",
  "{{toString}} {{constructor}} {{hasOwnProperty}}",
  "Test§ {{reverse::my { test}}",
  "Test§ {{reverse::my } test}}",
  "Test {{ hehe",
  "Test {{§§ hehe",
  "Before {{ hehe After",
  "Test {{ hehe {{user}}",
  "Test {{&& hehe {{user}}",
  "{{{char}}",
  "{{char}}}",
  "{{{char}}}",
  "{{{{char}}",
  "{{char}}}}",
  "{{{{char}}}}",
  "Result: {{reverse::pre-{ {{user}} }-post}}",
  "{{char}}{ {{user}} }",
  "Line1 {{char}}\r\n{Line2}",
  "Foo }} bar",
  "Foo }} {{user}}",
  "Foo {{user}} }}",
  "{{}}",
  "{{!}}",
  "a \\{\\{user\\}\\} b",
  "{{char's}}",
  "{{reverse's abc}}",
  "{{inside{{macro}}me}}",
  "Start {{char::extra}} end.",
  "Result: {{reverse}}",
  "Result: {{reverse::a::b}}",
  "Result: {{user Something {{char}}}}",
  "Hello {{#user}}!",
  "{{/unknown}}",
  "{{/user}}",
  "{{/reverse::test}}",
  "Hello {{user}}, this {{/char}} is raw, bye {{char}}!",
  "{{!reverse::hello}}",
  "{{reverse}}hello{{/reverse}}",
  "{{reverse}}{{/reverse}}",
  "{{reverse}}\n  abc  \n{{/reverse}}",
  "{{#reverse}}\n  abc  \n{{/reverse}}",
  "{{reverse}}hello{{/REVERSE}}",
  "{{trim}}  hello world  {{/trim}}",
  "{{trim}}  outer {{trim}}  inner  {{/trim}} outer  {{/trim}}",
  "{{trim}}  Hello {{user}}  {{/trim}}",
  "{{user}}Hello {{char}}!{{/user}}",
  "{{reverse::x}}a{{user}}b{{/reverse}}",
  "Before {{/reverse}} After",
  "{{reverse}}ab{{/reverse}}{{/reverse}}",
  "{{reverse}}ab{{trim}}{{/reverse}}x{{/trim}}",
  "{{reverse}}x{{/char}}",
  "{{reverse}}a{{reverse}}bc{{/reverse}}d{{/reverse}}",
  "{{reverse}}  line1\n    line2\n  line3{{/reverse}}",
  "{{foo}}bar{{/foo}}",
  "{{foo::x}}\n bar \n{{/foo}}",
  "foo\n\n{{trim}}\n\nbar",
  "A\n\n{{trim}}\n\nB\n\n{{trim}}\n\nC",
  "A\r\n{{TRIM}}\r\nB",
  "A\r\r\n{{trim}}\n\rB",
  "Hello <USER>!",
  "Bot: <BOT>, Char: <CHAR>.",
  "Group: <GROUP>, CharIfNotGroup: <CHARIFNOTGROUP>.",
  "{{setvar::x::<user>}}"
])

/** builtins.test.ts, against the fixture card and chat instead of the test's own. */
const builtins: ReadonlyArray<MacroVector> = [
  ...plain([
    "{{space}}|{{space::3}}|",
    "a{{newline::2}}b",
    "{{newline::x}}",
    "a{{noop}}b",
    "[{{input}}]",
    "{{maxPrompt}} {{maxPromptTokens}} {{maxContext}} {{maxResponseTokens}}",
    "{{reverse::I am Lana}}",
    '{{banned "word"}}',
    "{{outlet::lore}}|{{outlet::missing}}|{{outlet::constructor}}",
    "a{{else}}b",
    "Hello{{// comment}}World",
    "A{{//!@#$%^&*()_+}}B",
    "X{{//comment with // extra // slashes}}Y",
    "Start{{// line one\nline two\nline three}}End",
    "Before{{//}}This entire block is a comment.{{///}}After",
    "Start\n{{//}}\n  This entire block is a comment.\n  It can span multiple lines.\n{{///}}\nEnd",
    "A{{//}}ignored{{////}}B",
    "X{{//}}{{user}} should be ignored{{///}}Y",
    "{{user}}{{//}}ignored block{{///}}{{user}}",
    "A{{comment::hidden}}B",
    "{{//}}",
    "{{user}} {{char}} {{group}} {{charIfNotGroup}} {{groupNotMuted}} {{notChar}}",
    "{{model}}",
    "{{isMobile}}",
    "[{{lastGenerationType}}]",
    "{{original}}",
    "{{lastMessage}}|{{lastMessageId}}|{{lastUserMessage}}|{{lastCharMessage}}",
    "{{allChatRange}}",
    "[{{lastSwipeId}}][{{currentSwipeId}}]",
    "{{time}}|{{date}}|{{weekday}}|{{isotime}}|{{isodate}}",
    "{{time::UTC+2}}|{{time::UTC-10}}|{{time_UTC+2}}|{{time::UTC+530}}",
    "{{time::garbage}}",
    "{{datetimeformat::YYYY-MM-DD HH:mm:ss.SSS}}",
    "{{datetimeformat dddd, MMMM Do YYYY, h:mm a}}",
    "{{datetimeformat::[Today is] dddd}}",
    "{{datetimeformat::LLLL|llll|LTS|L|l}}",
    "{{datetimeformat::Z ZZ X x}}",
    "{{datetimeformat::Qo DDDD kk hh dd ddd MMM YY M D d}}",
    "{{datetimeformat::\\YYYY [x] \\x \\[x]}}",
    "{{timeDiff::2023-01-01 12:00:00::2023-01-01 15:00:00}}",
    "{{timeDiff::2023-01-01T15:00:00Z::2023-01-01T13:00:00+01:00}}",
    "{{timeDiff::nonsense::2023-01-01}}",
    "{{idle_duration}} / {{idleDuration}}",
    "{{roll 1d6}}|{{roll::6}}|{{roll 2d6+3}}|{{roll::d20}}|{{roll::3d6-2}}",
    "Values: {{roll 1d1}}!",
    "[{{roll::0}}][{{roll::banana}}][{{roll 1d6 + 2}}]",
    "{{if::hello::shown}}",
    "{{if::::hidden}}",
    "{{if::false::hidden}}{{if::off::hidden}}{{if::0::hidden}}",
    "{{if::true::shown}} {{if::1::shown}}",
    "{{if char}}Name: {{char}}{{/if}}",
    "{{if noop}}should not show{{/if}}[end]",
    "{{if::notamacro::shown}}",
    "{{if user}}Hello {{user}}{{/if}}",
    "{{if yes}}This is the content{{/if}}",
    "{{if::}}This should not show{{/if}}[after]",
    "{{if yes}}outer{{if yes}}inner{{/if}}{{/if}}",
    "{{if::}}outer{{if yes}}inner{{/if}}{{/if}}[end]",
    "{{if yes}}outer{{if::}}inner{{/if}}end{{/if}}",
    "{{if yes}}then{{else}}else{{/if}}",
    "{{if::}}then{{else}}else{{/if}}",
    "{{if::false}}yes{{else}}no{{/if}}",
    "{{if::}}Hello {{user}}{{else}}Goodbye {{char}}{{/if}}",
    "{{if yes}}outer-then{{if yes}}inner-then{{else}}inner-else{{/if}}{{else}}outer-else{{/if}}",
    "{{if::}}outer-then{{else}}outer-else{{if yes}}inner-then{{else}}inner-else{{/if}}{{/if}}",
    "{{if::}}A{{else}}B{{if::}}C{{else}}D{{/if}}{{/if}}",
    "{{if yes}}  then  {{else}}  else  {{/if}}",
    "{{if yes}}\n  then\n{{else}}\n  else\n{{/if}}",
    "{{if noop}}Has value{{else}}Empty{{/if}}",
    "{{if !yes}}shown{{/if}}[end]",
    "{{if !false}}shown{{/if}}",
    "{{if::!}}not shown{{else}}shown{{/if}}",
    "{{if !char}}No char{{else}}Has char{{/if}}",
    "{{if::!something}}shown{{/if}}[end]",
    "{{#if yes}}\n  preserved  \n{{/if}}",
    "{{if yes}}\n  # Title\n  Body text\n{{/if}}",
    "{{if 0}}{{if::1::inner}}{{else}}outer-else{{/if}}",
    "{{if 0}}{{if::1::a}}{{if::1::b}}{{else}}found{{/if}}",
    "{{if trim}}x{{else}}y{{/if}}",
    "{{if::}}a{{ELSE}}b{{/if}}"
  ]),
  ...plain([
    "[{{instructUserPrefix}}{{instructInput}}{{instructAssistantSuffix}}{{instructStop}}{{instructLastInput}}]",
    "{{chatStart}}|{{exampleSeparator}}|{{chatSeparator}}"
  ]),
  { text: "{{hasExtension::memory}}", deviation: NO_EXTENSIONS },
  ...["[{{defaultSystemPrompt}}{{instructSystemPrompt}}]", "{{systemPrompt}}"].map((text) => ({
    text,
    deviation: INSTRUCT_OFF
  })),
  // Card fields, with the names ST's page has. With other names, ST still expands a card
  // field with the page's: the vector after these.
  ...[
    "[{{description}}]",
    "{{charDescription}}|{{personality}}|{{charScenario}}|",
    "{{persona}}",
    "{{charPrompt}}|{{charInstruction}}|{{charDepthPrompt}}|{{creatorNotes}}",
    "{{mesExamplesRaw}}",
    "{{mesExamples}}",
    "{{greeting}}|{{charFirstMessage::0}}|{{greeting::1}}|{{greeting::2}}|{{greeting::3}}",
    "{{greeting::x}}",
    "{{charVersion}}|{{version}}|{{char_version}}",
    "{{if description}}# Description\n{{description}}{{/if}}",
    "{{if scenario}}has{{else}}none{{/if}}"
  ].map((text) => ({ text, context: FIXTURE_NAMES })),
  { text: "{{char}}: {{description}}", deviation: CARD_FIELD_NAMES }
]

/** variables.test.ts. */
const variables: ReadonlyArray<MacroVector> = [
  ...plain([
    "A {{setvar::test::4}}{{getvar::test}} B {{setvar::test::2}}{{getvar::test}} C",
    "Result: {{setvar::test::0}}{{reverse::{{addvar::test::100}}{{getvar::test}}}}{{setvar::test::0}}",
    "Result: {{setvar::addvname::test}}{{addvar::{{getvar::addvname}}::{{setvar::test::5}}{{getvar::test}}}}{{getvar::test}}",
    "{{setvar::flag::}}[{{getvar::flag}}]",
    "{{incvar::n}}{{incvar::n}}{{decvar::m}}",
    "{{setglobalvar::g::x}}{{getglobalvar::g}}[{{getvar::g}}]",
    "{{addglobalvar::g::2}}{{incglobalvar::g}}{{decglobalvar::g}}{{getglobalvar::g}}",
    "{{hasvar::myvar}}{{deletevar::myvar}}{{hasvar::myvar}}",
    "{{setvar::a::1}}{{varexists::a}}{{flushvar::a}}{{varexists::a}}",
    "{{setvar::::x}}|{{incvar::}}",
    "{{setvar::a::007}}{{getvar::a}}|{{setvar::b:: 5 }}{{getvar::b}}|{{setvar::c::1e3}}{{getvar::c}}",
    "{{setvar::z::0}}{{addvar::z::abc}}{{getvar::z}}",
    "{{setvar::s::abc}}{{addvar::s::1}}{{getvar::s}}",
    "{{setvar::n::5}}{{addvar::n::3}}{{getvar::n}}",
    "{{setvar::arr::[1,2]}}{{addvar::arr::3}}{{getvar::arr}}|{{incvar::arr}}",
    "{{setvarkey::obj::a::1}}{{getvarkey::obj::a}}|{{getvar::obj}}",
    "{{setvarindex::list::1::x}}{{getvar::list}}|{{getvarindex::list::1}}",
    '{{setvar::o}}{"a":{"b":2}}{{/setvar}}{{getvarkey::o::a}}',
    '{{setvar::o::{"a":1\\}}}',
    "{{setvar::p::plain}}{{getvarkey::p::0}}|{{setvar::q::null}}{{getvarkey::q::0}}",
    '{{setvar::str::"abc"}}{{getvarkey::str::1}}',
    "{{setvar::num::5}}{{setvarkey::num::k::v}}{{getvar::num}}",
    "{{setglobalvarkey::go::k::v}}{{getglobalvarkey::go::k}}",
    '{{setvar::j}}{"a":1}{{/setvar}}{{getvarkey::j::a}}{{setvarkey::j::a::9}}{{getvarkey::j::a}}',
    "{{setvar::myvar}}Hello World{{/setvar}}{{getvar::myvar}}",
    "{{setvar::myvar}}Hello {{user}}!{{/setvar}}{{getvar::myvar}}",
    "{{setvar::outer}}before {{setvar::inner}}nested{{/setvar}} after{{/setvar}}{{getvar::outer}} | {{getvar::inner}}",
    "{{setvar::myvar}}content{{/setvar}}{{/setvar}}{{getvar::myvar}}",
    "{{setvar::empty}}{{/setvar}}[{{getvar::empty}}]",
    "{{setvar::l1}}A{{setvar::l2}}B{{setvar::l3}}C{{/setvar}}B{{/setvar}}A{{/setvar}}{{getvar::l1}}|{{getvar::l2}}|{{getvar::l3}}",
    "{{setvar::x}}content{{/getvar}}{{getvar::x}}",
    "{{setvar::special}}Hello { world } :: test{{/setvar}}{{getvar::special}}",
    "{{setvar::myvar::existing}}extra{{/setvar}}{{getvar::myvar}}",
    "{{setvar::ws}}   {{/setvar}}[{{getvar::ws}}]",
    "{{#setvar::ws}}   {{/setvar}}[{{getvar::ws}}]",
    "prefix {{setvar::x}}value{{/setvar}}",
    "{{setvar::x}}value{{/setvar}}{{/user}}{{getvar::x}}",
    "{{setvar::testvar::{{reverse}}hello{{/reverse}}}} {{getvar::testvar}}",
    "{{setvar::testvar::{{if true}}true branch{{/if}}}} {{getvar::testvar}}",
    "{{setvar::testvar::{{if 0}}wrong{{else}}correct{{/if}}}} {{getvar::testvar}}",
    "{{setvar::outer::{{setvar::inner::{{reverse}}xyz{{/reverse}}}}{{getvar::inner}}}} {{getvar::outer}}",
    "{{setvar::testvar::{{if true}}\ntrue\nbranch\n{{/if}}}} {{getvar::testvar}}",
    "{{setvar::myvar}}\n  content with whitespace  \n{{/setvar}}[{{getvar::myvar}}]",
    "{{setvar::myvar}}\n  line1\n  line2  \n{{/setvar}}[{{getvar::myvar}}]",
    "{{#setvar::myvar}}\n  content  \n{{/setvar}}[{{getvar::myvar}}]",
    "{{#setvar::myvar}}\n  {{char}}  \n{{/setvar}}[{{getvar::myvar}}]",
    "{{setvar::myvar}}\n  parent\n    child\n  sibling\n{{/setvar}}[{{getvar::myvar}}]",
    "{{setvar::myvar}}\n  line1\n\n  line2\n{{/setvar}}[{{getvar::myvar}}]",
    "{{setvar::flag::yes}}{{if {{getvar::flag}}}}shown{{/if}}",
    "{{setvar::flag::false}}{{if {{getvar::flag}}}}hidden{{/if}}[end]",
    "{{setvar::emptyVar::}}{{if !{{getvar::emptyVar}}}}Empty var{{/if}}",
    "{{setvar::bangVar::!hello}}{{if {{getvar::bangVar}}}}Has value{{else}}No value{{/if}}",
    "{{.ready = yes}}{{if .ready}}Ready!{{/if}}",
    "{{if .nonexistent}}Yes{{else}}No{{/if}}",
    "{{if 0}}{{setvar::v::then-branch}}{{else}}{{setvar::v::else-branch}}{{/if}}",
    "{{if 1}}{{setvar::outer::yes}}{{if 0}}{{setvar::inner::wrong}}{{else}}{{setvar::inner::correct}}{{/if}}{{/if}}",
    "{{.myvar = test}}Value: {{.myvar}}",
    "{{.greeting = Hello {{user}}}}{{.greeting}}",
    "{{ .myvar = spaced }}{{.myvar}}",
    "Value:[{{.nonexistent}}]",
    "{{.newcounter++}}",
    "{{.x = 5}}{{.x++}}{{.x += 10}}{{.x}}",
    "{{.nonexistent || default}}",
    "{{.myvar ?? fallback}}",
    "{{.myvar ||= created}}{{.myvar}}",
    "{{.myvar ??= created}}{{.myvar}}",
    "{{$myvar ?? globaldefault}}",
    "{{$myvar ??= gcreated}}{{$myvar}}",
    "{{.myvar || Hello {{user}}}}|{{.myvar ?? Hello {{user}}}}",
    "{{ .myvar || spaced }}|{{ .myvar ?? spaced }}",
    "{{.myvar ?? {{.tracker = evaluated}}fallback}}[{{.tracker}}]",
    "{{.myvar ??= {{.tracker = evaluated}}newval}}[{{.tracker}}]",
    "{{.myvar = {{.tracker = evaluated}}value}}[{{.tracker}}]",
    "{{.counter = 0}}{{.myvar ??= {{.counter += 1}}value}}{{.counter}}",
    "{{.myvar = }}[{{.myvar}}]",
    "[{{.myvar ?? }}]",
    "{{.x = {{if 1}}b{{/if}}}}{{.x}}",
    "{{.x = a{{newline}}}}[{{.x}}]"
  ]),
  ...withVars({ local: { myvar: "value" } }, [
    "{{hasvar::myvar}}{{deletevar::myvar}}{{hasvar::myvar}}",
    "{{.myvar ?? fallback}}",
    "{{.myvar == }}"
  ]),
  ...withVars({ local: { myvar: "" } }, [
    "{{hasvar::myvar}}",
    "{{if {{hasvar::myvar}} == true}}exists{{else}}missing{{/if}}",
    "{{.myvar || fallback}}",
    "[{{.myvar ?? fallback}}]",
    "{{.myvar ||= newval}}{{.myvar}}",
    "[{{.myvar ??= newval}}][{{.myvar}}]",
    "{{.myvar ==}}|{{.myvar !=}}",
    "[{{.myvar || }}]",
    "{{.myvar || {{.tracker = evaluated}}fallback}}[{{.tracker}}]",
    "{{.myvar ||= {{.tracker = evaluated}}newval}}[{{.tracker}}]"
  ]),
  ...withVars({ global: { myvar: "value" } }, [
    "{{hasglobalvar::myvar}}{{deleteglobalvar::myvar}}{{hasglobalvar::myvar}}"
  ]),
  ...withVars({ local: { flag: "1" } }, ["{{if .flag}}Yes{{/if}}|{{if !.flag}}Not set{{/if}}"]),
  ...withVars({ local: { flag: "" } }, ["[{{if .flag}}Yes{{/if}}]{{if !.flag}}Not set{{/if}}{{if ! .flag}}!{{/if}}"]),
  ...withVars({ global: { enabled: "true", disabled: "" } }, [
    "{{if $enabled}}Active{{/if}}{{if !$disabled}}Enabled{{/if}}"
  ]),
  ...withVars({ local: { active: "yes", "is-valid": "1" } }, [
    "{{if .active}}On{{else}}Off{{/if}}{{if .is-valid}}Valid{{/if}}"
  ]),
  ...withVars({ local: { count: "42" } }, ["{{if .count}}Count: {{.count}}{{/if}}"]),
  ...withVars({ local: { count: "0" } }, ["{{if .count}}Has count{{else}}No count{{/if}}"]),
  ...withVars({ local: { myvar: "hello" } }, [
    "{{.myvar}}",
    "{{.myvar == hello}}|{{.myvar == world}}",
    "{{.myvar != world}}|{{.myvar != hello}}|{{.myvar != }}"
  ]),
  ...withVars({ global: { myvar: "world" } }, ["{{$myvar}}"]),
  ...withVars({ local: { counter: "5" } }, ["{{.counter++}}"]),
  ...withVars({ global: { counter: "10" } }, ["{{$counter--}}"]),
  ...withVars({ local: { myvar: "7" } }, ["{{.myvar += 3}}Then: {{.myvar}}"]),
  ...withVars({ local: { "my-var": "hyphenated", my_var: "underscored" } }, ["{{.my-var}}|{{.my_var}}"]),
  ...withVars({ local: { myvar: "10" } }, [
    "{{.myvar -= 3}}Then: {{.myvar}}",
    "{{.myvar > 5}}|{{.myvar > 10}}|{{.myvar >= 10}}|{{.myvar < 11}}|{{.myvar <= 9}}",
    "{{.myvar += {{.tracker = evaluated}}5}}[{{.tracker}}]",
    "{{.myvar -= }}[{{.myvar}}]",
    "[{{.myvar--5}}]",
    "{{.myvar -- 5}}"
  ]),
  ...withVars({ global: { myvar: "20" } }, ["{{$myvar -= 5}}{{$myvar}}"]),
  ...withVars({ local: { myvar: "0" } }, [
    "{{.myvar || fallback}}",
    "{{.myvar ?? fallback}}",
    "{{.myvar ??= newval}}{{.myvar}}",
    "{{.myvar > -5}}"
  ]),
  ...withVars({ local: { myvar: "existing" } }, [
    "{{.myvar || fallback}}",
    "{{.myvar ||= newval}}{{.myvar}}",
    "{{.myvar += }}[{{.myvar}}]"
  ]),
  ...withVars({ local: { myvar: "42" } }, ["{{.myvar == 42}}|{{.myvar != 99}}"]),
  ...withVars({ local: { myvar: "abc" } }, ["{{.myvar > 5}}|{{.myvar < 5}}"]),
  ...withVars({ local: { myvar: "-5" } }, ["{{.myvar < 0}}"]),
  ...withVars({ local: { myvar: "3.14" } }, ["{{.myvar >= 3.14}}|{{.myvar <= 2.5}}"]),
  ...withVars({ global: { myvar: "" } }, ["{{$myvar || globaldefault}}", "{{$myvar ||= gset}}{{$myvar}}"]),
  ...withVars({ global: { myvar: "test" } }, ["{{$myvar == test}}"]),
  ...withVars({ local: { myvar: "exists" } }, [
    "{{.myvar ?? {{.tracker = evaluated}}fallback}}[{{.tracker}}]",
    "{{.myvar ??= {{.tracker = evaluated}}newval}}[{{.tracker}}]"
  ]),
  ...withVars({ local: { myvar: "truthy" } }, [
    "{{.myvar || {{.tracker = evaluated}}fallback}}[{{.tracker}}]",
    "{{.myvar ||= {{.tracker = evaluated}}newval}}[{{.tracker}}]"
  ]),
  ...withVars({ local: { myvar: "test" } }, ["{{.myvar == {{.tracker = evaluated}}test}}[{{.tracker}}]"]),
  ...withVars({ local: { myvar: "5" } }, ["{{.myvar++5}}"]),
  ...[
    "[{{getvar::constructor}}][{{getvar::toString}}][{{.constructor}}][{{getglobalvar::__proto__}}]",
    "{{hasvar::constructor}}|{{hasvar::hasOwnProperty}}",
    '{{setvar::j}}{"a":1}{{/setvar}}{{getvarkey::j::constructor}}|{{getvarkey::j::toString}}'
  ].map((text) => ({ text, context: { local: { real: "1" } }, deviation: OWN_KEYS }))
]

export const MACRO_VECTORS: ReadonlyArray<MacroVector> = [...local, ...engine, ...builtins, ...variables]

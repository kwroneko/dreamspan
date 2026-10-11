// Vectors for the built-in macros. Most come from SillyTavern's
// tests/frontend/MacroEngine.e2e.js (at 06bde939); the rest were derived from reading its
// macro definitions, and those that rest on behavior ST's tests don't pin are marked unsure.
import { describe, expect, it } from "vitest"
import type { MacroContext } from "../../src/macros/context.ts"
import { humanize } from "../../src/macros/time.ts"
import { builtinRegistry, expanded } from "./support.ts"

const registry = builtinRegistry()

/** 2026-10-11 14:05:09.123 UTC, a Sunday; 16:05 in Berlin. */
const NOW = 1791727509123
const MINUTE = 60_000

const base: MacroContext = {
  names: { user: "User", char: "Character" },
  now: NOW,
  timeZone: "Europe/Berlin",
  card: {
    description: "  {{char}} is a {{personality}} knight.\r\nFriend of {{user}}.  ",
    personality: "brave",
    scenario: "",
    persona: "{{user}} is a bard.",
    mesExamples: "<START>\n{{user}}: hi\n{{char}}: hello\n<start>\n{{char}}: bye",
    firstMessage: "Hi {{user}}!",
    alternateGreetings: ["Hey {{user}}.", "Yo."],
    version: "1.0 {{user}}",
    systemPrompt: "Main for {{char}}",
    postHistoryInstructions: "Stay in character.",
    depthPrompt: "Depth",
    creatorNotes: "Notes"
  },
  messages: [
    { text: "first", fromUser: true, sentAt: NOW - 5 * MINUTE },
    { text: "reply", fromUser: false, versions: 3, selectedVersion: 1 },
    { text: "latest", fromUser: true, sentAt: NOW - MINUTE }
  ],
  model: "test-model",
  input: "typed",
  outlets: { lore: "Outlet text" },
  maxContextTokens: 8192,
  maxResponseTokens: 1024,
  pickSeed: "chat-1"
}

const run = (text: string, context: Partial<MacroContext> = {}, random: () => number = () => 0.5) =>
  expanded({
    text,
    origin: { kind: "preset" },
    purpose: "assembly",
    registry,
    context: { ...base, ...context },
    random
  }).text

const vectors = (cases: ReadonlyArray<readonly [string, string]>, context: Partial<MacroContext> = {}) =>
  it.each(cases)("%j → %j", (input, output) => expect(run(input, context)).toBe(output))

describe("utility", () => {
  vectors([
    ["{{space}}|{{space::3}}|", " |   |"],
    ["a{{newline::2}}b", "a\n\nb"],
    ["{{newline::x}}", "{{newline::x}}"],
    ["a{{noop}}b", "ab"],
    ["{{input}}", "typed"],
    ["{{maxPrompt}} {{maxPromptTokens}} {{maxContext}} {{maxResponseTokens}}", "7168 7168 8192 1024"],
    ["{{reverse::I am Lana}}", "anaL ma I"],
    ['{{banned "word"}}', ""],
    ["{{outlet::lore}}|{{outlet::missing}}|{{outlet::constructor}}", "Outlet text||"],
    ["a{{else}}b", "ab"]
  ])
})

describe("comments", () => {
  vectors([
    ["Hello{{// comment}}World", "HelloWorld"],
    ["A{{//!@#$%^&*()_+}}B", "AB"],
    ["X{{//comment with // extra // slashes}}Y", "XY"],
    ["Start{{// line one\nline two\nline three}}End", "StartEnd"],
    ["Before{{//}}This entire block is a comment.{{///}}After", "BeforeAfter"],
    ["Start\n{{//}}\n  This entire block is a comment.\n  It can span multiple lines.\n{{///}}\nEnd", "Start\n\nEnd"],
    ["A{{//}}ignored{{////}}B", "AB"],
    ["X{{//}}{{user}} should be ignored{{///}}Y", "XY"],
    ["{{user}}{{//}}ignored block{{///}}{{user}}", "UserUser"],
    ["A{{comment::hidden}}B", "AB"],
    // A comment needs its one argument, so a bare one stays (unsure).
    ["{{//}}", "{{//}}"]
  ])
})

describe("names", () => {
  vectors([
    [
      "{{user}} {{char}} {{group}} {{charIfNotGroup}} {{groupNotMuted}} {{notChar}}",
      "User Character Character Character Character User"
    ]
  ])
  vectors([["{{group}}|{{groupNotMuted}}|{{notChar}}", "A, B, C|A, C|A, C, User"]], {
    names: { user: "User", char: "B", group: "A, B, C", groupNotMuted: "A, C", notChar: "A, C, User" }
  })
})

describe("card fields", () => {
  vectors([
    // Expanded on their own: card-field macros inside a card field read as empty (ST's
    // replaceCharacterCard: false), and carriage returns are removed.
    ["[{{description}}]", "[Character is a  knight.\nFriend of User.]"],
    ["{{charDescription}}|{{personality}}|{{charScenario}}|", "Character is a  knight.\nFriend of User.|brave||"],
    ["{{persona}}", "User is a bard."],
    [
      "{{charPrompt}}|{{charInstruction}}|{{charDepthPrompt}}|{{creatorNotes}}",
      "Main for Character|Stay in character.|Depth|Notes"
    ],
    ["{{mesExamplesRaw}}", "<START>\nUser: hi\nCharacter: hello\n<start>\nCharacter: bye"],
    ["{{mesExamples}}", "<START>\nUser: hi\nCharacter: hello\n<START>\nCharacter: bye\n"],
    [
      "{{greeting}}|{{charFirstMessage::0}}|{{greeting::1}}|{{greeting::2}}|{{greeting::3}}",
      "Hi User!|Hi User!|Hey User.|Yo.|"
    ],
    ["{{greeting::x}}", "{{greeting::x}}"],
    // The version is used as is, and a macro's output is never expanded again.
    ["{{charVersion}}|{{version}}|{{char_version}}", "1.0 {{user}}|1.0 {{user}}|1.0 {{user}}"]
  ])
  vectors([["{{mesExamples}}", "<START>\nCharacter: x\n"]], { card: { mesExamples: "{{char}}: x" } })
  vectors([["[{{description}}{{mesExamples}}{{greeting}}]", "[]"]], { card: {} })

  it("expands a field once per expansion, as ST caches its card fields", () => {
    let n = 0
    const random = () => [0, 0.99][n++ % 2]!
    expect(run("{{description}} / {{description}}", { card: { description: "{{random::a::b}}" } }, random)).toBe(
      "a / a"
    )
  })
})

describe("state", () => {
  vectors([
    ["{{model}}", "test-model"],
    ["{{isMobile}}", "false"],
    ["[{{lastGenerationType}}]", "[]"],
    ["{{hasExtension::memory}}", "false"],
    ["{{original}}", "{{original}}"]
  ])
  vectors([["{{original}}|{{original}}", "ORIG|"]], { original: "ORIG" })
  // The card's own text doesn't see the original (unsure).
  vectors([["{{description}}", "{{original}}"]], { original: "ORIG", card: { description: "{{original}}" } })
})

describe("chat", () => {
  vectors([
    ["{{lastMessage}}|{{lastMessageId}}|{{lastUserMessage}}|{{lastCharMessage}}", "latest|2|latest|reply"],
    ["{{allChatRange}}", "0-2"],
    ["[{{lastSwipeId}}][{{currentSwipeId}}]", "[][]"],
    ["[{{firstIncludedMessageId}}][{{firstDisplayedMessageId}}]", "[][]"]
  ])
  vectors(
    [
      ["{{lastMessage}}|{{lastUserMessage}}|{{lastCharMessage}}", "note|hi|hello"],
      ["{{lastSwipeId}}/{{currentSwipeId}}", "3/2"]
    ],
    {
      messages: [
        { text: "hi", fromUser: true },
        { text: "hello", fromUser: false },
        { text: "note", fromUser: false, system: true, versions: 3, selectedVersion: 1 }
      ]
    }
  )
  vectors([["[{{lastMessage}}][{{lastMessageId}}][{{allChatRange}}][{{lastSwipeId}}]", "[][][][]"]], {
    messages: []
  })
  vectors([["{{firstIncludedMessageId}}", "4"]], { firstIncludedMessageId: 4 })
})

describe("time", () => {
  vectors([
    ["{{time}}|{{date}}|{{weekday}}|{{isotime}}|{{isodate}}", "4:05 PM|October 11, 2026|Sunday|16:05|2026-10-11"],
    ["{{time::UTC+2}}|{{time::UTC-10}}|{{time_UTC+2}}|{{time::UTC+530}}", "4:05 PM|4:05 AM|4:05 PM|10:55 PM"],
    ["{{time::garbage}}", "4:05 PM"],
    ["{{datetimeformat::YYYY-MM-DD HH:mm:ss.SSS}}", "2026-10-11 16:05:09.123"],
    ["{{datetimeformat dddd, MMMM Do YYYY, h:mm a}}", "Sunday, October 11th 2026, 4:05 pm"],
    ["{{datetimeformat::[Today is] dddd}}", "Today is Sunday"],
    [
      "{{datetimeformat::LLLL|llll|LTS|L|l}}",
      "Sunday, October 11, 2026 4:05 PM|Sun, Oct 11, 2026 4:05 PM|4:05:09 PM|10/11/2026|10/11/2026"
    ],
    ["{{datetimeformat::Z ZZ X x}}", "+02:00 +0200 1791727509 1791727509123"],
    ["{{datetimeformat::Qo DDDD kk hh dd ddd MMM YY M D d}}", "4th 284 16 04 Su Sun Oct 26 10 11 0"],
    ["{{datetimeformat::\\YYYY [x] \\x \\[x]}}", "YYYY x x [1791727509123]"],
    ["{{timeDiff::2023-01-01 12:00:00::2023-01-01 15:00:00}}", "3 hours ago"],
    ["{{timeDiff::2023-01-01T15:00:00Z::2023-01-01T13:00:00+01:00}}", "in 3 hours"],
    ["{{timeDiff::nonsense::2023-01-01}}", "Invalid date"],
    ["{{idle_duration}} / {{idleDuration}}", "5 minutes / 5 minutes"]
  ])
  vectors([["{{time}}", "2:05 PM"]], { timeZone: "Not/AZone" })
  vectors([["{{idle_duration}}", "just now"]], { messages: [{ text: "only", fromUser: true, sentAt: NOW - MINUTE }] })

  it.each([
    [30_000, "a few seconds"],
    [45_000, "a minute"],
    [89_000, "a minute"],
    [90_000, "2 minutes"],
    [44 * MINUTE, "44 minutes"],
    [45 * MINUTE, "an hour"],
    [21 * 60 * MINUTE, "21 hours"],
    [22 * 60 * MINUTE, "a day"],
    [25 * 1440 * MINUTE, "25 days"],
    [26 * 1440 * MINUTE, "a month"],
    [46 * 1440 * MINUTE, "2 months"],
    [319 * 1440 * MINUTE, "10 months"],
    [320 * 1440 * MINUTE, "a year"],
    [547 * 1440 * MINUTE, "a year"],
    [548 * 1440 * MINUTE, "2 years"]
  ])("humanizes %d ms as %j, with moment's thresholds", (ms, text) => {
    expect(humanize(ms, false)).toBe(text)
    expect(humanize(-ms, true)).toBe(`${text} ago`)
  })
})

describe("randomness", () => {
  vectors([
    ["{{random::a::b::c}}|{{random a,b,c}}|{{random:x::y}}|[{{random}}]", "b|b|y|[]"],
    ["{{random::a\\,b,c}}", "c"],
    ["{{roll 1d6}}|{{roll::6}}|{{roll 2d6+3}}|{{roll::d20}}|{{roll::3d6-2}}", "4|4|11|11|10"],
    ["Values: {{roll 1d1}}!", "Values: 1!"],
    ["[{{roll::0}}][{{roll::banana}}][{{roll 1d6 + 2}}]", "[][][]"]
  ])

  it("picks the same item for the same chat, text and position", () => {
    const text = "Choices: {{pick::red::green::blue}}, {{pick::red::green::blue}}."
    const first = run(text, {}, Math.random)
    expect(run(text, {}, Math.random)).toBe(first)
    expect(first).toMatch(/^Choices: (red|green|blue), (red|green|blue)\.$/)
    const picks = new Set(Array.from({ length: 40 }, (_, i) => run(`${" ".repeat(i)}{{pick::a::b::c::d}}`).trim()))
    expect(picks.size).toBeGreaterThan(1)
  })
})

describe("if", () => {
  vectors([
    ["{{if::hello::shown}}", "shown"],
    ["{{if::::hidden}}", ""],
    ["{{if::false::hidden}}{{if::off::hidden}}{{if::0::hidden}}", ""],
    ["{{if::true::shown}} {{if::1::shown}}", "shown shown"],
    ["{{if char}}Name: {{char}}{{/if}}", "Name: Character"],
    ["{{if noop}}should not show{{/if}}[end]", "[end]"],
    ["{{if::notamacro::shown}}", "shown"],
    ["{{if user}}Hello {{user}}{{/if}}", "Hello User"],
    ["{{if yes}}This is the content{{/if}}", "This is the content"],
    ["{{if::}}This should not show{{/if}}[after]", "[after]"],
    ["{{if yes}}outer{{if yes}}inner{{/if}}{{/if}}", "outerinner"],
    ["{{if::}}outer{{if yes}}inner{{/if}}{{/if}}[end]", "[end]"],
    ["{{if yes}}outer{{if::}}inner{{/if}}end{{/if}}", "outerend"],
    ["{{if something}}content{{/if}}", "content"],
    ["{{if yes}}then{{else}}else{{/if}}", "then"],
    ["{{if::}}then{{else}}else{{/if}}", "else"],
    ["{{if::false}}yes{{else}}no{{/if}}", "no"],
    ["{{if::}}Hello {{user}}{{else}}Goodbye {{char}}{{/if}}", "Goodbye Character"],
    [
      "{{if yes}}outer-then{{if yes}}inner-then{{else}}inner-else{{/if}}{{else}}outer-else{{/if}}",
      "outer-theninner-then"
    ],
    [
      "{{if::}}outer-then{{else}}outer-else{{if yes}}inner-then{{else}}inner-else{{/if}}{{/if}}",
      "outer-elseinner-then"
    ],
    ["{{if::}}A{{else}}B{{if::}}C{{else}}D{{/if}}{{/if}}", "BD"],
    ["{{if yes}}  then  {{else}}  else  {{/if}}", "then"],
    ["{{if yes}}\n  then\n{{else}}\n  else\n{{/if}}", "then"],
    ["{{if::}}\n  then\n{{else}}\n  else\n{{/if}}", "else"],
    ["{{if noop}}Has value{{else}}Empty{{/if}}", "Empty"],
    ["{{if !yes}}shown{{/if}}[end]", "[end]"],
    ["{{if !false}}shown{{/if}}", "shown"],
    ["{{if::!}}not shown{{else}}shown{{/if}}", "not shown"],
    ["{{if !noop}}No value{{/if}}", "No value"],
    ["{{if !char}}No char{{else}}Has char{{/if}}", "Has char"],
    ["{{if::!something}}shown{{/if}}[end]", "[end]"],
    ["{{if yes}}\n  trimmed  \n{{/if}}", "trimmed"],
    ["{{#if yes}}\n  preserved  \n{{/if}}", "\n  preserved  \n"],
    ["{{if yes}}\n  # Title\n  Body text\n{{/if}}", "# Title\nBody text"],
    ["{{if false}}\n  Then branch\n{{else}}\n  # Else Title\n  Else body\n{{/if}}", "# Else Title\nElse body"],
    ["{{if 0}}{{if::1::inner}}{{else}}outer-else{{/if}}", "outer-else"],
    ["{{if 0}}{{if::1::a}}{{if::1::b}}{{else}}found{{/if}}", "found"],
    [
      "{{if description}}# Description\n{{description}}{{/if}}",
      "# Description\nCharacter is a  knight.\nFriend of User."
    ],
    ["{{if scenario}}has{{else}}none{{/if}}", "none"],
    // A condition naming a no-argument macro is resolved: {{trim}} resolves to nothing (unsure).
    ["{{if trim}}x{{else}}y{{/if}}", "y"],
    // ST compares "if" and "else" case-sensitively when splitting (unsure).
    ["{{if::}}a{{ELSE}}b{{/if}}", ""]
  ])
})

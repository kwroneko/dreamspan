import type { LorebookDoc, LorebookEntry } from "@rp/shared/docs/lorebook.ts"
import { describe, expect, it } from "vitest"
import { matchLorebooks } from "../src/assembler/lorebook.ts"
import { activationCases } from "./support/lorebookCases.ts"

type Input = Parameters<typeof matchLorebooks>
const entry = (fields: Partial<LorebookEntry> = {}, uid = 0): LorebookEntry => ({
  uid,
  keys: [],
  secondary_keys: [],
  comment: "",
  content: "",
  constant: false,
  selective: true,
  selective_logic: "and_any",
  enabled: true,
  order: 100,
  position: "before_char",
  depth: 4,
  role: "system",
  outlet_name: "",
  probability: 100,
  use_probability: true,
  group: "",
  group_override: false,
  group_weight: 100,
  use_group_scoring: null,
  scan_depth: null,
  case_sensitive: null,
  match_whole_words: null,
  sticky: null,
  cooldown: null,
  delay: null,
  exclude_recursion: false,
  prevent_recursion: false,
  delay_until_recursion: false,
  ignore_budget: false,
  vectorized: false,
  automation_id: "",
  triggers: [],
  match_persona_description: false,
  match_character_description: false,
  match_character_personality: false,
  match_character_depth_prompt: false,
  match_scenario: false,
  match_creator_notes: false,
  add_memo: false,
  use_regex: false,
  extensions: {},
  ...fields
})
const book = (entries: ReadonlyArray<LorebookEntry>, fields: Partial<LorebookDoc> = {}, id = "synthetic") => ({
  id,
  document: {
    schema_version: 1,
    name: id,
    description: "",
    scan_depth: null,
    token_budget: null,
    recursive_scanning: null,
    extensions: {},
    entries,
    ...fields
  } satisfies LorebookDoc
})
const run = (entries: ReadonlyArray<Partial<LorebookEntry>>, messages = ["cat"], settings: Partial<Input[2]> = {}) =>
  matchLorebooks(
    [book(entries.map((fields, uid) => entry(fields, uid)))],
    { messages },
    { budget: 25000, ...settings },
    () => 0.5,
    (text) => text.length
  )

describe("ST 1.19.0 activation table", () => {
  for (const c of activationCases) {
    it(`${c.id} ${c.title}${c.difference ? ` — deliberate scope difference: ${c.difference}` : ""}`, () => {
      const result = matchLorebooks(
        [book(c.entries.map((fields, uid) => entry(fields, uid)))],
        {
          messages: c.messages,
          ...(c.descriptions ? { descriptions: c.descriptions } : {}),
          ...(c.injections ? { injections: c.injections } : {}),
          ...(c.trigger ? { trigger: c.trigger } : {})
        },
        { budget: 25000, wholeWords: false, recursive: false, ...c.settings },
        () => c.random ?? 0.5,
        (text) => text.length
      )
      expect(result.activated.map(({ entry }) => entry.uid).sort((a, b) => a - b)).toEqual(c.expected)
      if (!c.difference) expect(c.expected).toEqual(c.stExpected)
      const sorted = c.expected
        .slice()
        .sort((a, b) => (c.entries[b]?.order ?? 100) - (c.entries[a]?.order ?? 100) || a - b)
      expect(result.activated.map(({ entry }) => entry.uid)).toEqual(sorted)
      expect(result.activated.length + result.skipped.length).toBe(c.entries.length)
      if (c.id === "R08") expect(result.issues).toContainEqual(expect.objectContaining({ code: "unsafe_regex" }))
      if (c.id.startsWith("T") && c.id !== "T01" && c.id !== "T02")
        expect(result.issues).toContainEqual(expect.objectContaining({ code: "unsupported" }))
      if (c.entries.some((entry) => entry.character_filter))
        expect(result.issues).toContainEqual(expect.objectContaining({ code: "unsupported" }))
    })
  }
})

describe("lorebook matcher contract", () => {
  it("keeps book identity with overlapping uids and does not mutate inputs", () => {
    const books = [
      book([entry({ keys: ["cat"], content: "dragon" })], {}, "one"),
      book([entry({ keys: ["dragon"] })], {}, "two")
    ]
    const before = structuredClone(books)
    const result = matchLorebooks(
      books,
      { messages: [" cat "] },
      { budget: 100 },
      () => 0.5,
      (text) => text.length
    )
    expect(result.activated.map(({ book, entry, step, why }) => ({ book, uid: entry.uid, step, why }))).toEqual([
      { book: "one", uid: 0, step: 0, why: { kind: "keys", primaryKey: "cat", secondaryKeys: [] } },
      { book: "two", uid: 0, step: 1, why: { kind: "keys", primaryKey: "dragon", secondaryKeys: [] } }
    ])
    expect(books).toEqual(before)
  })

  it("returns matched secondary keys, constant activation and each exclusion reason", () => {
    const result = run(
      [
        { keys: ["no", "cat"], secondary_keys: ["red", "blue"], content: "x" },
        { constant: true, order: 99, content: "x" },
        { keys: ["cat"], secondary_keys: ["no"] },
        { keys: ["cat"], probability: 0 },
        { keys: ["cat"], group: "g" },
        { keys: ["cat"], group: "g" },
        { keys: ["cat"], content: "oversized" }
      ],
      ["cat red"],
      { budget: 6, recursive: false, wholeWords: false }
    )
    expect(result.activated[0]?.why).toEqual({
      kind: "keys",
      primaryKey: "cat",
      secondaryKeys: ["red"],
      logic: "and_any"
    })
    expect(result.skipped.map(({ entry, reason }) => [entry.uid, reason])).toEqual([
      [2, "secondary"],
      [3, "probability"],
      [5, "group"],
      [6, "budget"],
      [1, "budget"]
    ])
    expect(run([{ constant: true }]).activated[0]?.why).toEqual({ kind: "constant" })
  })

  it("uses book defaults and explicit entry overrides; whole words and recursion default on", () => {
    const books = [
      book([entry({ keys: ["cat"], content: "dragon", scan_depth: 2 }), entry({ keys: ["dragon"] }, 1)], {
        scan_depth: 1
      })
    ]
    expect(
      matchLorebooks(
        books,
        { messages: ["dog", "cat"] },
        { budget: 100 },
        () => 0.5,
        (text) => text.length
      ).activated.map(({ entry }) => entry.uid)
    ).toEqual([0, 1])
    expect(run([{ keys: ["cat"] }], ["concatenate"]).activated).toEqual([])
    expect(
      matchLorebooks(
        [book([entry({ keys: ["cat"] })], { scan_depth: 0 })],
        { messages: ["cat"] },
        { budget: 100 },
        () => 0.5,
        (text) => text.length
      ).activated
    ).toEqual([])
    expect(
      matchLorebooks(
        [
          book([entry({ keys: ["cat"], content: "dragon" }), entry({ keys: ["dragon"] }, 1)], {
            recursive_scanning: false
          })
        ],
        { messages: ["cat"] },
        { budget: 100 },
        () => 0.5,
        (text) => text.length
      ).activated
    ).toHaveLength(1)
  })

  it("caps book budgets and uses injected token counts including the appended newline", () => {
    const calls: Array<string> = []
    const books = [book([entry({ constant: true, content: "long content" })], { token_budget: 3 })]
    const counter = (text: string) => {
      calls.push(text)
      return text ? 2 : 0
    }
    expect(matchLorebooks(books, { messages: [] }, { budget: 3 }, () => 0.5, counter).activated).toHaveLength(1)
    expect(calls).toContain("long content\n")
    expect(
      matchLorebooks(
        books,
        { messages: [] },
        { budget: 100 },
        () => 0.5,
        (text) => text.length
      ).skipped[0]?.reason
    ).toBe("budget")
  })

  it("does not reroll failed probability entries in recursive passes", () => {
    let rolls = 0
    const result = matchLorebooks(
      [book([entry({ keys: ["cat"], probability: 0 }), entry({ constant: true, content: "dragon" }, 1)])],
      { messages: ["cat"] },
      { budget: 100 },
      () => {
        rolls++
        return 0.5
      },
      (text) => text.length
    )
    expect(rolls).toBe(1)
    expect(result.skipped[0]?.reason).toBe("probability")
  })

  it("caps recursion and reports unfinished activation", () => {
    const result = run(
      [{ keys: ["cat"], content: "dragon" }, { keys: ["dragon"], content: "castle" }, { keys: ["castle"] }],
      ["cat"],
      { maxSteps: 2 }
    )
    expect(result.activated.map(({ step }) => step)).toEqual([0, 1])
    expect(result.issues).toContainEqual(expect.objectContaining({ uid: 2, code: "recursion_limit" }))
  })

  it("runs catastrophic backtracking patterns on the linear engine", () => {
    const result = run([{ keys: ["/(a+)+$/i"] }], ["a".repeat(50000) + "!"])
    expect(result.activated).toEqual([])
    expect(result.issues).toEqual([])
  })

  it("bounds expensive linear patterns with a VM deadline and keeps literal entries usable", () => {
    const pattern = `/${"(a*)".repeat(300)}b/`
    const result = run([{ keys: [pattern] }, { keys: ["a"] }], ["a".repeat(100000)], { regexMs: 1, wholeWords: false })
    expect(result.activated.map(({ entry }) => entry.uid)).toEqual([1])
    expect(result.skipped[0]?.reason).toBe("regex")
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "regex_timeout", key: pattern }))
  })

  it("reports invalid literal fallback, unsupported regexes and excessive patterns", () => {
    const result = run(
      [{ keys: ["/[/"] }, { keys: ["/(?=cat)cat/"] }, { keys: [`/${"a".repeat(2001)}/`] }],
      ["/[/ cat"]
    )
    expect(result.activated.map(({ entry }) => entry.uid)).toEqual([0])
    expect(result.issues.map(({ code }) => code)).toEqual(["invalid_regex", "unsafe_regex", "regex_limit"])
  })

  it("keeps the empty chat sentinel before descriptions and injected text", () => {
    const books = [book([entry({ keys: ["/^\\x01\\n\\x01cat$/"], match_scenario: true })])]
    const result = matchLorebooks(
      books,
      { messages: [], descriptions: { scenario: "cat" } },
      { budget: 100 },
      () => 0.5,
      (text) => text.length
    )
    expect(result.activated).toHaveLength(1)
  })

  it("reports invalid syntax for every entry sharing a cached key", () => {
    const result = run([{ keys: ["/[/"] }, { keys: ["/[/"] }], ["/[/"])
    expect(result.issues.map(({ uid, code }) => [uid, code])).toEqual([
      [0, "invalid_regex"],
      [1, "invalid_regex"]
    ])
  })

  it("caps rewritten patterns as well as their original spelling", () => {
    const result = run([{ keys: [`/${"a".repeat(501)}/i`] }])
    expect(result.issues[0]?.code).toBe("regex_limit")
  })

  it("advances delayed pass thresholds only with recursion enabled", () => {
    const entries = [{ keys: ["cat"], delay_until_recursion: 2 }]
    expect(run(entries).activated[0]?.step).toBe(2)
    expect(run(entries, ["cat"], { recursive: false }).activated).toEqual([])
  })

  it("scoring compares even opted-out candidates before selecting an override", () => {
    const result = run([
      { keys: ["cat", "cat"], group: "g", use_group_scoring: false },
      { keys: ["cat"], group: "g", use_group_scoring: true, group_override: true }
    ])
    expect(result.activated.map(({ entry }) => entry.uid)).toEqual([0])
  })

  it("shares the scripts' documented ASCII-case and Unicode regex limitations", () => {
    expect(run([{ keys: ["/É/i"] }], ["é"]).activated).toEqual([])
    expect(run([{ keys: ["/^\\x01.$/u"] }], ["😀"]).activated).toEqual([])
  })

  it("accepts a known primary match even when another primary pattern is refused", () => {
    const result = run([{ keys: ["/(?=cat)cat/", "cat"], secondary_keys: ["red"] }], ["cat red"])
    expect(result.activated).toHaveLength(1)
    expect(result.issues[0]?.code).toBe("unsafe_regex")
  })

  it("fails closed when a negative secondary condition cannot be safely tested", () => {
    const result = run([{ keys: ["cat"], secondary_keys: ["/(?=cat)cat/"], selective_logic: "not_any" }])
    expect(result.skipped[0]?.reason).toBe("regex")
  })
})

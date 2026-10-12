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

  it("R29 bounds expensive linear patterns deterministically and keeps literal entries usable", () => {
    const pattern = `/${"(a*)".repeat(300)}b/`
    const result = run([{ keys: [pattern] }, { keys: ["a"] }], ["a".repeat(100000)], { wholeWords: false })
    expect(result.activated.map(({ entry }) => entry.uid)).toEqual([1])
    expect(result.skipped[0]?.reason).toBe("regex")
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "regex_limit", key: pattern.slice(0, 160) }))
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

  it("reports invalid syntax once with affected entry examples", () => {
    const result = run([{ keys: ["/[/"] }, { keys: ["/[/"] }], ["/[/"])
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]).toMatchObject({ code: "invalid_regex", count: 2, examples: [{ uid: 0 }, { uid: 1 }] })
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

describe("Astra review regressions", () => {
  it("K14 long plain whole-word keywords never compile as native regexes", () => {
    const key = "a".repeat(100000)
    expect(run([{ keys: [key] }], [key], { recursive: false }).activated).toHaveLength(1)
  })

  it("D25 trailing empty messages do not add ST sentinels", () => {
    expect(run([{ keys: ["/cat$/"] }], ["cat", ""]).activated).toHaveLength(1)
    expect(run([{ keys: ["/^\\x01\\n\\x01cat$/"] }], ["", "cat"]).activated).toHaveLength(1)
    expect(run([{ keys: ["/cat$/"] }], ["cat", " "]).activated).toHaveLength(0)
  })

  it("G18 secondary scoring needs primary slots, not a matching primary", () => {
    const result = run(
      [
        {
          keys: [" cat "],
          secondary_keys: ["red", "blue"],
          selective: false,
          group: "g",
          use_group_scoring: true,
          order: 1
        },
        { keys: ["cat"], group: "g", use_group_scoring: true, order: 2 }
      ],
      ["cat red blue"],
      { wholeWords: false }
    )
    expect(result.activated.map(({ entry }) => entry.uid)).toEqual([0])
    expect(
      run([
        { constant: true, keys: ["dog"], secondary_keys: ["cat"], group: "g", use_group_scoring: true, order: 1 },
        { constant: true, keys: ["dog"], group: "g", use_group_scoring: true, order: 2 }
      ]).activated.map(({ entry }) => entry.uid)
    ).toEqual([0])
  })

  it("G19 empty scoring slots match without activation's truthiness gate", () => {
    expect(
      run([
        { keys: ["cat", ""], group: "g", use_group_scoring: true, order: 1 },
        { keys: ["cat"], group: "g", use_group_scoring: true, order: 2 }
      ]).activated.map(({ entry }) => entry.uid)
    ).toEqual([0])
  })

  it("B10 a book's exhausted budget does not spend or stop other books", () => {
    const result = matchLorebooks(
      [
        book(
          [
            entry({ constant: true, content: "long", order: 200 }),
            entry({ constant: true, content: "", order: 150 }, 1)
          ],
          { token_budget: 2 },
          "small"
        ),
        book([entry({ constant: true, content: "x" })], {}, "other")
      ],
      { messages: [] },
      { budget: 3 },
      () => 0.5,
      (text) => text.length
    )
    expect(result.activated.map(({ book }) => book)).toEqual(["other"])
    expect(result.skipped.map(({ reason }) => reason)).toEqual(["budget", "budget"])
  })

  it("R23 short regex activations replay identically without the old 200 ms cutoff", () => {
    const entries = Array.from({ length: 3000 }, (_, i) => ({ keys: [`/cat|absent${i}/`], content: "x" }))
    const first = run(entries, ["cat"], { budget: 1e9, recursive: false })
    // Deliberate safety departure: ST has no aggregate token-counter work cap.
    expect(first.activated).toHaveLength(2827)
    expect(first.replayable).toBe(true)
    expect(first.issues).toEqual([
      expect.objectContaining({ code: "work_limit", detail: expect.stringContaining("tokenCharacters") })
    ])
    expect(run(entries, ["cat"], { budget: 1e9, recursive: false })).toEqual(first)
  })

  it.each([
    ["R24", "/(cat)\\1/", /backreference/i, /repeat.*literal/i],
    ["R25", "/(?=cat)cat/", /lookahead/i, /secondary.*AND ANY/i],
    ["R26", "/cat(?!fish)/", /negative lookahead/i, /secondary.*NOT ANY/i],
    ["R27", "/(?<=(cat))cat/", /lookbehind.*captur/i, /remove.*captur/i],
    ["R28", "/\\p{L}/u", /Unicode property/i, /explicit.*class/i]
  ])("%s refused regex explains the construct and a remedy", (_, key, construct, remedy) => {
    const result = run([{ keys: [key as string] }])
    expect(result.issues[0]?.detail).toMatch(construct as RegExp)
    expect(result.issues[0]?.detail).toMatch(remedy as RegExp)
  })

  it("L01 limits aggregate scanning across entries", () => {
    const result = run(
      Array.from({ length: 100 }, () => ({ keys: ["missing"], scan_depth: 1000 })),
      ["A".repeat(1000000)],
      { recursive: false }
    )
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "work_limit", detail: expect.stringContaining("scannedCharacters") })
    )
  })

  it("L02 limits aggregate scanning across keys within one entry", () => {
    const result = run([{ keys: Array.from({ length: 10000 }, (_, i) => `missing${i}`) }], ["A".repeat(250000)], {
      recursive: false
    })
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "work_limit" }))
  })

  it("L03 bounds total text sent to the token counter", () => {
    let characters = 0
    const result = matchLorebooks(
      [book(Array.from({ length: 1000 }, (_, i) => entry({ constant: true, content: "a".repeat(2000) }, i)))],
      { messages: [] },
      { budget: 1e9, recursive: false },
      () => 0.5,
      (text) => {
        characters += text.length
        return text.length
      }
    )
    expect(characters).toBeLessThanOrEqual(8000000)
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "work_limit", detail: expect.stringContaining("tokenCharacters") })
    )
  })

  it("L04 collapses repeated regex refusals and bounds issue collection", () => {
    const result = run([{ keys: Array.from({ length: 2000 }, (_, i) => `/(?=cat)${i}/`) }])
    expect(result.issues.length).toBeLessThanOrEqual(2)
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "work_limit", detail: expect.stringContaining("issueCount") })
    )
  })
})

describe("deterministic lorebook work bounds", () => {
  it("L05 stops the 10,000-entry long-buffer reproduction at a fixed amount of work", () => {
    const result = run(
      Array.from({ length: 10000 }, () => ({ keys: ["missing"], scan_depth: 1000 })),
      Array.from({ length: 1000 }, () => "A".repeat(1000)),
      { recursive: false }
    )
    expect(result.work.scannedCharacters).toBeLessThanOrEqual(20000000)
    expect(result.work.keyEvaluations).toBe(18)
    expect(result.work.buffers).toBe(1)
    expect(result.issues).toEqual([
      expect.objectContaining({ code: "work_limit", detail: expect.stringContaining("scannedCharacters") })
    ])
    expect(result.skipped).toHaveLength(10000)
    expect(result.replayable).toBe(true)
  })

  it("L06 bounds even empty key slots by the number of evaluations", () => {
    const result = run([{ keys: Array.from({ length: 30000 }, () => "") }])
    expect(result.work.keyEvaluations).toBe(20000)
    expect(result.issues).toEqual([
      expect.objectContaining({ code: "work_limit", detail: expect.stringContaining("keyEvaluations") })
    ])
  })

  it("L07 bounds aggregate regex work independently of scanned character work", () => {
    const result = run([{ keys: Array.from({ length: 20 }, () => `/${"a?".repeat(100)}z/`) }], ["a".repeat(5000)], {
      recursive: false
    })
    expect(result.work.regexWork).toBe(19 * 201 * 5001)
    expect(result.issues).toEqual([
      expect.objectContaining({ code: "work_limit", detail: expect.stringContaining("regexWork") })
    ])
  })

  it("L08 counts the invariant prefix once and preserves non-additive tokenization", () => {
    const calls: Array<string> = []
    const result = matchLorebooks(
      [
        book([
          entry({ keys: ["cat"], content: "dragon", order: 200 }),
          entry({ keys: ["dragon"], content: "a" }, 1),
          entry({ keys: ["dragon"], content: "b" }, 2)
        ])
      ],
      { messages: ["cat"] },
      { budget: 5 },
      () => 0.5,
      (text) => {
        calls.push(text)
        return text === "a\nb\n" ? 10 : text ? 1 : 0
      }
    )
    expect(result.activated.map(({ entry }) => entry.uid)).toEqual([0, 1])
    // The next pass reuses the count from the first admission.
    expect(calls.filter((text) => text === "dragon\n")).toHaveLength(1)
    expect(calls).toContain("a\nb\n")
  })

  it("L09 unscored constants do not build or scan buffers", () => {
    const result = run([{ constant: true }], ["a".repeat(1000000)])
    expect(result.work.buffers).toBe(0)
    expect(result.work.scannedCharacters).toBe(1)
  })

  it("L10 issue summaries keep only a count and the first three bounded examples", () => {
    const result = run([{ keys: Array.from({ length: 100000 }, (_, i) => `/(?=cat)${i}${"x".repeat(200)}/`) }])
    expect(result.work.issueCount).toBe(1000)
    expect(result.issues).toHaveLength(2)
    expect(result.issues[0]?.count).toBe(1000)
    expect(result.issues[0]?.examples).toHaveLength(3)
    expect(result.issues[0]?.examples.every((example) => example.key!.length <= 160)).toBe(true)
    expect(result.issues[1]?.code).toBe("work_limit")
  })

  it("L11 preserves completed admissions when the next token count exhausts work", () => {
    const result = run(
      [
        { constant: true, content: "a" },
        { constant: true, content: "b" }
      ],
      [],
      { recursive: false, workLimits: { tokenCharacters: 2 } }
    )
    expect(result.activated.map(({ entry }) => entry.uid)).toEqual([0])
    expect(result.skipped.map(({ entry, reason }) => [entry.uid, reason])).toEqual([[1, "work_limit"]])
    expect(result.work.tokenCharacters).toBe(2)
  })

  it("R30 the emergency guard explicitly marks partial results as not replayable", () => {
    const result = run([{ keys: ["/(a+)+$/i"] }], ["a".repeat(50000) + "!"], { regexMs: 0 })
    expect(result.replayable).toBe(false)
    expect(result.issues).toEqual([
      expect.objectContaining({ code: "regex_timeout", detail: expect.stringContaining("not replayable") })
    ])
  })

  it("R31 oversized malformed slash patterns are refused before parsing (safety departure from ST)", () => {
    const key = `/${"(".repeat(2001)}/`
    const result = run([{ keys: [key] }], [key])
    expect(result.activated).toHaveLength(0)
    expect(result.issues[0]?.code).toBe("regex_limit")
  })

  it("L12 evaluation failures become issues with the completed partial result", () => {
    const result = matchLorebooks(
      [book([entry({ constant: true, content: "a" }), entry({ constant: true, content: "b" }, 1)])],
      { messages: [] },
      { budget: 100 },
      () => 0.5,
      (text) => {
        if (text === "a\nb\n") throw new Error("synthetic tokenizer failure")
        return text.length
      }
    )
    expect(result.activated.map(({ entry }) => entry.uid)).toEqual([0])
    expect(result.issues[0]).toMatchObject({
      code: "evaluation_error",
      detail: expect.stringContaining("synthetic tokenizer failure")
    })
    expect(result.skipped[0]?.reason).toBe("error")
  })
})

import { CardDoc } from "@dreamspan/shared/docs/card.ts"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { cardToJson } from "../../src/formats/cardExport.ts"
import { importCard } from "../../src/formats/cardImport.ts"
import { defaultLimits } from "../../src/formats/safety.ts"
import { cardV3, failure, json, run, stCardV2 } from "./support.ts"

const codes = (result: { report: { issues: ReadonlyArray<{ code: string }> } }) =>
  result.report.issues.map((issue) => issue.code)

describe("JSON card import", () => {
  it("reads an ST V2 card, keeping extensions and unknown fields verbatim", () => {
    const result = run(importCard(json(stCardV2())))
    const card = Schema.decodeUnknownSync(CardDoc)(result.card)
    expect(result.report.format).toBe("card-v2-json")
    expect(card).toMatchObject({
      name: "Wren",
      system_prompt: "Stay in character.",
      alternate_greetings: ["Another storm.", "Fog again."],
      character_version: "1.2",
      avatar_media_id: null
    })
    expect(card).not.toHaveProperty("modules")
    expect(card.extensions).toEqual(stCardV2().data.extensions)
    expect(card.unknown_fields).toEqual({ an_unknown_field: { kept: true } })
    // ST's V1 copies and local state aren't kept; other top-level keys are.
    expect(card.unknown_root_fields).toEqual({ some_root_field: 42 })
    expect(codes(result)).toEqual([])
  })

  it("maps the embedded book as ST's convertCharacterBook does", () => {
    const book = run(importCard(json(stCardV2()))).card.character_book!
    expect(book).toMatchObject({ name: "Hollowmere", scan_depth: 3, extensions: { "some-plugin": true } })
    const [first, second] = book.entries
    expect(first).toMatchObject({
      uid: 7,
      keys: ["lighthouse", "lamp"],
      secondary_keys: ["storm"],
      order: 50,
      position: "at_depth",
      depth: 2,
      role: "user",
      selective_logic: "and_all",
      probability: 80,
      group: "places",
      sticky: 2,
      delay_until_recursion: 1,
      triggers: ["normal"],
      add_memo: true,
      use_regex: true
    })
    // ST's fields are lifted out of `extensions`; everything else stays.
    expect(first!.extensions).toEqual({ "some-plugin": { weight: 1 } })
    // A missing id gets a number after the largest; ST's defaults fill the rest.
    expect(second).toMatchObject({
      uid: 8,
      position: "after_char",
      depth: 4,
      role: "system",
      probability: 100,
      use_probability: true,
      selective: false,
      add_memo: false,
      display_index: 1
    })
  })

  it("reads V3 fields", () => {
    const result = run(importCard(json(cardV3())))
    expect(result.report.format).toBe("card-v3-json")
    expect(result.card).toMatchObject({
      group_only_greetings: ["Hello, everyone."],
      nickname: "Mossy",
      source: ["https://example.com/moss"],
      creator_notes_multilingual: { fr: "Notes en français." },
      creation_date: 1_700_000_000,
      assets: [{ type: "icon", uri: "ccdefault:", name: "main", ext: "png" }]
    })
    expect(result.card.unknown_root_fields).toBeUndefined()
  })

  it("reads a V1 card as ST does", () => {
    const result = run(
      importCard(
        json({
          name: "Old",
          description: "From before V2.",
          creatorcomment: "Creator's notes go here.",
          tags: "a, b,,c",
          talkativeness: 0.7,
          avatar: "none",
          extra: "kept"
        })
      )
    )
    expect(result.report.format).toBe("card-v1-json")
    expect(result.card).toMatchObject({
      name: "Old",
      description: "From before V2.",
      creator_notes: "",
      tags: ["a", "b", "c"],
      extensions: { talkativeness: 0.7 },
      unknown_root_fields: { extra: "kept" }
    })
  })

  it("replaces fields of the wrong type with defaults and reports each", () => {
    const card = stCardV2()
    const data = {
      ...card.data,
      description: 5,
      alternate_greetings: "Just one.",
      tags: ["ok", 3],
      nickname: 9,
      character_book: {
        entries: [
          { keys: ["a"], content: "x", enabled: true, extensions: { depth: "deep", position: 99 } },
          { id: 0, keys: ["b"], content: "y" },
          "not an entry"
        ]
      }
    }
    const result = run(importCard(json({ ...card, data })))
    expect(result.card).toMatchObject({ description: "", alternate_greetings: ["Just one."], tags: ["ok"] })
    expect(result.card.nickname).toBeUndefined()
    const [first, second] = result.card.character_book!.entries
    expect(first).toMatchObject({ uid: 1, depth: 4, position: "before_char" })
    // Ids are kept; a missing one gets a free number. A missing `enabled` disables the entry, as in ST.
    expect(second).toMatchObject({ uid: 0, enabled: false })
    expect(result.card.character_book!.entries).toHaveLength(2)
    expect(result.report.issues.map((issue) => [issue.code, issue.path])).toEqual([
      ["field.invalid", ["data", "description"]],
      ["field.invalid", ["data", "nickname"]],
      ["field.invalid", ["data", "tags"]],
      ["field.invalid", ["data", "character_book", "entries", 0, "extensions", "position"]],
      ["field.invalid", ["data", "character_book", "entries", 0, "extensions", "depth"]],
      ["lorebook.disabled", ["data", "character_book", "entries", 1]],
      ["lorebook.invalid_entry", ["data", "character_book", "entries", 2]]
    ])
  })

  it("renumbers bad and duplicate ids without taking a valid one, and exports a bad id as it was", () => {
    const entry = (id: unknown, content: string) => ({ id, keys: ["k"], content, enabled: true })
    const book = { entries: [entry("intro", "A"), entry(0, "B"), entry(0, "C"), entry(1e300, "D")] }
    const result = run(importCard(json({ spec: "chara_card_v3", data: { name: "x", character_book: book } })))
    const entries = result.card.character_book!.entries
    expect(entries.map((e) => [e.content, e.uid])).toEqual([
      ["A", 1],
      ["B", 0],
      ["C", 2],
      ["D", 3]
    ])
    expect(codes(result)).toEqual(["lorebook.invalid_id", "lorebook.invalid_id", "lorebook.duplicate_id"])
    const exported = cardToJson(result.card, "v3").data as unknown as {
      character_book: { entries: Array<{ id: unknown }> }
    }
    expect(exported.character_book.entries.map((e) => e.id)).toEqual(["intro", 0, 2, 1e300])
  })

  it("leaves the notes a previous export stored in its extension for the importer, which makes them card notes", () => {
    const card = stCardV2()
    const rp_harness = { modules: [{ id: "m1", title: "Outfit", content: "Oilskin." }], other: 1 }
    const extensions = { ...card.data.extensions, rp_harness }
    const result = run(importCard(json({ ...card, data: { ...card.data, extensions } })))
    expect(result.card).not.toHaveProperty("modules")
    expect(result.card.extensions.rp_harness).toEqual(rp_harness)
    expect(codes(result)).toEqual([])
  })

  it("refuses files that aren't cards", () => {
    expect(failure(importCard(json({ spec: "chara_card_v2" })))).toBe("card.not_a_card")
    expect(failure(importCard(json([1, 2])))).toBe("card.not_a_card")
    expect(failure(importCard(new TextEncoder().encode("{not json")))).toBe("json.invalid")
  })
})

describe("JSON hardening", () => {
  it("drops prototype keys so they never reach an object", () => {
    const text = `{"spec":"chara_card_v2","data":{"name":"P","extensions":{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"ok":1},"character_book":{"entries":[{"keys":["k"],"content":"c","enabled":true,"__proto__":{"polluted":true}}]}}}`
    const result = run(importCard(new TextEncoder().encode(text)))
    expect(Object.keys(result.card.extensions)).toEqual(["ok"])
    expect(Object.hasOwn(result.card.extensions, "__proto__")).toBe(false)
    expect(result.card.character_book!.entries[0]!.unknown_fields).toBeUndefined()
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(codes(result)).toEqual(["json.forbidden_key", "json.forbidden_key", "json.forbidden_key"])
  })

  it("rejects nesting deeper than the limit", () => {
    const deep = (levels: number): unknown => (levels === 0 ? {} : { a: deep(levels - 1) })
    const card = (levels: number) => ({ spec: "chara_card_v2", data: { name: "D", extensions: deep(levels) } })
    // The root, `data` and `extensions` take three levels.
    run(importCard(json(card(defaultLimits.maxJsonDepth - 3))))
    expect(failure(importCard(json(card(defaultLimits.maxJsonDepth - 2))))).toBe("json.too_deep")
    // Nesting far past what a recursive walk could survive is refused, not a crash.
    const text = "[".repeat(200_000) + "]".repeat(200_000)
    expect(failure(importCard(new TextEncoder().encode(text)))).toBe("json.too_deep")
  })

  it("rejects files and JSON over their size caps", () => {
    const big = (bytes: number) => new Uint8Array(bytes).fill(0x20)
    expect(failure(importCard(big(defaultLimits.maxFileBytes + 1)))).toBe("file.too_large")
    expect(failure(importCard(big(defaultLimits.maxCardJsonBytes + 1)))).toBe("json.too_large")
  })

  it("caps the report however many problems a file has", () => {
    const bad = { keys: [1], content: 1, comment: 1, enabled: 1, extensions: { depth: "x", role: 9 } }
    const card = { spec: "chara_card_v2", data: { name: "x", character_book: { entries: Array(2000).fill(bad) } } }
    const issues = run(importCard(json(card))).report.issues
    expect(issues).toHaveLength(201)
    expect(issues[200]).toMatchObject({ code: "report.truncated", message: "11800 more issues aren't listed." })
  })

  it("refuses a file with more prototype keys than the cap", () => {
    const card = (count: number) =>
      `{"spec":"chara_card_v2","data":{"name":"x","extensions":[${Array(count).fill('{"__proto__":0}').join(",")}]}}`
    run(importCard(new TextEncoder().encode(card(defaultLimits.maxForbiddenKeys))))
    const file = new TextEncoder().encode(card(defaultLimits.maxForbiddenKeys + 1))
    expect(failure(importCard(file))).toBe("json.forbidden_keys")
  })

  it("counts objects and lists before parsing, and not inside strings", () => {
    // The root, `data` and the list are three.
    const card = (count: number) =>
      `{"spec":"chara_card_v2","data":{"name":"x","tags":[${Array(count).fill("{}").join(",")}]}}`
    const limit = defaultLimits.maxJsonContainers
    run(importCard(new TextEncoder().encode(card(limit - 3))))
    expect(failure(importCard(new TextEncoder().encode(card(limit - 2))))).toBe("json.too_many_containers")
    const braces = '{[\\"'.repeat(300_000)
    expect(run(importCard(json({ name: braces, description: "[".repeat(100) }))).card.name).toBe(braces)
  })

  it("reads spec_version only when it's text or a number", () => {
    for (const spec_version of [{ toString: 0 }, { valueOf: 0, toString: 0 }, ["4"], "4.0", 4]) {
      run(importCard(json({ spec: "chara_card_v3", spec_version, data: { name: "x" } })))
    }
  })

  it("refuses a card book with more entries than the cap", () => {
    const card = (count: number) => ({
      spec: "chara_card_v2",
      data: { name: "x", character_book: { entries: Array(count).fill(1) } }
    })
    run(importCard(json(card(defaultLimits.maxLorebookEntries))))
    expect(failure(importCard(json(card(defaultLimits.maxLorebookEntries + 1))))).toBe("lorebook.too_many_entries")
  })
})

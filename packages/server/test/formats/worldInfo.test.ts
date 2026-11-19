import { LorebookDoc } from "@dreamspan/shared/docs/lorebook.ts"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { cardToJson } from "../../src/formats/cardExport.ts"
import { importCard } from "../../src/formats/cardImport.ts"
import { defaultLimits } from "../../src/formats/safety.ts"
import { exportLorebook, importLorebook } from "../../src/formats/worldInfo.ts"
import { mapLorebookFilters } from "../../src/formats/lorebookFilters.ts"
import { characterFilterPasses } from "@dreamspan/shared/lorebookFilters.ts"
import { failure, json, run, stCardV2, worldInfo } from "./support.ts"

/** Every key and value of `expected` is in `actual`. */
const expectSuperset = (actual: unknown, expected: unknown, path = "") => {
  if (typeof expected === "object" && expected !== null) {
    for (const [key, value] of Object.entries(expected)) {
      expectSuperset((actual as Record<string, unknown>)?.[key], value, `${path}.${key}`)
    }
  } else {
    expect(actual, path).toEqual(expected)
  }
}

describe("World Info import", () => {
  it("resolves filenames and local tag IDs, filters the speaker, and exports the original ST shape", () => {
    const source = {
      entries: {
        0: { key: ["cat"], characterFilter: { names: ["alice", "missing"], tags: ["tag-1"], isExclude: false } }
      }
    }
    const imported = run(importLorebook(json(source))).lorebook
    const mapped = mapLorebookFilters(imported, { cards: { alice: "card-alice" }, tags: { "tag-1": "Mages" } })
    const filter = mapped.entries[0]!.character_filter
    expect(filter).toEqual({
      names: ["missing"],
      cards: [{ entity: "card-alice", name: "alice" }],
      tags: ["Mages"],
      tag_ids: { Mages: "tag-1" },
      is_exclude: false
    })
    expect(characterFilterPasses(filter, { entity: "card-alice", tags: ["Mages"] })).toBe(true)
    expect(characterFilterPasses(filter, { entity: "card-bob", tags: ["Mages"] })).toBe(false)
    expect(characterFilterPasses(filter, { entity: "card-alice", tags: [] })).toBe(false)
    const exported = JSON.parse(new TextDecoder().decode(exportLorebook(mapped)))
    expect(exported.entries[0].characterFilter).toEqual({
      names: ["missing", "alice"],
      tags: ["tag-1"],
      isExclude: false
    })
    expect(run(importLorebook(json(exported))).lorebook).toEqual(mapped)
    const again = mapLorebookFilters(run(importLorebook(json(exported))).lorebook, {
      cards: { alice: "card-alice" },
      tags: { "tag-1": "Mages" }
    })
    expect(again).toEqual(mapped)
  })

  it("maps ST's fields and keeps everything else", () => {
    const { lorebook, report } = run(importLorebook(json(worldInfo()), "Harbor"))
    expect(Schema.decodeUnknownSync(LorebookDoc)(lorebook)).toEqual(lorebook)
    expect(report.format).toBe("st-world-info")
    expect(lorebook).toMatchObject({
      name: "Harbor",
      scan_depth: null,
      extensions: { "some-plugin": "book" },
      unknown_fields: { topLevelExtra: true }
    })
    expect(lorebook.entries[0]).toMatchObject({
      uid: 3,
      selective_logic: "not_any",
      position: "outlet",
      enabled: false,
      role: "assistant",
      delay_until_recursion: 2,
      character_filter: { is_exclude: true, names: ["Wren.png"], tags: ["t1"] },
      decision_hint: "Is anyone at the harbor?",
      extensions: { "some-plugin": { x: 1 }, rp_harness: { other: 2 } },
      unknown_fields: { someNewStField: "kept" }
    })
  })

  it("fills a sparse entry with ST's template defaults", () => {
    const entry = run(importLorebook(json(worldInfo()))).lorebook.entries[1]
    expect(entry).toMatchObject({
      uid: 9,
      selective: true,
      selective_logic: "and_any",
      enabled: true,
      order: 100,
      position: "before_char",
      depth: 4,
      probability: 100,
      use_probability: true,
      group_weight: 100,
      delay_until_recursion: 0,
      add_memo: false
    })
  })

  it("round-trips: an export has everything the file had, and imports back the same", () => {
    const { lorebook } = run(importLorebook(json(worldInfo())))
    const exported = JSON.parse(new TextDecoder().decode(exportLorebook(lorebook)))
    const { originalData: _, ...rest } = worldInfo()
    expectSuperset(exported, rest)
    expect(run(importLorebook(json(exported))).lorebook).toEqual(lorebook)
  })

  it("refuses files without entries, and drops prototype keys among them", () => {
    expect(failure(importLorebook(json({ name: "x" })))).toBe("lorebook.not_a_lorebook")
    expect(failure(importLorebook(json([])))).toBe("lorebook.not_a_lorebook")
    const text = `{"entries":{"__proto__":{"key":["a"],"content":"x"},"1":{"key":["b"],"content":"y"}}}`
    const { lorebook, report } = run(importLorebook(new TextEncoder().encode(text)))
    expect(lorebook.entries.map((entry) => entry.uid)).toEqual([1])
    expect(report.issues.map((issue) => issue.code)).toEqual(["json.forbidden_key"])
    expect(failure(importLorebook(new Uint8Array(defaultLimits.maxFileBytes + 1)))).toBe("file.too_large")
  })

  it("refuses more entries, or more JSON, than the caps", () => {
    const book = (count: number) => json({ entries: Array(count).fill(0) })
    run(importLorebook(book(defaultLimits.maxLorebookEntries)))
    expect(failure(importLorebook(book(defaultLimits.maxLorebookEntries + 1)))).toBe("lorebook.too_many_entries")
    // World Info may be bigger than a card.
    const padded = (bytes: number) => {
      const file = new Uint8Array(bytes).fill(0x20)
      file.set(json({ entries: {} }))
      return file
    }
    run(importLorebook(padded(defaultLimits.maxLorebookJsonBytes)))
    expect(failure(importLorebook(padded(defaultLimits.maxLorebookJsonBytes + 1)))).toBe("json.too_large")
  })

  it("counts every value and key before parsing", () => {
    // Six colons and two commas besides the list's own commas.
    const file = (zeros: number, end = "]}}}}") =>
      new TextEncoder().encode(
        `{"entries":{"0":{"key":["a"],"content":"b","extensions":{"blob":[${Array(zeros).fill("0").join(",")}${end}`
      )
    const limit = defaultLimits.maxJsonValues
    run(importLorebook(file(limit - 7)))
    expect(failure(importLorebook(file(limit - 6)))).toBe("json.too_many_values")
    // 30 MiB of zeros, cut short: a parse would fail as invalid JSON, so the scan refused it first.
    expect(failure(importLorebook(file(15 * 1024 * 1024, "")))).toBe("json.too_many_values")
  })

  it("keeps valid uids when renumbering others", () => {
    const { lorebook, report } = run(
      importLorebook(json({ entries: [{ uid: "a" }, { uid: 0 }, { uid: 0 }, { uid: 1e300 }] }))
    )
    expect(lorebook.entries.map((entry) => entry.uid)).toEqual([1, 0, 2, 3])
    expect(report.issues.map((issue) => issue.code)).toEqual(["lorebook.duplicate_id"])
  })
})

describe("character book and World Info", () => {
  it("converts a card book to World Info as ST's convertCharacterBook does", () => {
    const book = run(importCard(json(stCardV2()))).card.character_book!
    const entries = JSON.parse(new TextDecoder().decode(exportLorebook(book))).entries
    expect(entries["7"]).toMatchObject({
      uid: 7,
      key: ["lighthouse", "lamp"],
      keysecondary: ["storm"],
      comment: "the lighthouse",
      selective: true,
      order: 50,
      position: 4,
      disable: false,
      addMemo: true,
      displayIndex: 0,
      probability: 80,
      useProbability: true,
      depth: 2,
      selectiveLogic: 3,
      group: "places",
      groupWeight: 100,
      role: 1,
      sticky: 2,
      delayUntilRecursion: 1,
      triggers: ["normal"],
      extensions: { "some-plugin": { weight: 1 } }
    })
    expect(entries["8"]).toMatchObject({ uid: 8, position: 1, selective: false, addMemo: false, depth: 4, role: 0 })
  })

  it("converts World Info to a card book as ST's convertWorldInfoToCharacterBook does", () => {
    const { lorebook } = run(importLorebook(json(worldInfo()), "Harbor"))
    const card = run(importCard(json(stCardV2()))).card
    const data = cardToJson({ ...card, character_book: lorebook }, "v2").data as unknown as {
      character_book: { name: string; entries: Array<unknown> }
    }
    expect(data.character_book.name).toBe("Harbor")
    expect(data.character_book.entries[0]).toMatchObject({
      id: 3,
      keys: ["harbor"],
      secondary_keys: ["night"],
      insertion_order: 20,
      enabled: false,
      position: "after_char",
      extensions: {
        position: 7,
        exclude_recursion: true,
        display_index: 1,
        probability: 50,
        useProbability: false,
        depth: 6,
        selectiveLogic: 2,
        outlet_name: "harbor-outlet",
        group_override: true,
        group_weight: 30,
        scan_depth: 5,
        case_sensitive: true,
        use_group_scoring: true,
        automation_id: "auto",
        role: 2,
        cooldown: 3,
        delay: 4,
        match_persona_description: true,
        ignore_budget: true,
        rp_harness: { decision_hint: "Is anyone at the harbor?", other: 2 }
      }
    })
  })

  it("keeps our own fields through both formats", () => {
    const { lorebook } = run(importLorebook(json(worldInfo())))
    const ours = {
      ...lorebook,
      entries: lorebook.entries.map((entry) => ({
        ...entry,
        decision_hint: "Relevant?",
        placement_override: { mode: "depth" as const, depth: 2 }
      }))
    }
    const viaWorldInfo = run(importLorebook(exportLorebook(ours))).lorebook
    const card = run(importCard(json(stCardV2()))).card
    const viaCard = run(importCard(json(cardToJson({ ...card, character_book: ours }, "v3")))).card.character_book!
    for (const book of [viaWorldInfo, viaCard]) {
      expect(book.entries.map((e) => [e.decision_hint, e.placement_override])).toEqual([
        ["Relevant?", { mode: "depth", depth: 2 }],
        ["Relevant?", { mode: "depth", depth: 2 }]
      ])
    }
  })
})

// The preset and model pickers' lists (the owner, 2026-11-01): the text filters every view,
// Name, Modified and Used leave archived presets out, Archived shows only them, latest archived
// first, and the line under each name says when it was edited, used or archived.
import { LibraryRef } from "@dreamspan/shared/library.ts"
import { describe, expect, it } from "vitest"
import { matchesModel, modelDetail, modelRows, modelsInOrder } from "../src/features/pickers/modelList.ts"
import { presetDetail, presetsInView, selectablePresets } from "../src/features/pickers/presetList.ts"

const day = 86_400_000
const now = new Date(2026, 10, 1, 12).getTime()
const preset = (label: string, over: { updatedAt?: number; lastUsedAt?: number | null; archivedAt?: number | null }) =>
  new LibraryRef({
    id: `ref-${label}` as LibraryRef["id"],
    entityId: `entity-${label}` as LibraryRef["entityId"],
    kind: "preset",
    label,
    subtitle: "",
    headRevisionId: `rev-${label}` as LibraryRef["headRevisionId"],
    parentEntityId: null,
    updateAvailable: false,
    rowVersion: 1,
    updatedAt: over.updatedAt ?? now - day,
    archivedAt: over.archivedAt ?? null,
    lastUsedAt: over.lastUsedAt ?? null
  })

const live = [
  preset("Café noir", { updatedAt: now - 3 * day, lastUsedAt: now - 2 * 3_600_000 }),
  preset("Alpha", { updatedAt: now - 10 * day }),
  preset("Bravo", { updatedAt: now - 60_000 * 5, lastUsedAt: now - 5 * day })
]
const archived = [
  preset("Old A", { archivedAt: now - 9 * day }),
  preset("Old B", { archivedAt: now - day }),
  preset("Café old", { archivedAt: now - 3 * day })
]
const labels = (refs: ReadonlyArray<LibraryRef>) => refs.map((ref) => ref.label)

describe("the preset lists", () => {
  it("sorts each view, leaving archived presets to the Archived view", () => {
    expect(labels(presetsInView("name", "", live, archived))).toEqual(["Alpha", "Bravo", "Café noir"])
    expect(labels(presetsInView("modified", "", live, archived))).toEqual(["Bravo", "Café noir", "Alpha"])
    // Never used last, by name.
    expect(labels(presetsInView("used", "", live, archived))).toEqual(["Café noir", "Bravo", "Alpha"])
    // Most recently archived first.
    expect(labels(presetsInView("archived", "", live, archived))).toEqual(["Old B", "Café old", "Old A"])
  })

  it("filters every view by the text, ignoring case and accents", () => {
    expect(labels(presetsInView("name", "CAFE", live, archived))).toEqual(["Café noir"])
    expect(labels(presetsInView("archived", "cafe", live, archived))).toEqual(["Café old"])
    expect(labels(presetsInView("used", "zzz", live, archived))).toEqual([])
  })

  it("places an entry by its archive time when a list read mid-change has it in both", () => {
    const moved = preset("Alpha", { archivedAt: now })
    expect(labels(presetsInView("name", "", live, [moved]))).toEqual(["Bravo", "Café noir"])
    expect(labels(presetsInView("archived", "", live, [moved]))).toEqual(["Alpha"])
  })

  it("says when each was edited, used or archived", () => {
    expect(presetDetail(live[2]!, "name", now)).toBe("edited 5 minutes ago")
    expect(presetDetail(live[0]!, "used", now)).toBe("used 2 hours ago · edited 3 days ago")
    expect(presetDetail(live[1]!, "used", now)).toBe("never used · edited last week")
    expect(presetDetail(archived[1]!, "archived", now)).toBe("archived yesterday · edited yesterday")
  })

  it("keeps a chosen archived preset choosable in plain selects, marked", () => {
    expect(selectablePresets(live.slice(0, 1), archived, "ref-Old A").map((item) => item.label)).toEqual([
      "Café noir",
      "Old A (archived)"
    ])
    expect(selectablePresets(live.slice(0, 1), archived, null)).toHaveLength(1)
  })
})

describe("the model list", () => {
  it("finds names, ids and provider prefixes with punctuation-tolerant fuzzy words", () => {
    const model = {
      value: "c1 m1",
      label: "Router · anthropic/claude-3.1",
      name: "Café storyteller",
      modelKey: "anthropic/claude-3.1"
    }
    for (const query of ["cafe", "anth cld31", "anthropic.claude/3-1", "story teller", "CLAUDE 31"])
      expect(matchesModel(model, query), query).toBe(true)
    expect(matchesModel(model, "gemini")).toBe(false)
    // Digits must not be pieced together across repeated id/name fields.
    expect(
      matchesModel(
        {
          value: "c m",
          label: "Router · qwen/story-0008-v3.1",
          name: "Storyteller 0008",
          modelKey: "qwen/story-0008-v3.1"
        },
        "story 0038"
      )
    ).toBe(false)
  })
  it("keeps pins and recent models across connections before the grouped catalog, and filters every section", () => {
    const rows = modelRows(models, "name", "", "", { "c2 m1": true }, used)
    expect(rows.map((row) => ("heading" in row ? row.heading : row.model.value))).toEqual([
      "Pinned",
      "c2 m1",
      "Recent",
      "c1 m3",
      "Local",
      "c1 m2"
    ])
    expect(
      modelRows(models, "name", "small", "c1", { "c2 m1": true }, used).map((row) =>
        "heading" in row ? row.heading : row.model.value
      )
    ).toEqual(["c1 m2"])
  })
  const models = [
    { value: "c2 m1", label: "Zeta · big" },
    { value: "c1 m2", label: "Local · small" },
    { value: "c1 m3", label: "Local · medium" }
  ]
  const used = new Map([
    ["c2 m1", now - day],
    ["c1 m3", now - 60_000 * 30]
  ])
  it("sorts by name or by last use, filtered by the text", () => {
    expect(modelsInOrder("name", "", models, used).map((m) => m.label)).toEqual([
      "Local · medium",
      "Local · small",
      "Zeta · big"
    ])
    expect(modelsInOrder("used", "", models, used).map((m) => m.label)).toEqual([
      "Local · medium",
      "Zeta · big",
      "Local · small"
    ])
    expect(modelsInOrder("used", "local", models, used).map((m) => m.label)).toEqual([
      "Local · medium",
      "Local · small"
    ])
    expect(modelDetail(used.get("c1 m3"), now)).toBe("used 30 minutes ago")
    expect(modelDetail(undefined, now)).toBe("never used")
  })
})

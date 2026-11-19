// The importer registry and format detection (PLUGINS §8, ARCHITECTURE.md §11.2): every
// file goes to the importer its bytes call for, whatever its name says.
import { readFileSync } from "node:fs"
import { assert, describe, it } from "@effect/vitest"
import { ImportReport } from "@dreamspan/shared/importReport.ts"
import { Effect } from "effect"
import { sniff } from "../src/importer/detect.ts"
import * as Importers from "../src/importer/importers.ts"
import { cardChunk, cardV3, json, png, stCardV2, worldInfo, zip } from "./formats/support.ts"
import { presetDoc } from "./support/docs.ts"
import { mainPrompt } from "@dreamspan/shared/presetOrder.ts"
import { cardDoc } from "./support/docs.ts"

const parse = (bytes: Uint8Array, name = "upload.bin") =>
  Importers.parseFile(bytes, name).pipe(Effect.provide(Importers.layer), Effect.runPromise)

const preset = readFileSync(new URL("./fixtures/presets/default.json", import.meta.url))

describe("format detection", () => {
  it("reads a JSON object's top-level keys without parsing it", () => {
    const text = `\uFEFF  {"spec": "x", "data": {"name": {"deep": ["entries", "}"]}}, "a\\"b": [1, {"c": 2}], "z": "]}"}`
    const found = sniff(new TextEncoder().encode(text))
    assert.strictEqual(found.container, "json")
    assert.deepStrictEqual([...found.keys], ["spec", "data", 'a"b', "z"])
    assert.strictEqual(sniff(png()).container, "png")
    assert.strictEqual(sniff(zip([{ name: "card.json", data: json({}) }])).container, "zip")
    assert.strictEqual(sniff(json([1, 2])).container, "unknown")
  })

  it("is linear on deep nesting, with no recursion to overflow", () => {
    const deep = new TextEncoder().encode(`{"a": ${"[".repeat(1_000_000)}`)
    assert.deepStrictEqual([...sniff(deep).keys], ["a"])
  })
})

describe("the built-in importers", () => {
  it("normalizes our own imported preset document before encoding it", () => {
    const parsed = Importers.parsedFile(
      {
        report: new ImportReport({ format: "synthetic-preset", issues: [] }),
        library: { kind: "preset", label: "Older preset", doc: presetDoc([]), schemaVersion: 1, note: null },
        files: []
      },
      "a".repeat(64)
    )
    const stored = JSON.parse(parsed.library!.docJson)
    assert.deepStrictEqual(stored.prompts, [mainPrompt])
    assert.deepStrictEqual(stored.order, [{ identifier: "main", enabled: false }])
  })

  it("picks the importer from the bytes, not the name", async () => {
    const cases: Array<[Uint8Array, string, string | null]> = [
      [png(cardChunk("chara", stCardV2())), "card-v2-png", "card"],
      [json(stCardV2()), "card-v2-json", "card"],
      [json({ name: "Old", description: "A V1 card." }), "card-v1-json", "card"],
      [zip([{ name: "card.json", data: json(cardV3()) }]), "card-v3-charx", "card"],
      [json(worldInfo()), "st-world-info", "lorebook"],
      [preset, "st-chat-completion-preset", "preset"],
      [json({ name: "Alpaca", input_sequence: "", output_sequence: "" }), "st-instruct-template", null],
      [json({ hello: "world" }), "unknown", null],
      [new Uint8Array([1, 2, 3]), "unknown", null]
    ]
    for (const [bytes, format, kind] of cases) {
      // Every file claims to be a card PNG by name.
      const parsed = await parse(bytes, "misleading.png")
      assert.strictEqual(parsed.report.format, format)
      assert.strictEqual(parsed.library?.kind ?? null, kind)
      if (kind === null) assert.isTrue(parsed.report.issues.some((issue) => issue.level !== "info"))
    }
  })

  it("a file an importer can't read is a report with its error, and nothing to store", async () => {
    const parsed = await parse(png(cardChunk("chara", "not base64 json")), "broken.png")
    assert.isNull(parsed.library)
    assert.strictEqual(parsed.report.issues[0]!.level, "error")
    assert.deepStrictEqual(parsed.media, [])
  })

  it("a card's Character's Note leaves the card for a note; its avatar comes with hash and size", async () => {
    const parsed = await parse(png(cardChunk("chara", stCardV2())), "wren.png")
    const card = JSON.parse(parsed.library!.docJson)
    assert.notProperty(card.extensions, "depth_prompt")
    assert.deepStrictEqual(JSON.parse(parsed.library!.noteDocJson!), {
      schema_version: 1,
      title: "Character's Note",
      content: "Wren smells of oil.",
      placement: { mode: "depth", depth: 4, role: "system" },
      exportable: true,
      // ST always sends it (DESIGN §4.1).
      on_by_default: true
    })
    assert.include(
      parsed.report.issues.map((issue) => issue.code),
      "card.character_note"
    )
    assert.strictEqual(parsed.library!.label, "Wren")
    const [avatar] = parsed.media
    assert.deepStrictEqual(
      [avatar!.role, avatar!.mime, avatar!.width, avatar!.height, avatar!.byteSize],
      ["avatar", "image/png", 1, 1, png().byteLength]
    )
    assert.match(parsed.sha256, /^[0-9a-f]{64}$/)

    // An empty note, ST's default, stays in the card as it was.
    const empty = stCardV2()
    empty.data.extensions.depth_prompt.prompt = ""
    const plain = await parse(json(empty))
    assert.isNull(plain.library!.noteDocJson)
    assert.property(JSON.parse(plain.library!.docJson).extensions, "depth_prompt")
  })

  it("labels: a preset by its file name, a lorebook by its name or file, control characters dropped", async () => {
    assert.strictEqual((await parse(preset, "My Preset.json")).library!.label, "My Preset")
    assert.strictEqual((await parse(json(worldInfo()), "harbor.json")).library!.label, "harbor")
    const named = await parse(json({ ...stCardV2(), data: { ...stCardV2().data, name: "Wren\u0000\u001b[31m" } }))
    assert.strictEqual(named.library!.label, "Wren [31m")
  })

  it("a registered importer replaces or hides a built-in for as long as its scope", () =>
    Effect.gen(function* () {
      const registry = yield* Importers.Importers
      const card = png(cardChunk("chara", stCardV2()))
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* registry.register({
            id: "st-world-info",
            detect: (file) => file.keys.has("entries"),
            parse: () =>
              Effect.succeed({
                report: new ImportReport({ format: "my-lorebooks", issues: [] }),
                library: null,
                files: []
              })
          })
          yield* registry.disable("card")
          assert.strictEqual((yield* Importers.parseFile(json(worldInfo()), "x.json")).report.format, "my-lorebooks")
          assert.strictEqual((yield* Importers.parseFile(card, "x.png")).report.format, "unknown")
        })
      )
      assert.strictEqual((yield* Importers.parseFile(json(worldInfo()), "x.json")).report.format, "st-world-info")
      assert.strictEqual((yield* Importers.parseFile(card, "x.png")).report.format, "card-v2-png")
    }).pipe(Effect.provide(Importers.layer), Effect.runPromise))

  it("never passes on a document its kind's schema refuses, whichever importer made it", () =>
    Effect.gen(function* () {
      const registry = yield* Importers.Importers
      yield* registry.register({
        id: "st-world-info",
        detect: (file) => file.keys.has("entries"),
        parse: () =>
          Effect.succeed({
            report: new ImportReport({ format: "my-lorebooks", issues: [] }),
            library: { kind: "lorebook", label: "Broken", doc: { entries: "none" }, schemaVersion: 1, note: null },
            files: []
          })
      })
      const parsed = yield* Importers.parseFile(json(worldInfo()), "x.json")
      assert.isNull(parsed.library)
      assert.deepStrictEqual(
        parsed.report.issues.map((issue) => issue.code),
        ["file.invalid_document"]
      )
    }).pipe(Effect.scoped, Effect.provide(Importers.layer), Effect.runPromise))

  it("never passes on a card note its schema refuses", () =>
    Effect.gen(function* () {
      const registry = yield* Importers.Importers
      yield* registry.disable("st-world-info")
      yield* registry.register({
        id: "card",
        detect: (file) => file.keys.has("entries"),
        parse: () =>
          Effect.succeed({
            report: new ImportReport({ format: "my-cards", issues: [] }),
            library: {
              kind: "card",
              label: "Deep",
              doc: cardDoc("Deep"),
              schemaVersion: 1,
              note: {
                schema_version: 1,
                title: "Note",
                content: "Too deep.",
                placement: { mode: "depth", depth: 10_001, role: "system" },
                exportable: true
              }
            },
            files: []
          })
      })
      const parsed = yield* Importers.parseFile(json(worldInfo()), "x.json")
      assert.isNull(parsed.library)
      assert.deepStrictEqual(
        parsed.report.issues.map((issue) => issue.code),
        ["file.invalid_document"]
      )
    }).pipe(Effect.scoped, Effect.provide(Importers.layer), Effect.runPromise))
})

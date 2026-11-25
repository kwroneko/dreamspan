import sharp from "sharp"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { exportFile } from "../../src/importer/exporters.ts"
import * as Importers from "../../src/importer/importers.ts"
import { importCard } from "../../src/formats/cardImport.ts"
import { json, run, stCardV2 } from "./support.ts"

const card = () => run(importCard(json(stCardV2()))).card

const exportAs = (format: string) =>
  Effect.runPromise(
    exportFile({
      format,
      docJson: JSON.stringify(card()),
      noteDocJson: null,
      notesDocJson: [],
      avatar: null,
      assets: []
    })
  )

const back = async (bytes: Uint8Array, name: string) => {
  const file = await Effect.runPromise(Importers.parseFile(bytes, name).pipe(Effect.provide(Importers.layer)))
  return JSON.parse(file.library!.docJson) as Record<string, unknown>
}

describe("exporting a card with no portrait", () => {
  it("a PNG card carries a generated 400x600 initials tile, the same one every time", async () => {
    const bytes = await exportAs("card-png")
    const meta = await sharp(bytes).metadata()
    expect([meta.format, meta.width, meta.height]).toEqual(["png", 400, 600])
    expect(Buffer.from(await exportAs("card-png")).equals(Buffer.from(bytes))).toBe(true)
  })

  it("a JSON card holds no image and a CHARX no icon asset", async () => {
    const data = JSON.parse(new TextDecoder().decode(await exportAs("card-v3-json")))
    expect(JSON.stringify(data)).not.toContain("base64")
    expect(data.data.assets).toBeUndefined()
    expect((await exportAs("card-charx")).byteLength).toBeGreaterThan(0)
  })

  for (const [format, name] of [
    ["card-v2-json", "c.json"],
    ["card-v3-json", "c.json"],
    ["card-png", "c.png"],
    ["card-charx", "c.charx"]
  ] as const)
    it(`${format} works and imports back to the same card`, async () => {
      const bytes = await exportAs(format)
      expect(bytes.byteLength).toBeGreaterThan(0)
      const again = await back(bytes, name)
      const original = card() as unknown as Record<string, unknown>
      for (const key of ["name", "description", "personality", "scenario", "first_mes", "mes_example", "tags"])
        expect(again[key]).toEqual(original[key])
    })
})

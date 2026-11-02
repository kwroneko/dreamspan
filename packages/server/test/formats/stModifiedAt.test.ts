import { describe, expect, it } from "vitest"
import { importCard } from "../../src/formats/cardImport.ts"
import { sourceTime } from "../../src/formats/sourceTime.ts"
import { cardChunk, cardV3, json, png, run, zip, type ZipFile } from "./support.ts"

const at = Date.UTC(2024, 5, 14, 12, 30, 28)
const source = (modification_date: unknown) => ({ ...cardV3(), data: { ...cardV3().data, modification_date } })

/** Set central-directory dates on a synthetic ZIP, leaving its local dates empty. */
const datedZip = (files: ReadonlyArray<ZipFile>, dates: ReadonlyArray<number>, extended?: number) => {
  let bytes = zip(files)
  let offset = bytes.readUInt32LE(bytes.length - 22 + 16)
  for (const time of dates) {
    const date = new Date(time)
    bytes.writeUInt16LE(
      (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() / 2),
      offset + 12
    )
    bytes.writeUInt16LE(
      ((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
      offset + 14
    )
    offset += 46 + bytes.readUInt16LE(offset + 28)
  }
  if (extended !== undefined) {
    const central = bytes.readUInt32LE(bytes.length - 22 + 16)
    const extraAt = central + 46 + bytes.readUInt16LE(central + 28)
    const extra = Buffer.alloc(9)
    extra.writeUInt16LE(0x5455)
    extra.writeUInt16LE(5, 2)
    extra[4] = 1
    extra.writeUInt32LE(extended / 1000, 5)
    bytes.writeUInt16LE(extra.length, central + 30)
    bytes = Buffer.concat([bytes.subarray(0, extraAt), extra, bytes.subarray(extraAt)])
    const end = bytes.length - 22
    bytes.writeUInt32LE(bytes.readUInt32LE(end + 12) + extra.length, end + 12)
  }
  return bytes
}

describe("ST revision source dates", () => {
  it("uses CCv3 seconds for JSON and PNG, separately from the card's creation date", () => {
    for (const bytes of [json(source(at / 1000)), png(cardChunk("ccv3", source(at / 1000)))]) {
      const imported = run(importCard(bytes))
      expect(imported.stModifiedAt).toBe(at)
      expect(imported.card.creation_date).toBe(cardV3().data.creation_date)
    }
  })

  it.each([undefined, 0, -1, "2024-06-14", 9e99])(
    "ignores missing, private or invalid CCv3 dates: %s",
    (modification_date) => {
      expect(run(importCard(json(source(modification_date)))).stModifiedAt).toBeNull()
    }
  )

  it("takes the latest consumed CHARX entry date, ignoring unused files", () => {
    const card = source(0)
    card.data.assets = [{ type: "icon", uri: "embeded://avatar.png", name: "main", ext: "png" }]
    const archive = datedZip(
      [
        { name: "card.json", data: json(card) },
        { name: "avatar.png", data: png() },
        { name: "unused.txt", data: json({}) }
      ],
      [at, at + 60_000, at + 120_000]
    )
    expect(run(importCard(archive)).stModifiedAt).toBe(at + 60_000)
  })

  it("prefers an embedded modification date over ZIP entry times", () => {
    const archive = datedZip([{ name: "card.json", data: json(source(at / 1000)) }], [at + 60_000])
    expect(run(importCard(archive)).stModifiedAt).toBe(at)
  })

  it("prefers ZIP's UTC extended timestamp over its DOS date", () => {
    const archive = datedZip([{ name: "card.json", data: json(source(0)) }], [at], at + 123_000)
    expect(run(importCard(archive)).stModifiedAt).toBe(at + 123_000)
  })

  it("keeps malformed ZIP dates absent for the outer file/import fallback", () => {
    expect(run(importCard(zip([{ name: "card.json", data: json(source(0)) }]))).stModifiedAt).toBeNull()
  })

  it("validates source file times, retaining zero and truncating fractional milliseconds", () => {
    expect(sourceTime(0)).toBe(0)
    expect(sourceTime(at + 0.75)).toBe(at)
    for (const value of [undefined, null, "", NaN, Infinity, -1, 8.64e15 + 1]) expect(sourceTime(value)).toBeNull()
  })
})

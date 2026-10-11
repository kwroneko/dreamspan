import { describe, expect, it } from "vitest"
import { importCard } from "../../src/formats/cardImport.ts"
import { defaultLimits } from "../../src/formats/safety.ts"
import { cardV3, failure, json, png, run, stCardV2, zip, type ZipFile } from "./support.ts"

const bytes = (text: string) => new TextEncoder().encode(text)

const asset = (type: string, name: string, path: string, ext = "png") => ({ type, name, ext, uri: `embeded://${path}` })

const charxCard = () => {
  const card = cardV3()
  return {
    ...card,
    data: {
      ...card.data,
      assets: [
        asset("icon", "side", "assets/icon/images/side.png"),
        asset("icon", "main", "assets/icon/images/main.png"),
        asset("background", "beach", "assets/background/images/beach.webp", "webp"),
        asset("other", "theme", "assets/other/audio/theme.mp3", "mp3"),
        asset("emotion", "happy", "assets/emotion/images/happy.png"),
        { type: "icon", uri: "ccdefault:", name: "default", ext: "png" }
      ]
    }
  }
}

const charxFiles = (): Array<ZipFile> => [
  { name: "card.json", data: json(charxCard()) },
  { name: "assets/icon/images/main.png", data: png(), method: 0 },
  { name: "assets/icon/images/side.png", data: bytes("side") },
  { name: "assets/background/images/beach.webp", data: bytes("beach") },
  { name: "assets/other/audio/theme.mp3", data: bytes("theme") },
  { name: "x_meta/1.json", data: bytes("{}") }
]

describe("CHARX card import", () => {
  it("reads card.json, the main icon as the avatar, and image assets", () => {
    const result = run(importCard(zip(charxFiles())))
    expect(result.report.format).toBe("card-v3-charx")
    expect(result.card.name).toBe("Moss")
    expect(result.avatar).toEqual({ uri: "embeded://assets/icon/images/main.png", ext: "png", bytes: png() })
    expect(result.assets.map((a) => [a.uri, a.ext, Buffer.from(a.bytes).toString()])).toEqual([
      ["embeded://assets/icon/images/side.png", "png", "side"],
      ["embeded://assets/background/images/beach.webp", "webp", "beach"]
    ])
    expect(result.report.issues.map((issue) => [issue.code, issue.path])).toEqual([
      ["charx.asset_skipped", ["data", "assets", 3]],
      ["charx.missing_asset", ["data", "assets", 4]],
      ["charx.unused_files", undefined]
    ])
  })

  it("finds card.json in a folder, as ST does", () => {
    const result = run(importCard(zip([{ name: "Moss/card.json", data: json(cardV3()) }])))
    expect(result.card.name).toBe("Moss")
    expect(result.avatar).toBeNull()
  })

  it("refuses an archive without a V2 or V3 card", () => {
    expect(failure(importCard(zip([{ name: "other.json", data: json(cardV3()) }])))).toBe("charx.no_card")
    expect(failure(importCard(zip([{ name: "card.json", data: json({ name: "V1" }) }])))).toBe("charx.no_card")
    expect(failure(importCard(zip([{ name: "card.json", data: json(stCardV2()), method: 12 }])))).toBe(
      "zip.unsupported"
    )
  })
})

describe("CHARX hardening", () => {
  const withCard = (...files: Array<ZipFile>) => zip([{ name: "card.json", data: json(cardV3()) }, ...files])

  it("rejects paths that leave the archive's folder", () => {
    for (const name of ["../evil.png", "/etc/evil.png", "a\\..\\evil.png", "C:/evil.png", "a/../../evil.png", "a\0b"]) {
      expect(failure(importCard(withCard({ name, data: bytes("x") }))), name).toBe("zip.unsafe_path")
    }
    run(importCard(withCard({ name: "a/..b/c.png", data: bytes("x") })))
  })

  it("rejects duplicate names and encrypted entries", () => {
    expect(failure(importCard(withCard({ name: "card.json", data: bytes("{}") })))).toBe("zip.duplicate_name")
    expect(failure(importCard(withCard({ name: "secret.png", data: bytes("x"), flags: 1 })))).toBe("zip.encrypted")
  })

  it("rejects more entries than the cap", () => {
    const filler = (count: number) => Array.from({ length: count }, (_, i) => ({ name: `f${i}`, data: bytes("") }))
    run(importCard(withCard(...filler(defaultLimits.maxZipEntries - 1))))
    expect(failure(importCard(withCard(...filler(defaultLimits.maxZipEntries))))).toBe("zip.too_many_entries")
  })

  it("rejects an entry declaring more than the cap, before inflating it", () => {
    const file = zip([{ name: "card.json", data: json(cardV3()), declaredSize: defaultLimits.maxZipEntryBytes + 1 }])
    expect(failure(importCard(file))).toBe("zip.entry_too_large")
  })

  it("rejects entries that compress like a zip bomb", () => {
    const zeros = new Uint8Array(2 * 1024 * 1024)
    const card = { ...cardV3(), data: { ...cardV3().data, assets: [asset("icon", "main", "a.png")] } }
    expect(
      failure(
        importCard(
          zip([
            { name: "card.json", data: json(card) },
            { name: "a.png", data: zeros }
          ])
        )
      )
    ).toBe("zip.ratio")
    // Unreferenced entries are never inflated, so they can't trip it.
    run(importCard(withCard({ name: "a.png", data: zeros })))
  })

  it("stops inflating at the declared size", () => {
    const card = { ...cardV3(), data: { ...cardV3().data, assets: [asset("icon", "main", "a.png")] } }
    const file = zip([
      { name: "card.json", data: json(card) },
      { name: "a.png", data: new Uint8Array(10 * 1024 * 1024), declaredSize: 1000 }
    ])
    expect(failure(importCard(file))).toBe("zip.bomb")
  })

  it("rejects an archive holding more than the total cap", () => {
    const card = { ...cardV3(), data: { ...cardV3().data, assets: [asset("icon", "main", "a.png")] } }
    const file = zip([
      { name: "card.json", data: json(card), method: 0 },
      { name: "a.png", data: new Uint8Array(600), method: 0 }
    ])
    const cardBytes = json(card).byteLength
    run(importCard(file, { ...defaultLimits, maxZipTotalBytes: cardBytes + 600 }))
    expect(failure(importCard(file, { ...defaultLimits, maxZipTotalBytes: cardBytes + 599 }))).toBe(
      "zip.total_too_large"
    )
  })

  it("rejects an entry whose checksum doesn't match", () => {
    const file = Buffer.from(zip([{ name: "card.json", data: json(cardV3()), method: 0 }]))
    file[40] = file[40]! ^ 0xff
    expect(failure(importCard(file))).toBe("zip.bad_entry")
  })
})

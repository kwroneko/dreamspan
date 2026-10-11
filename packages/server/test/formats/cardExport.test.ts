import type { CardDoc } from "@rp/shared/docs/card.ts"
import { describe, expect, it } from "vitest"
import { cardToJson, exportCardCharx, exportCardJson, exportCardPng } from "../../src/formats/cardExport.ts"
import { importCard } from "../../src/formats/cardImport.ts"
import { decodeText, readChunks } from "../../src/formats/png.ts"
import { defaultLimits } from "../../src/formats/safety.ts"
import { cardChunk, cardV3, failure, json, png, run, stCardV2, textChunk } from "./support.ts"

const imported = (value: unknown) => run(importCard(json(value))).card

/** Every key and value of `expected` is in `actual`; `actual` may have more keys. */
const expectSuperset = (actual: unknown, expected: unknown, path = "") => {
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual), path).toBe(true)
    expect((actual as Array<unknown>).length, path).toBe(expected.length)
    expected.forEach((item, index) => expectSuperset((actual as Array<unknown>)[index], item, `${path}[${index}]`))
  } else if (typeof expected === "object" && expected !== null) {
    for (const [key, value] of Object.entries(expected)) {
      expectSuperset((actual as Record<string, unknown>)[key], value, `${path}.${key}`)
    }
  } else {
    expect(actual, path).toEqual(expected)
  }
}

describe("card export", () => {
  it("keeps everything an imported card had, in both versions", () => {
    for (const source of [stCardV2(), cardV3()]) {
      const card = imported(source)
      for (const version of ["v2", "v3"] as const) {
        const exported = cardToJson(card, version)
        expectSuperset(exported.data, source.data)
        expect(imported(exported)).toEqual(card)
      }
    }
    expectSuperset(cardToJson(imported(stCardV2()), "v2"), { some_root_field: 42 })
  })

  it("writes V1 fields at the top level of V2 only", () => {
    const card = imported(stCardV2())
    expect(cardToJson(card, "v2")).toMatchObject({ spec: "chara_card_v2", spec_version: "2.0", name: "Wren" })
    expect(cardToJson(card, "v3")).not.toHaveProperty("name")
    expect(cardToJson(card, "v3")).toMatchObject({ spec: "chara_card_v3", spec_version: "3.0" })
  })

  it("writes ST's World Info fields into each entry's extensions", () => {
    const data = cardToJson(imported(stCardV2()), "v3").data as { character_book?: { entries: Array<unknown> } }
    const entry = data.character_book!.entries[1]
    expect(entry).toMatchObject({
      id: 1,
      position: "after_char",
      use_regex: false,
      extensions: { position: 1, depth: 4, role: 0, selectiveLogic: 0, probability: 100, useProbability: true }
    })
  })

  it("exports exportable modules only, and an import brings them back", () => {
    const card: CardDoc = {
      ...imported(stCardV2()),
      modules: [
        { id: "outfit", title: "Outfit", content: "Oilskin coat.", exportable: true },
        { id: "secret", title: "Secret", content: "Private plans.", exportable: false }
      ]
    }
    const text = new TextDecoder().decode(exportCardJson(card, "v2"))
    expect(text).not.toContain("Private plans.")
    expect(imported(JSON.parse(text)).modules).toEqual([card.modules[0]])
  })

  it("never lets unknown fields override defined ones", () => {
    const card: CardDoc = {
      ...imported(cardV3()),
      unknown_fields: { name: "Impostor", extensions: { evil: true } },
      unknown_root_fields: { spec: "chara_card_v9", data: {} }
    }
    const exported = cardToJson(card, "v3")
    expect(exported.spec).toBe("chara_card_v3")
    expect(exported.data.name).toBe("Moss")
    expect(exported.data.extensions).toEqual({})
  })
})

describe("PNG export", () => {
  const keywords = (bytes: Uint8Array) =>
    readChunks(bytes, defaultLimits).map((c) => (c.type === "tEXt" ? decodeText(c.data).keyword : c.type))

  it("replaces card chunks, writing chara then ccv3 before IEND as ST does", () => {
    const image = png(textChunk("Comment", "kept"), cardChunk("chara", { name: "Old" }), cardChunk("CCV3", {}))
    const card = imported(cardV3())
    const out = run(exportCardPng(card, image))
    expect(keywords(out)).toEqual(["IHDR", "IDAT", "Comment", "chara", "ccv3", "IEND"])
    const reread = run(importCard(out))
    expect(reread.card).toEqual(card)
    expect(reread.report.format).toBe("card-v3-png")
  })

  it("refuses an image that isn't a valid PNG", () => {
    expect(failure(exportCardPng(imported(cardV3()), json({})))).toBe("png.invalid")
  })
})

describe("CHARX export", () => {
  it("writes the avatar as the main icon, and assets that have files", () => {
    const base = imported(cardV3())
    const card: CardDoc = {
      ...base,
      assets: [
        { type: "icon", uri: "ccdefault:", name: "main", ext: "png" },
        { type: "background", uri: "embeded://assets/background/images/sea.png", name: "sea", ext: "png" },
        { type: "emotion", uri: "embeded://assets/emotion/images/sad.png", name: "sad", ext: "png" },
        { type: "other", uri: "https://example.com/x.png", name: "remote", ext: "png" }
      ]
    }
    const sea = { uri: "embeded://assets/background/images/sea.png", ext: "png", bytes: png(textChunk("x", "sea")) }
    const avatar = { uri: "ccdefault:", ext: "png", bytes: png() }
    const result = run(importCard(exportCardCharx(card, { avatar, assets: [sea] })))
    expect(result.report.format).toBe("card-v3-charx")
    expect(Buffer.from(result.avatar!.bytes)).toEqual(png())
    expect(result.assets).toEqual([{ ...sea, bytes: Buffer.from(sea.bytes) }])
    expect(result.card.assets).toEqual([
      { type: "icon", uri: "embeded://assets/icon/images/main.png", name: "main", ext: "png" },
      card.assets![1],
      card.assets![3]
    ])
    expect({ ...result.card, assets: card.assets }).toEqual(card)
  })

  it("never writes an asset outside the archive's folder", () => {
    const uri = "embeded://../../evil.png"
    const card: CardDoc = { ...imported(cardV3()), assets: [{ type: "other", uri, name: "evil", ext: "png" }] }
    const result = run(importCard(exportCardCharx(card, { avatar: null, assets: [{ uri, ext: "png", bytes: png() }] })))
    expect(result.card.assets).toEqual([])
    expect(result.report.issues).toEqual([])
  })
})

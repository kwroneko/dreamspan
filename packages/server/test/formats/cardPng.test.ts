import { describe, expect, it } from "vitest"
import { importCard } from "../../src/formats/cardImport.ts"
import { decodeText, readChunks } from "../../src/formats/png.ts"
import { defaultLimits } from "../../src/formats/safety.ts"
import { cardChunk, cardV3, chunk, failure, png, PNG_SIGNATURE, run, stCardV2, textChunk } from "./support.ts"

const textKeywords = (bytes: Uint8Array) =>
  readChunks(bytes, defaultLimits)
    .filter((c) => c.type === "tEXt")
    .map((c) => decodeText(c.data).keyword)

describe("PNG card import", () => {
  it("reads the chara chunk and returns the image without it", () => {
    const file = png(textChunk("Comment", "drawn by hand"), cardChunk("chara", stCardV2()))
    const result = run(importCard(file))
    expect(result.report.format).toBe("card-v2-png")
    expect(result.card.name).toBe("Wren")
    expect(result.avatar?.ext).toBe("png")
    expect(textKeywords(result.avatar!.bytes)).toEqual(["Comment"])
    expect(Buffer.from(result.avatar!.bytes)).toEqual(png(textChunk("Comment", "drawn by hand")))
  })

  it("prefers ccv3 over chara, as ST does, and strips both", () => {
    const file = png(cardChunk("chara", stCardV2()), cardChunk("ccv3", cardV3()))
    const result = run(importCard(file))
    expect(result.report.format).toBe("card-v3-png")
    expect(result.card.name).toBe("Moss")
    expect(textKeywords(result.avatar!.bytes)).toEqual([])
  })

  it("matches keywords in any case", () => {
    expect(run(importCard(png(cardChunk("CHARA", stCardV2())))).card.name).toBe("Wren")
  })

  it("skips assets embedded as text chunks", () => {
    const file = png(cardChunk("ccv3", cardV3()), textChunk("chara-ext-asset_:a.png", "AAAA"))
    const result = run(importCard(file))
    expect(result.report.issues.map((issue) => issue.code)).toEqual(["png.assets_ignored"])
    expect(textKeywords(result.avatar!.bytes)).toEqual([])
  })

  it("refuses a PNG without a card, or a broken one", () => {
    expect(failure(importCard(png(textChunk("Comment", "x"))))).toBe("png.no_card")
    const good = png(cardChunk("chara", stCardV2()))
    expect(failure(importCard(good.subarray(0, good.byteLength - 12)))).toBe("png.truncated")
    expect(failure(importCard(good.subarray(0, good.byteLength - 20)))).toBe("png.truncated")
    const corrupt = Buffer.from(good)
    corrupt[60] = corrupt[60]! ^ 0xff
    expect(failure(importCard(corrupt))).toBe("png.bad_crc")
  })
})

describe("PNG hardening", () => {
  it("rejects more chunks than the cap", () => {
    const filler = (count: number) => Array.from({ length: count }, () => chunk("faKe"))
    // IHDR, IDAT, the card and IEND are four more.
    run(importCard(png(cardChunk("chara", stCardV2()), ...filler(defaultLimits.maxPngChunks - 4))))
    const file = png(cardChunk("chara", stCardV2()), ...filler(defaultLimits.maxPngChunks - 3))
    expect(failure(importCard(file))).toBe("png.too_many_chunks")
  })

  it("rejects a chunk declaring more than the cap, before reading it", () => {
    const header = Buffer.alloc(12)
    header.writeUInt32BE(defaultLimits.maxPngChunkBytes + 1, 0)
    header.write("tEXt", 4, "latin1")
    expect(failure(importCard(Buffer.concat([PNG_SIGNATURE, header])))).toBe("png.chunk_too_large")
  })
})

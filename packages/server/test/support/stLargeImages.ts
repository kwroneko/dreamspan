// Synthetic, deterministic pixels only. Uncompressed PNGs model large imported avatars
// without padding metadata (which the importer removes) or using any real images.
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { crc32, deflateSync } from "node:zlib"
import { cardChunk } from "../formats/support.ts"
import { writeRealisticStFolder } from "./stRealistic.ts"

const chunk = (type: string, data = Buffer.alloc(0)) => {
  const out = Buffer.alloc(data.length + 12)
  out.writeUInt32BE(data.length)
  out.write(type, 4)
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, data.length + 8)), data.length + 8)
  return out
}

export const largeImagePng = (seed = 1, width = 1024, height = 1024, metadata: ReadonlyArray<Buffer> = []) => {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  const pixels = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = y * (width * 3 + 1) + 1 + x * 3
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      const noise = seed >>> 28
      pixels[offset] = 40 + (x * 120) / width + noise
      pixels[offset + 1] = 60 + (y * 120) / height + noise
      pixels[offset + 2] = 80 + ((x + y) % 90) + noise
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels, { level: 0 })),
    ...metadata,
    chunk("IEND")
  ])
}

/** Includes the realistic chats/personas/groups, plus 150 distinct 3–6 MiB avatars. */
export const writeLargeImageStFolder = (root: string) => {
  const dir = writeRealisticStFolder(root)
  mkdirSync(join(dir, "characters"), { recursive: true })
  for (let index = 0; index < 150; index++) {
    const name = `Synthetic ${String(index + 1).padStart(3, "0")}`
    const doc = {
      spec: "chara_card_v2",
      spec_version: "2.0",
      data: { name, first_mes: "Hello from a synthetic card." }
    }
    writeFileSync(
      join(dir, "characters", `${name}.png`),
      largeImagePng(index + 1, 1024, index % 3 === 0 ? 2048 : 1024, [cardChunk("chara", doc)])
    )
  }
  return dir
}

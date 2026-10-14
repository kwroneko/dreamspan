// A deliberately wide original: colored corners outside the chat's center crop prove
// that the full viewer preserves the original. Synthetic pixels, with no private data.
import { crc32, deflateSync } from "node:zlib"

const chunk = (type: string, data: Buffer) => {
  const out = Buffer.alloc(data.length + 12)
  out.writeUInt32BE(data.length)
  out.write(type, 4)
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, data.length + 8)), data.length + 8)
  return out
}

export const portraitPng = (metadata: ReadonlyArray<Buffer> = [], variant = 0) => {
  const width = 900,
    height = 600
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  const pixels = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const face = ((x - 450) / 140) ** 2 + ((y - 270) / 190) ** 2 < 1
      const eye = y > 225 && y < 247 && (Math.abs(x - 395) < 14 || Math.abs(x - 505) < 14)
      const coat = y > 465 && Math.abs(x - 450) < (y - 430) * 1.6
      const marker = (x < 90 || x > 810) && (y < 90 || y > 510)
      const color = eye
        ? [30, 40, 50]
        : face
          ? [216, 183, 141]
          : coat
            ? [40, 70, 90]
            : marker
              ? [230, 190, 60]
              : [60 + ((variant * 9) % 80), 110 + Math.floor(y / 12), 145 + Math.floor(x / 18)]
      const offset = y * (width * 3 + 1) + 1 + x * 3
      for (let c = 0; c < 3; c++) pixels[offset + c] = color[c]!
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    ...metadata,
    chunk("IEND", Buffer.alloc(0))
  ])
}

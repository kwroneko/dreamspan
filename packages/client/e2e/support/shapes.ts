// Synthetic portrait cards of every shape the viewer must handle: tall (2:3, 9:16), ST's
// 400 × 600, wide, small and huge. Each PNG carries a V2 card in its tEXt chunk, as an ST
// card does, and a face, a border and corner markers so a screenshot shows the whole image.
import { crc32, deflateSync } from "node:zlib"

const chunk = (type: string, data: Buffer) => {
  const out = Buffer.alloc(data.length + 12)
  out.writeUInt32BE(data.length)
  out.write(type, 4)
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, data.length + 8)), data.length + 8)
  return out
}

export interface Shape {
  readonly name: string
  readonly width: number
  readonly height: number
}

export const SHAPES: ReadonlyArray<Shape> = [
  { name: "Tall", width: 1024, height: 1536 },
  // ST's own avatar size: the shape most imported cards have.
  { name: "Standard", width: 400, height: 600 },
  { name: "Phone", width: 720, height: 1280 },
  { name: "Wide", width: 1600, height: 900 },
  { name: "Small", width: 160, height: 240 },
  { name: "Huge", width: 2667, height: 4000 }
]

export const shapeCard = ({ name, width, height }: Shape, hue: number) => {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  const row = width * 3 + 1
  const pixels = Buffer.alloc(row * height)
  const cx = width / 2,
    cy = height * 0.35,
    r = Math.min(width, height) * 0.22
  const border = Math.max(2, Math.round(Math.min(width, height) / 60))
  const mark = Math.round(Math.min(width, height) / 8)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const edge = x < border || y < border || x >= width - border || y >= height - border
      const corner = (x < mark || x >= width - mark) && (y < mark || y >= height - mark)
      const face = ((x - cx) / r) ** 2 + ((y - cy) / (r * 1.25)) ** 2 < 1
      const body = y > cy + r * 1.4 && Math.abs(x - cx) < (y - cy - r * 1.1) * 0.9
      const color = edge
        ? [240, 240, 240]
        : corner
          ? [230, 190, 60]
          : face
            ? [216, 183, 141]
            : body
              ? [40 + hue, 70, 110]
              : [50 + ((hue * 3) % 90), 90 + Math.floor((y / height) * 90), 130 + Math.floor((x / width) * 90)]
      const offset = y * row + 1 + x * 3
      pixels[offset] = color[0]!
      pixels[offset + 1] = color[1]!
      pixels[offset + 2] = color[2]!
    }
  }
  const card = Buffer.from(
    JSON.stringify({
      spec: "chara_card_v2",
      spec_version: "2.0",
      data: { name, first_mes: `${name} looks up. (${width} × ${height})`, description: `${name}, a test portrait.` }
    })
  ).toString("base64")
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("tEXt", Buffer.from(`chara\0${card}`, "latin1")),
    chunk("IDAT", deflateSync(pixels, { level: 1 })),
    chunk("IEND", Buffer.alloc(0))
  ])
}

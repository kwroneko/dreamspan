// PNG chunks: enough to find a card's text chunks and to write new ones. A card PNG carries
// its card as base64 JSON in `tEXt` chunks: `chara` (V2) and `ccv3` (V3).
import { crc32 } from "node:zlib"
import { fail, type Limits } from "./safety.ts"

const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)

export interface Chunk {
  readonly type: string
  readonly data: Uint8Array
  /** The whole chunk as it was in the file: length, type, data and CRC. */
  readonly raw: Uint8Array
}

export const isPng = (bytes: Uint8Array) =>
  bytes.byteLength >= SIGNATURE.byteLength && SIGNATURE.every((byte, index) => bytes[index] === byte)

/** Every chunk up to IEND. Lengths are checked before anything is read, and every CRC is checked. */
export const readChunks = (bytes: Uint8Array, limits: Limits): Array<Chunk> => {
  if (!isPng(bytes)) fail("png.invalid", "The file isn't a PNG.")
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const chunks: Array<Chunk> = []
  let offset = SIGNATURE.byteLength
  for (;;) {
    if (chunks.length >= limits.maxPngChunks) {
      fail("png.too_many_chunks", `The PNG has more than ${limits.maxPngChunks} chunks.`)
    }
    if (offset + 12 > bytes.byteLength) fail("png.truncated", "The PNG ends before its IEND chunk.")
    const length = view.getUint32(offset)
    if (length > limits.maxPngChunkBytes) {
      fail("png.chunk_too_large", `A PNG chunk is larger than ${limits.maxPngChunkBytes} bytes.`)
    }
    const end = offset + 12 + length
    if (end > bytes.byteLength) fail("png.truncated", "A PNG chunk runs past the end of the file.")
    const typeAndData = bytes.subarray(offset + 4, offset + 8 + length)
    if (crc32(typeAndData) !== view.getUint32(offset + 8 + length)) {
      fail("png.bad_crc", "A PNG chunk is corrupt (its CRC doesn't match).")
    }
    const type = String.fromCharCode(...typeAndData.subarray(0, 4))
    chunks.push({ type, data: typeAndData.subarray(4), raw: bytes.subarray(offset, end) })
    offset = end
    if (type === "IEND") return chunks
  }
}

/** A `tEXt` chunk's keyword and text, both Latin-1. */
export const decodeText = (data: Uint8Array) => {
  const nul = data.indexOf(0)
  const latin1 = (part: Uint8Array) => Buffer.from(part).toString("latin1")
  return nul === -1
    ? { keyword: latin1(data), text: "" }
    : { keyword: latin1(data.subarray(0, nul)), text: latin1(data.subarray(nul + 1)) }
}

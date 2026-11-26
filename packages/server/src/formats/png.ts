// PNG chunks: enough to find a card's text chunks and to write new ones. A card PNG carries
// its card as base64 JSON in `tEXt` chunks: `chara` (V2) and `ccv3` (V3).
import { formatByteSize } from "@dreamspan/shared/byteSize.ts"
import { crc32 } from "node:zlib"
import { fail, type Limits } from "./safety.ts"

const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)

interface Chunk {
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
      fail("png.chunk_too_large", `A PNG chunk is larger than ${formatByteSize(limits.maxPngChunkBytes)}.`)
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

const latin1 = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1")

/** A `tEXt` chunk's Latin-1 keyword and a view of its text, without copying the payload. */
export const splitText = (data: Uint8Array) => {
  const nul = data.indexOf(0)
  return nul === -1
    ? { keyword: latin1(data), payload: data.subarray(data.byteLength) }
    : { keyword: latin1(data.subarray(0, nul)), payload: data.subarray(nul + 1) }
}

/** A `tEXt` chunk's keyword and text, both Latin-1. */
export const decodeText = (data: Uint8Array) => {
  const { keyword, payload } = splitText(data)
  return { keyword, text: latin1(payload) }
}

/** Bound the encoded payload before converting it to a string or allocating decoded bytes. */
export const decodeCardText = (payload: Uint8Array, limits: Limits) => {
  const maxEncodedBytes = 4 * Math.ceil(limits.maxCardJsonBytes / 3)
  if (payload.byteLength > maxEncodedBytes)
    fail("png.card_too_large", `The encoded card is larger than ${formatByteSize(maxEncodedBytes)}.`)
  // The last quartet can still decode to a byte or two over the limit. parseJson checks the result.
  return Buffer.from(latin1(payload), "base64")
}

export const ASSET_KEYWORD = "chara-ext-asset_"

/** A card's own text chunks: the card in either version, and V3's embedded assets. */
const isCardChunk = (chunk: Chunk) => {
  if (chunk.type !== "tEXt") return false
  const keyword = splitText(chunk.data).keyword
  return ["ccv3", "chara"].includes(keyword.toLowerCase()) || keyword.startsWith(ASSET_KEYWORD)
}

/** The PNG without its card chunks, with `added` chunks before IEND (the last of `chunks`). */
export const replaceCardChunks = (chunks: ReadonlyArray<Chunk>, added: ReadonlyArray<Uint8Array> = []) => {
  const kept = chunks.filter((chunk) => !isCardChunk(chunk)).map((chunk) => chunk.raw)
  return Buffer.concat([SIGNATURE, ...kept.slice(0, -1), ...added, ...kept.slice(-1)])
}

/** A `tEXt` chunk holding `json` as base64 UTF-8, the way ST writes a card. */
export const cardTextChunk = (keyword: string, json: string) => {
  const data = Buffer.from(`${keyword}\0${Buffer.from(json, "utf8").toString("base64")}`, "latin1")
  const out = Buffer.alloc(12 + data.byteLength)
  out.writeUInt32BE(data.byteLength, 0)
  out.write("tEXt", 4, "latin1")
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.byteLength)), 8 + data.byteLength)
  return out
}

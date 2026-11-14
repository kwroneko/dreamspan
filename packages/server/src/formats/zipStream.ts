// A zip written as it goes, for exports too large to hold (chat exports, the library archive):
// each file is deflated while its bytes arrive, its checksum and sizes follow it in a data
// descriptor, and only the central directory (a few dozen bytes a file) is kept until the end.
// Past 4 GiB of archive, the directory and end record take their zip64 forms; entries use ZIP64 local headers and 64-bit data descriptors. Names are UTF-8; dates are left at 1980-01-01, like zip.ts's.
import { once } from "node:events"
import { constants, crc32, createDeflateRaw } from "node:zlib"

const LOCAL = 0x04034b50
const DESCRIPTOR = 0x08074b50
const CENTRAL = 0x02014b50
const EOCD = 0x06054b50
const EOCD64 = 0x06064b50
const LOCATOR64 = 0x07064b50
const MAX32 = 0xffffffff
/** Data descriptor follows (bit 3); names are UTF-8 (bit 11). */
const FLAGS = 0x0808
const DOS_DATE = 0x21

export interface ZipStreamEntry {
  readonly name: string
  readonly chunks: AsyncIterable<Uint8Array>
}

/** The archive's bytes, file after file, then its directory. */
export async function* zipStream(entries: AsyncIterable<ZipStreamEntry>): AsyncGenerator<Uint8Array> {
  const directory: Array<Buffer> = []
  let offset = 0
  let count = 0
  let largeEntry = false
  for await (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8")
    const local = Buffer.alloc(30)
    local.writeUInt32LE(LOCAL, 0)
    local.writeUInt16LE(45, 4)
    local.writeUInt16LE(FLAGS, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt16LE(name.byteLength, 26)
    local.writeUInt32LE(MAX32, 18)
    local.writeUInt32LE(MAX32, 22)
    local.writeUInt16LE(20, 28)
    const localExtra = Buffer.alloc(20)
    localExtra.writeUInt16LE(1, 0)
    localExtra.writeUInt16LE(16, 2)
    const start = offset
    yield local
    yield name
    yield localExtra
    offset += 50 + name.byteLength

    const deflate = createDeflateRaw({ level: constants.Z_BEST_SPEED })
    const out: Array<Buffer> = []
    deflate.on("data", (chunk: Buffer) => out.push(chunk))
    let crc = 0
    let size = 0
    let compressed = 0
    const take = function* () {
      while (out.length > 0) {
        const chunk = out.shift()!
        compressed += chunk.byteLength
        yield chunk
      }
    }
    try {
      for await (const chunk of entry.chunks) {
        crc = crc32(chunk, crc)
        size += chunk.byteLength
        // Bound the deflater's output queue even if a caller supplies a huge chunk.
        for (let at = 0; at < chunk.byteLength; at += 64 * 1024) {
          if (!deflate.write(chunk.subarray(at, at + 64 * 1024))) await once(deflate, "drain")
          yield* take()
        }
      }
      const ended = once(deflate, "end")
      deflate.end()
      await ended
      yield* take()
    } finally {
      deflate.destroy()
    }
    offset += compressed

    const descriptor = Buffer.alloc(24)
    descriptor.writeUInt32LE(DESCRIPTOR, 0)
    descriptor.writeUInt32LE(crc, 4)
    descriptor.writeBigUInt64LE(BigInt(compressed), 8)
    descriptor.writeBigUInt64LE(BigInt(size), 16)
    yield descriptor
    offset += 24

    const far = start >= MAX32
    const big = size >= MAX32 || compressed >= MAX32
    largeEntry ||= big
    const extraLength = (big ? 16 : 0) + (far ? 8 : 0)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(CENTRAL, 0)
    central.writeUInt16LE(45, 4)
    central.writeUInt16LE(45, 6)
    central.writeUInt16LE(FLAGS, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt16LE(DOS_DATE, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(big ? MAX32 : compressed, 20)
    central.writeUInt32LE(big ? MAX32 : size, 24)
    central.writeUInt16LE(name.byteLength, 28)
    central.writeUInt16LE(extraLength ? extraLength + 4 : 0, 30)
    central.writeUInt32LE(far ? MAX32 : start, 42)
    directory.push(central, name)
    if (extraLength) {
      const extra = Buffer.alloc(extraLength + 4)
      extra.writeUInt16LE(0x0001, 0)
      extra.writeUInt16LE(extraLength, 2)
      if (big) {
        extra.writeBigUInt64LE(BigInt(size), 4)
        extra.writeBigUInt64LE(BigInt(compressed), 12)
      }
      if (far) extra.writeBigUInt64LE(BigInt(start), big ? 20 : 4)
      directory.push(extra)
    }
    count++
  }

  const directoryStart = offset
  let directorySize = 0
  for (const part of directory) {
    directorySize += part.byteLength
    yield part
  }
  const zip64 = largeEntry || count >= 0xffff || directoryStart >= MAX32 || directoryStart + directorySize >= MAX32
  if (zip64) {
    const record = Buffer.alloc(56)
    record.writeUInt32LE(EOCD64, 0)
    record.writeBigUInt64LE(44n, 4)
    record.writeUInt16LE(45, 12)
    record.writeUInt16LE(45, 14)
    record.writeBigUInt64LE(BigInt(count), 24)
    record.writeBigUInt64LE(BigInt(count), 32)
    record.writeBigUInt64LE(BigInt(directorySize), 40)
    record.writeBigUInt64LE(BigInt(directoryStart), 48)
    const locator = Buffer.alloc(20)
    locator.writeUInt32LE(LOCATOR64, 0)
    locator.writeBigUInt64LE(BigInt(directoryStart + directorySize), 8)
    locator.writeUInt32LE(1, 16)
    yield record
    yield locator
  }
  const end = Buffer.alloc(22)
  end.writeUInt32LE(EOCD, 0)
  end.writeUInt16LE(zip64 ? 0xffff : count, 8)
  end.writeUInt16LE(zip64 ? 0xffff : count, 10)
  end.writeUInt32LE(zip64 ? MAX32 : directorySize, 12)
  end.writeUInt32LE(zip64 ? MAX32 : directoryStart, 16)
  yield end
}

/** Text as UTF-8 chunks of about `size` bytes, for a zip entry or a response body. */
export async function* textChunks(lines: AsyncIterable<string>, size = 256 * 1024): AsyncGenerator<Uint8Array> {
  let pending: Array<string> = []
  let length = 0
  for await (const line of lines) {
    pending.push(line)
    length += line.length
    if (length >= size) {
      yield Buffer.from(pending.join(""), "utf8")
      pending = []
      length = 0
    }
  }
  if (pending.length > 0) yield Buffer.from(pending.join(""), "utf8")
}

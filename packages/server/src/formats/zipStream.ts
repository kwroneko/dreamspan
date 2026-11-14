// A zip written as it goes, for exports too large to hold (chat exports, the library archive):
// each file is deflated while its bytes arrive, its checksum and sizes follow it in a data
// descriptor, and only the central directory (a few dozen bytes a file) is kept until the end.
// Past 4 GiB of archive, the directory and end record take their zip64 forms; a single file
// must stay under 4 GiB. Names are UTF-8; dates are left at 1980-01-01, like zip.ts's.
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

class ZipEntryTooLarge extends Error {
  readonly entry: string
  constructor(entry: string) {
    super(`${entry} is larger than a zip file can hold (4 GiB).`)
    this.entry = entry
  }
}

export interface ZipStreamEntry {
  readonly name: string
  readonly chunks: AsyncIterable<Uint8Array>
}

/** The archive's bytes, file after file, then its directory. */
export async function* zipStream(entries: AsyncIterable<ZipStreamEntry>): AsyncGenerator<Uint8Array> {
  const directory: Array<Buffer> = []
  let offset = 0
  let count = 0
  for await (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8")
    const local = Buffer.alloc(30)
    local.writeUInt32LE(LOCAL, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(FLAGS, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt16LE(name.byteLength, 26)
    const start = offset
    yield local
    yield name
    offset += 30 + name.byteLength

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
        if (size > MAX32) throw new ZipEntryTooLarge(entry.name)
        if (!deflate.write(chunk)) await once(deflate, "drain")
        yield* take()
      }
      const ended = once(deflate, "end")
      deflate.end()
      await ended
      yield* take()
    } finally {
      deflate.destroy()
    }
    if (compressed > MAX32) throw new ZipEntryTooLarge(entry.name)
    offset += compressed

    const descriptor = Buffer.alloc(16)
    descriptor.writeUInt32LE(DESCRIPTOR, 0)
    descriptor.writeUInt32LE(crc, 4)
    descriptor.writeUInt32LE(compressed, 8)
    descriptor.writeUInt32LE(size, 12)
    yield descriptor
    offset += 16

    const far = start >= MAX32
    const central = Buffer.alloc(46)
    central.writeUInt32LE(CENTRAL, 0)
    central.writeUInt16LE(far ? 45 : 20, 4)
    central.writeUInt16LE(far ? 45 : 20, 6)
    central.writeUInt16LE(FLAGS, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt16LE(DOS_DATE, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressed, 20)
    central.writeUInt32LE(size, 24)
    central.writeUInt16LE(name.byteLength, 28)
    central.writeUInt16LE(far ? 12 : 0, 30)
    central.writeUInt32LE(far ? MAX32 : start, 42)
    directory.push(central, name)
    if (far) {
      const extra = Buffer.alloc(12)
      extra.writeUInt16LE(0x0001, 0)
      extra.writeUInt16LE(8, 2)
      extra.writeBigUInt64LE(BigInt(start), 4)
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
  const zip64 = count >= 0xffff || directoryStart >= MAX32 || directoryStart + directorySize >= MAX32
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

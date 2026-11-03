// A small zip reader for CHARX files: the central directory, and stored or deflated entries.
// Every size is checked against a cap before anything is inflated, and inflating stops at
// the size the archive declares, so a lying header can't make it allocate more.
import { formatByteSize } from "@rp/shared/byteSize.ts"
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib"
import { shownText } from "@rp/shared/importReport.ts"
import { fail, type Limits } from "./safety.ts"

interface ZipEntry {
  readonly name: string
  readonly modifiedAt: number | null
  readonly method: number
  readonly crc: number
  readonly compressedSize: number
  readonly size: number
  readonly localOffset: number
}

export const isZip = (bytes: Uint8Array) =>
  bytes.byteLength >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04

const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50

/**
 * A path that stays inside the archive's root: relative, forward slashes only, no `..`
 * segments, no drive letters, no NUL. Anything else rejects the archive, since an importer
 * that later writes files by these names must never be pointed outside its directory.
 */
export const isSafePath = (name: string) =>
  name !== "" &&
  !name.startsWith("/") &&
  !name.includes("\\") &&
  !name.includes("\0") &&
  !/^[a-zA-Z]:/.test(name) &&
  !name.split("/").some((segment) => segment === "..")

/** ZIP's UTC extended timestamp wins over its timezone-less DOS date (read as UTC). */
const modificationTime = (view: DataView, offset: number, extraStart: number, extraEnd: number) => {
  for (let at = extraStart; at + 4 <= extraEnd;) {
    const tag = view.getUint16(at, true)
    const length = view.getUint16(at + 2, true)
    const end = at + 4 + length
    if (end > extraEnd) break
    if (tag === 0x5455 && length >= 5 && view.getUint8(at + 4) & 1) return view.getUint32(at + 5, true) * 1000
    at = end
  }
  const time = view.getUint16(offset + 12, true)
  const date = view.getUint16(offset + 14, true)
  const year = 1980 + (date >> 9),
    month = (date >> 5) & 15,
    day = date & 31
  const hour = time >> 11,
    minute = (time >> 5) & 63,
    second = (time & 31) * 2
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null
  const parsed = new Date(Date.UTC(year, month - 1, day, hour, minute, second))
  return parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day ? parsed.getTime() : null
}

/** The archive's files by name (directories left out), from its central directory. */
export const readZip = (bytes: Uint8Array, limits: Limits): Map<string, ZipEntry> => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // The end record sits in the last 22 bytes plus a comment of up to 65,535.
  let eocd = -1
  for (let at = bytes.byteLength - 22; at >= Math.max(0, bytes.byteLength - 22 - 0xffff); at--) {
    if (view.getUint32(at, true) === EOCD) {
      eocd = at
      break
    }
  }
  if (eocd === -1) return fail("zip.invalid", "The archive is damaged: it has no central directory.")
  const count = view.getUint16(eocd + 10, true)
  const directoryOffset = view.getUint32(eocd + 16, true)
  if (view.getUint16(eocd + 4, true) !== 0 || count === 0xffff || directoryOffset === 0xffffffff) {
    fail("zip.unsupported", "Multi-part and zip64 archives aren't supported.")
  }
  if (count > limits.maxZipEntries) {
    fail("zip.too_many_entries", `The archive has more than ${limits.maxZipEntries} files.`)
  }

  const entries = new Map<string, ZipEntry>()
  let offset = directoryOffset
  for (let index = 0; index < count; index++) {
    if (offset + 46 > eocd || view.getUint32(offset, true) !== CENTRAL) {
      fail("zip.invalid", "The archive's directory is damaged.")
    }
    const nameLength = view.getUint16(offset + 28, true)
    const next = offset + 46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true)
    if (next > eocd) fail("zip.invalid", "The archive's directory is damaged.")
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength))
    if (!isSafePath(name))
      fail("zip.unsafe_path", `The archive has a file outside its folder: ${JSON.stringify(shownText(name))}.`)
    if (view.getUint16(offset + 8, true) & 1) fail("zip.encrypted", "Encrypted archives aren't supported.")
    if (entries.has(name))
      fail("zip.duplicate_name", `The archive has two files named ${JSON.stringify(shownText(name))}.`)
    if (!name.endsWith("/")) {
      entries.set(name, {
        name,
        modifiedAt: modificationTime(
          view,
          offset,
          offset + 46 + nameLength,
          offset + 46 + nameLength + view.getUint16(offset + 30, true)
        ),
        method: view.getUint16(offset + 10, true),
        crc: view.getUint32(offset + 16, true),
        compressedSize: view.getUint32(offset + 20, true),
        size: view.getUint32(offset + 24, true),
        localOffset: view.getUint32(offset + 42, true)
      })
    }
    offset = next
  }
  return entries
}

/** Uncompressed bytes extracted so far from one archive, for the total cap. */
interface Budget {
  used: number
}

export const extract = (bytes: Uint8Array, entry: ZipEntry, limits: Limits, budget: Budget): Uint8Array => {
  const quoted = JSON.stringify(shownText(entry.name))
  if (entry.size > limits.maxZipEntryBytes) {
    fail("zip.entry_too_large", `${quoted} is larger than ${formatByteSize(limits.maxZipEntryBytes)} uncompressed.`)
  }
  if (budget.used + entry.size > limits.maxZipTotalBytes) {
    fail("zip.total_too_large", `The archive holds more than ${formatByteSize(limits.maxZipTotalBytes)} uncompressed.`)
  }
  if (entry.size > limits.ratioFloorBytes && entry.size > entry.compressedSize * limits.maxCompressionRatio) {
    fail("zip.ratio", `${quoted} compresses suspiciously well, as a zip bomb would.`)
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const local = entry.localOffset
  if (local + 30 > bytes.byteLength || view.getUint32(local, true) !== LOCAL) {
    fail("zip.invalid", `The archive is damaged at ${quoted}.`)
  }
  const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
  const end = start + entry.compressedSize
  if (end > bytes.byteLength) fail("zip.invalid", `The archive is damaged at ${quoted}.`)
  const data = bytes.subarray(start, end)
  let out: Uint8Array
  if (entry.method === 0) {
    out = data
  } else if (entry.method === 8) {
    try {
      // Stops with an error once the output passes the declared size.
      out = inflateRawSync(data, { maxOutputLength: Math.max(1, entry.size) })
    } catch (error) {
      return (error as { code?: unknown }).code === "ERR_BUFFER_TOO_LARGE"
        ? fail("zip.bomb", `${quoted} inflates to more than the archive says.`)
        : fail("zip.bad_entry", `${quoted} can't be decompressed.`)
    }
  } else {
    return fail("zip.unsupported", `${quoted} uses a compression method that isn't supported.`)
  }
  if (out.byteLength !== entry.size || crc32(out) !== entry.crc) {
    fail("zip.bad_entry", `${quoted} doesn't match its size or checksum.`)
  }
  budget.used += entry.size
  return out
}

/** A zip of `files`, deflating those marked; names are UTF-8. Dates are left at 1980-01-01. */
export const writeZip = (files: ReadonlyArray<{ name: string; data: Uint8Array; deflate: boolean }>) => {
  const parts: Array<Uint8Array> = []
  const directory: Array<Uint8Array> = []
  let offset = 0
  for (const file of files) {
    const data = file.deflate ? deflateRawSync(file.data) : file.data
    const name = Buffer.from(file.name, "utf8")
    // The fields local and central headers share, from "version needed" to the name length.
    const shared = Buffer.alloc(26)
    shared.writeUInt16LE(20, 0)
    shared.writeUInt16LE(0x0800, 2)
    shared.writeUInt16LE(file.deflate ? 8 : 0, 4)
    shared.writeUInt16LE(0x21, 8)
    shared.writeUInt32LE(crc32(file.data), 10)
    shared.writeUInt32LE(data.byteLength, 14)
    shared.writeUInt32LE(file.data.byteLength, 18)
    shared.writeUInt16LE(name.byteLength, 22)
    const local = Buffer.alloc(4)
    local.writeUInt32LE(LOCAL, 0)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(CENTRAL, 0)
    central.writeUInt16LE(20, 4)
    shared.copy(central, 6)
    central.writeUInt32LE(offset, 42)
    parts.push(local, shared, name, data)
    directory.push(central, name)
    offset += 30 + name.byteLength + data.byteLength
  }
  const size = directory.reduce((sum, part) => sum + part.byteLength, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(EOCD, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(size, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, ...directory, end])
}

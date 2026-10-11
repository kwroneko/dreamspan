// What kind of file an upload is, from its bytes (PLUGINS §8): the container by its magic
// bytes, and for JSON the keys at the top level, read without parsing the file. Importers
// decide from this which of them reads it; the file name is never consulted.
import { isPng } from "../formats/png.ts"
import { isZip } from "../formats/zip.ts"

export interface Sniffed {
  readonly container: "png" | "zip" | "json" | "unknown"
  /** A JSON object's top-level keys; empty for anything else. */
  readonly keys: ReadonlySet<string>
}

const QUOTE = 0x22
const BACKSLASH = 0x5c
const SPACE = new Set([0x20, 0x09, 0x0a, 0x0d])
/** Keys longer than this aren't any format's markers, so they aren't read. */
const MAX_KEY_BYTES = 256
/** Enough for every marker; a file with more top-level keys has them early or not at all. */
const MAX_KEYS = 4096

const decoder = new TextDecoder()

/**
 * The top-level keys of a JSON object, or undefined if the bytes don't start one. One pass,
 * no recursion: strings are skipped by their quotes and nesting is a counter, so a hostile
 * file costs a linear scan. Malformed JSON gives some keys; the parser rejects it later.
 */
const topLevelKeys = (bytes: Uint8Array): Set<string> | undefined => {
  let i = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0
  while (i < bytes.length && SPACE.has(bytes[i]!)) i++
  if (bytes[i] !== 0x7b) return undefined
  const keys = new Set<string>()
  let depth = 0
  let expectKey = false
  for (; i < bytes.length; i++) {
    const byte = bytes[i]!
    if (byte === QUOTE) {
      const start = i++
      while (i < bytes.length && bytes[i] !== QUOTE) i += bytes[i] === BACKSLASH ? 2 : 1
      if (depth === 1 && expectKey) {
        expectKey = false
        if (i - start <= MAX_KEY_BYTES && keys.size < MAX_KEYS) {
          try {
            keys.add(JSON.parse(decoder.decode(bytes.subarray(start, i + 1))) as string)
          } catch {
            // Not a valid string; the parser will say so.
          }
        }
      }
    } else if (byte === 0x7b || byte === 0x5b) {
      depth++
      expectKey = depth === 1
    } else if (byte === 0x7d || byte === 0x5d) {
      if (--depth === 0) break
    } else if (byte === 0x2c && depth === 1) {
      expectKey = true
    }
  }
  return keys
}

export const sniff = (bytes: Uint8Array): Sniffed => {
  if (isPng(bytes)) return { container: "png", keys: new Set() }
  if (isZip(bytes)) return { container: "zip", keys: new Set() }
  const keys = topLevelKeys(bytes)
  return keys ? { container: "json", keys } : { container: "unknown", keys: new Set() }
}

// What every format parser shares: its error, the caps on untrusted input, and JSON parsing
// that can't hand a prototype key, unbounded nesting or millions of objects to the code after
// it. Imported files are data only: nothing in them is ever executed or rendered.
import type { ReportBuilder } from "@rp/shared/importReport.ts"
import { MAX_IMPORT_BYTES } from "@rp/shared/libraryImport.ts"
import { Effect, Schema } from "effect"

/** A file that can't be imported at all. Recoverable problems are issues in the report instead. */
export class FormatError extends Schema.TaggedError<FormatError>()("FormatError", {
  /** A stable machine code, e.g. `png.chunk_too_large`. */
  code: Schema.String,
  message: Schema.String
}) {}

export interface Limits {
  /** Any imported file. */
  readonly maxFileBytes: number
  /** A card's JSON: a JSON file, a PNG's card chunk once decoded, or a CHARX's card.json. */
  readonly maxCardJsonBytes: number
  /** A World Info file. */
  readonly maxLorebookJsonBytes: number
  readonly maxJsonDepth: number
  /** Objects and lists in one JSON document, counted before it's parsed. */
  readonly maxJsonContainers: number
  /** Values and keys in one JSON document, counted the same way. */
  readonly maxJsonValues: number
  /** Prototype keys dropped before a file counts as hostile and is refused. */
  readonly maxForbiddenKeys: number
  readonly maxLorebookEntries: number
  readonly maxPngChunks: number
  readonly maxPngChunkBytes: number
  readonly maxZipEntries: number
  /** Uncompressed, per extracted entry and for all of them together. */
  readonly maxZipEntryBytes: number
  readonly maxZipTotalBytes: number
  /** Uncompressed to compressed size, checked for entries above `ratioFloorBytes`. */
  readonly maxCompressionRatio: number
  readonly ratioFloorBytes: number
}

const MiB = 1024 * 1024

export const defaultLimits: Limits = {
  maxFileBytes: MAX_IMPORT_BYTES,
  // About 2M tokens of text, more than any model's context holds: a bigger card couldn't be used.
  maxCardJsonBytes: 8 * MiB,
  // Lorebooks are scanned, not sent whole, so they can outgrow a context: the entry cap's
  // worth of entries with 2 KB of content each fit.
  maxLorebookJsonBytes: 32 * MiB,
  maxJsonDepth: 64,
  // A full lorebook has about 60,000: entries, key lists, extensions.
  maxJsonContainers: 250_000,
  // ST writes about fifty fields per entry, about 110 values and keys: 1.1M for a full
  // lorebook. Parsing costs about 1 µs a value or key, so this bounds the work.
  maxJsonValues: 1_200_000,
  maxForbiddenKeys: 100,
  // An assumption to revisit with real files: a lorebook of a few thousand entries is
  // already exceptional, and 20,000 full ST entries would take 2 s to parse on our host.
  maxLorebookEntries: 10_000,
  maxPngChunks: 16_384,
  maxPngChunkBytes: 32 * MiB,
  maxZipEntries: 1024,
  maxZipEntryBytes: 64 * MiB,
  maxZipTotalBytes: 128 * MiB,
  maxCompressionRatio: 100,
  ratioFloorBytes: MiB
}

export const fail = (code: string, message: string): never => {
  throw new FormatError({ code, message })
}

/** Runs a parser written as plain code that throws `FormatError`; anything else is a defect. */
export const attempt = <A>(parse: () => A): Effect.Effect<A, FormatError> =>
  Effect.suspend(() => {
    try {
      return Effect.succeed(parse())
    } catch (error) {
      return error instanceof FormatError ? Effect.fail(error) : Effect.die(error)
    }
  })

export type Path = ReadonlyArray<string | number>

/**
 * Counts nesting, containers and values in the raw bytes, so a document that would cost too
 * much to parse is refused before `JSON.parse` builds it. Every value and key but the first
 * in a container follows a comma or colon, so those count them (one short per container, as
 * the containers count themselves). Invalid JSON is left to the parser.
 */
const scanJson = (bytes: Uint8Array, limits: Limits) => {
  let depth = 0
  let containers = 0
  let values = 0
  let inString = false
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i]
    if (inString) {
      if (byte === 0x5c) i++
      else if (byte === 0x22) inString = false
    } else if (byte === 0x22) {
      inString = true
    } else if (byte === 0x7b || byte === 0x5b) {
      if (++depth > limits.maxJsonDepth) {
        fail("json.too_deep", `The JSON is nested more than ${limits.maxJsonDepth} levels deep.`)
      }
      if (++containers > limits.maxJsonContainers) {
        fail("json.too_many_containers", `The JSON has more than ${limits.maxJsonContainers} objects and lists.`)
      }
    } else if (byte === 0x2c || byte === 0x3a) {
      if (++values > limits.maxJsonValues) {
        fail("json.too_many_values", `The JSON has more than ${limits.maxJsonValues} values.`)
      }
    } else if (byte === 0x7d || byte === 0x5d) {
      depth--
    }
  }
}

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"])

/**
 * Parses untrusted JSON of at most `maxBytes`. Keys that could reach an object's prototype
 * (`__proto__`, `constructor`, `prototype`) are dropped and reported, so no later spread,
 * assign or merge can act on them; more than a few of them reject the file.
 */
export const parseJson = (bytes: Uint8Array, maxBytes: number, limits: Limits, issues: ReportBuilder): unknown => {
  if (bytes.byteLength > maxBytes) fail("json.too_large", `The JSON is larger than ${maxBytes} bytes.`)
  scanJson(bytes, limits)
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return fail("json.invalid", "The file isn't valid JSON.")
  }
  let forbidden = 0
  const path: Array<string | number> = []
  // The scan bounded the depth, so the recursion is bounded too. Only objects are walked into.
  const walk = (node: object) => {
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index++) {
        const item: unknown = node[index]
        if (typeof item !== "object" || item === null) continue
        path.push(index)
        walk(item)
        path.pop()
      }
      return
    }
    const record = node as Record<string, unknown>
    for (const key of Object.keys(record)) {
      const item = record[key]
      if (FORBIDDEN_KEYS.has(key)) {
        if (++forbidden > limits.maxForbiddenKeys) {
          fail("json.forbidden_keys", `The JSON has more than ${limits.maxForbiddenKeys} prototype keys.`)
        }
        delete record[key]
        issues.add("warning", "json.forbidden_key", `The key "${key}" was dropped.`, [...path, key])
      } else if (typeof item === "object" && item !== null) {
        path.push(key)
        walk(item)
        path.pop()
      }
    }
  }
  if (typeof value === "object" && value !== null) walk(value)
  return value
}

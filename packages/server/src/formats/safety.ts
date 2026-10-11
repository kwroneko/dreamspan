// What every format parser shares: its error, the caps on untrusted input, and JSON parsing
// that can't hand a prototype key or unbounded nesting to the code after it. Imported files
// are data only: nothing in them is ever executed or rendered.
import { Effect, Schema } from "effect"
import { ImportIssue } from "@rp/shared/importReport.ts"

/** A file that can't be imported at all. Recoverable problems are issues in the report instead. */
export class FormatError extends Schema.TaggedError<FormatError>()("FormatError", {
  /** A stable machine code, e.g. `png.chunk_too_large`. */
  code: Schema.String,
  message: Schema.String
}) {}

export interface Limits {
  /** Any imported file. */
  readonly maxFileBytes: number
  /** A JSON document: a card, a lorebook, or a PNG's card chunk once decoded. */
  readonly maxJsonBytes: number
  readonly maxJsonDepth: number
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
  maxFileBytes: 64 * MiB,
  maxJsonBytes: 32 * MiB,
  maxJsonDepth: 64,
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

/** Collects a file's recoverable problems for its import report. */
export class Issues {
  readonly list: Array<ImportIssue> = []
  warn(code: string, message: string, path: Path) {
    this.list.push(new ImportIssue({ level: "warning", code, message, path: [...path] }))
  }
  info(code: string, message: string, path?: Path) {
    this.list.push(new ImportIssue({ level: "info", code, message, ...(path ? { path: [...path] } : {}) }))
  }
}

export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"])

/**
 * Parses untrusted JSON. Keys that could reach an object's prototype (`__proto__`,
 * `constructor`, `prototype`) are dropped and reported, so no later spread, assign or merge
 * can act on them, and nesting deeper than the limit rejects the file.
 */
export const parseJson = (bytes: Uint8Array, limits: Limits, issues: Issues): unknown => {
  if (bytes.byteLength > limits.maxJsonBytes) {
    fail("json.too_large", `The JSON is larger than ${limits.maxJsonBytes} bytes.`)
  }
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return fail("json.invalid", "The file isn't valid JSON.")
  }
  const walk = (node: unknown, path: Array<string | number>) => {
    if (typeof node !== "object" || node === null) return
    if (path.length >= limits.maxJsonDepth) {
      fail("json.too_deep", `The JSON is nested more than ${limits.maxJsonDepth} levels deep.`)
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, [...path, index]))
      return
    }
    const record = node as Record<string, unknown>
    for (const key of Object.keys(record)) {
      if (FORBIDDEN_KEYS.has(key)) {
        delete record[key]
        issues.warn("json.forbidden_key", `The key "${key}" was dropped.`, [...path, key])
      } else {
        walk(record[key], [...path, key])
      }
    }
  }
  walk(value, [])
  return value
}

// Lenient reading of fields from an untrusted object. A missing or null field takes its
// default quietly, as ST does; a field of the wrong type takes it too, with a warning in the
// import report, so one bad field never costs the whole file.
import { type Issues, isObject, type Path } from "./safety.ts"

export class Fields {
  readonly source: Record<string, unknown>
  readonly path: Path
  readonly issues: Issues
  constructor(source: Record<string, unknown>, path: Path, issues: Issues) {
    this.source = source
    this.path = path
    this.issues = issues
  }

  value<A>(key: string, fallback: A, valid: (value: unknown) => value is A, expected: string): A {
    const value = this.source[key]
    if (value === undefined || value === null) return fallback
    if (valid(value)) return value
    this.issues.warn("field.invalid", `"${key}" should be ${expected}; the default was used instead.`, [
      ...this.path,
      key
    ])
    return fallback
  }

  has(key: string) {
    return this.source[key] !== undefined && this.source[key] !== null
  }

  string(key: string, fallback = "") {
    return this.value(key, fallback, isString, "text")
  }
  boolean(key: string, fallback: boolean) {
    return this.value(key, fallback, isBoolean, "true or false")
  }
  number(key: string, fallback: number) {
    return this.value(key, fallback, isFinite, "a number")
  }
  int(key: string, fallback: number) {
    return this.value(key, fallback, isInt, "a whole number")
  }
  nullableInt(key: string) {
    return this.value<number | null>(key, null, isInt, "a whole number")
  }
  nullableBoolean(key: string) {
    return this.value<boolean | null>(key, null, isBoolean, "true or false")
  }
  object(key: string) {
    return this.value<Record<string, unknown>>(key, {}, isObject, "an object")
  }
  list(key: string) {
    return this.value<ReadonlyArray<unknown>>(key, [], Array.isArray, "a list")
  }

  /** A list of text. Non-text items are dropped; a single string is a list of one, or split on commas. */
  strings(key: string, split: "one" | "commas" = "one"): Array<string> {
    const value = this.source[key]
    if (typeof value === "string") {
      return split === "one"
        ? [value]
        : value
            .split(",")
            .map((part) => part.trim())
            .filter((part) => part !== "")
    }
    const list = this.list(key)
    const strings = list.filter(isString)
    if (strings.length !== list.length) {
      this.issues.warn("field.invalid", `Items of "${key}" that weren't text were dropped.`, [...this.path, key])
    }
    return strings
  }

  /** A field that may be absent, kept only when it has the right type. */
  optional<A>(key: string, valid: (value: unknown) => value is A, expected: string): { [k: string]: A } {
    if (!this.has(key)) return {}
    const value = this.source[key]
    if (valid(value)) return { [key]: value }
    this.issues.warn("field.invalid", `"${key}" should be ${expected}; it was dropped.`, [...this.path, key])
    return {}
  }

  /** The source's keys outside `known`, verbatim, or nothing when there are none. */
  unknown(known: ReadonlySet<string>): { unknown_fields?: Record<string, unknown> } {
    const rest = Object.entries(this.source).filter(([key]) => !known.has(key))
    return rest.length > 0 ? { unknown_fields: Object.fromEntries(rest) } : {}
  }
}

export const isString = (value: unknown): value is string => typeof value === "string"
export const isBoolean = (value: unknown): value is boolean => typeof value === "boolean"
export const isFinite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)
export const isInt = (value: unknown): value is number => Number.isInteger(value)
export const isStringArray = (value: unknown): value is Array<string> => Array.isArray(value) && value.every(isString)

/** A numeric ST enum read by name: `names[n]` for its value `n`. */
export const enumByIndex = <A extends string>(fields: Fields, key: string, names: ReadonlyArray<A>, fallback: A): A => {
  const value = fields.source[key]
  if (value === undefined || value === null) return fallback
  const name = isInt(value) ? names[value] : undefined
  if (name !== undefined) return name
  fields.issues.warn("field.invalid", `"${key}" has an unknown value; the default was used instead.`, [
    ...fields.path,
    key
  ])
  return fallback
}

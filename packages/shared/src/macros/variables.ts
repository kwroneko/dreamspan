// ST's chat ("local") and global variables (public/scripts/variables.js at 06bde939), as an
// overlay on the values in the context. Writes are recorded as effects for the caller to
// turn into state events (`var.set`, DATA-MODEL §5.3); nothing is written anywhere else.
//
// ST's semantics, reproduced:
// - Values are stored as given (setvar stores its text); a read turns numeric text into a
//   number, so `{{getvar}}` of "007" is "7".
// - addvar adds numbers, appends to a JSON array, and otherwise concatenates text. Its
//   starting value is `read || 0`, so "0" plus "abc" is "abc".
// - getvarkey on a value that isn't JSON returns the whole value.
// Names are only looked up as own keys, so "__proto__" or "constructor" are ordinary names.
//
// Unlike ST, a write is refused when the value would be over MAX_VALUE characters: the macro
// stays as written and nothing is recorded. Reading a value costs work once per value written
// (the read and the JSON parse are cached until the next write), so a large value can't be
// re-read for free.

export type VarValue = string | number

/** The longest value a write may produce: 1 MB of text. */
export const MAX_VALUE = 1_000_000

export type VarScope = "local" | "global"

/** A variable write. `value: null` deletes it. */
export interface VariableEffect {
  readonly scope: VarScope
  readonly name: string
  readonly value: VarValue | null
}

export interface VariableValues {
  readonly local?: Readonly<Record<string, unknown>>
  readonly global?: Readonly<Record<string, unknown>>
}

/** ST's normalizeMacroResult. */
export const normalize = (value: unknown): string => {
  if (value === null || value === undefined) return ""
  if (typeof value === "object") return JSON.stringify(value)
  return String(value)
}

/** ST's getLocalVariable return value: numeric text becomes a number. */
const read = (value: unknown): unknown => {
  const trimmed = typeof value === "string" ? value.trim() : undefined
  if (trimmed === "" || Number.isNaN(Number(value))) return value || ""
  return Number(value)
}

const parseJson = (text: unknown): { readonly ok: true; readonly value: unknown } | { readonly ok: false } => {
  try {
    return { ok: true, value: JSON.parse(text as string) }
  } catch {
    return { ok: false }
  }
}

const stored = (value: unknown): VarValue | undefined => {
  if (value === null || value === undefined) return undefined
  return typeof value === "string" || typeof value === "number" ? value : normalize(value)
}

type Parsed = { readonly ok: true; readonly value: unknown } | { readonly ok: false }

export class VariableScope {
  private readonly values: Map<string, VarValue>
  private readonly reads = new Map<string, unknown>()
  private readonly parsed = new Map<string, Parsed>()
  private readonly scope: VarScope
  private readonly effects: Array<VariableEffect>
  /** Counts characters read, parsed or written against the expansion's work limit. */
  private readonly charge: (size: number) => void

  constructor(
    initial: Readonly<Record<string, unknown>> | undefined,
    scope: VarScope,
    effects: Array<VariableEffect>,
    charge: (size: number) => void
  ) {
    this.values = new Map()
    for (const [name, value] of Object.entries(initial ?? {})) {
      const v = stored(value)
      if (v !== undefined) this.values.set(name, v)
    }
    this.scope = scope
    this.effects = effects
    this.charge = charge
  }

  has(name: string): boolean {
    return this.values.has(name)
  }

  private size(name: string) {
    const value = this.values.get(name)
    return value === undefined ? 0 : String(value).length
  }

  get(name: string): unknown {
    if (!this.reads.has(name)) {
      this.charge(this.size(name))
      this.reads.set(name, read(this.values.get(name)))
    }
    return this.reads.get(name)
  }

  private json(name: string): Parsed {
    let parsed = this.parsed.get(name)
    if (!parsed) {
      this.charge(this.size(name))
      parsed = parseJson(this.values.get(name))
      this.parsed.set(name, parsed)
    }
    return parsed
  }

  /** getvarkey: an object key or array index of a JSON value. */
  getAt(name: string, index: string): unknown {
    let value: unknown = this.values.get(name)
    const parsed = this.json(name)
    // Indexing JSON null throws in ST, which then reads the null itself (as 0).
    if (parsed.ok) value = parsed.value
    if (parsed.ok && value !== null) {
      const key = Number.isNaN(Number(index)) ? index : String(Number(index))
      const container = Object(value) as Record<string, unknown>
      value = Object.hasOwn(container, key) ? container[key] : undefined
      if (typeof value === "object") value = JSON.stringify(value)
    }
    return read(value)
  }

  set(name: string, value: VarValue): void {
    if (!name) throw new Error("Variable name cannot be empty")
    const size = String(value).length
    if (size > MAX_VALUE) throw new Error("Variable value too large")
    this.charge(size)
    this.values.set(name, value)
    this.reads.delete(name)
    this.parsed.delete(name)
    this.effects.push({ scope: this.scope, name, value })
  }

  /** setvarkey: sets a key (an object, created if absent) or an index (an array). */
  setAt(name: string, index: string, value: string): void {
    if (!name) throw new Error("Variable name cannot be empty")
    this.charge(this.size(name))
    const parsed = parseJson(this.values.get(name) ?? "null")
    if (!parsed.ok) return
    const numeric = !Number.isNaN(Number(index))
    let container = parsed.value ?? (numeric ? [] : {})
    // ST assigns in strict mode: a primitive can't take a key, and the write is dropped.
    if (typeof container !== "object") return
    const key = numeric ? String(Number(index)) : index
    // An index past the end pads the array with nulls when it's serialized.
    if (Array.isArray(container) && (Number(key) - container.length) * 5 > MAX_VALUE)
      throw new Error("Variable value too large")
    container = Object.assign(container, { [key]: value })
    this.set(name, JSON.stringify(container))
  }

  /** addvar; returns the new value, normalized. */
  add(name: string, value: VarValue): string {
    const current = this.get(name) || 0
    const parsed = parseJson(current)
    if (parsed.ok && Array.isArray(parsed.value)) {
      parsed.value.push(value)
      this.set(name, JSON.stringify(parsed.value))
      return normalize(parsed.value)
    }
    const increment = Number(value)
    if (Number.isNaN(increment) || Number.isNaN(Number(current))) {
      const text = String(current || "") + value
      this.set(name, text)
      return text
    }
    const sum = Number(current) + increment
    if (Number.isNaN(sum)) return ""
    this.set(name, sum)
    return String(sum)
  }

  delete(name: string): void {
    if (!this.values.delete(name)) return
    this.reads.delete(name)
    this.parsed.delete(name)
    this.effects.push({ scope: this.scope, name, value: null })
  }

  snapshot(): Readonly<Record<string, VarValue>> {
    return Object.fromEntries(this.values)
  }
}

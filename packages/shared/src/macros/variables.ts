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

export type VarValue = string | number

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

export class VariableScope {
  private readonly values: Map<string, VarValue>
  private readonly scope: VarScope
  private readonly effects: Array<VariableEffect>
  /** Counts written characters against the expansion's work limit. */
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

  get(name: string): unknown {
    return read(this.values.get(name))
  }

  /** getvarkey: an object key or array index of a JSON value. */
  getAt(name: string, index: string): unknown {
    let value: unknown = this.values.get(name)
    const parsed = parseJson(value)
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
    this.charge(String(value).length)
    this.values.set(name, value)
    this.effects.push({ scope: this.scope, name, value })
  }

  /** setvarkey: sets a key (an object, created if absent) or an index (an array). */
  setAt(name: string, index: string, value: string): void {
    if (!name) throw new Error("Variable name cannot be empty")
    const parsed = parseJson(this.values.get(name) ?? "null")
    if (!parsed.ok) return
    const numeric = !Number.isNaN(Number(index))
    let container = parsed.value ?? (numeric ? [] : {})
    // ST assigns in strict mode: a primitive can't take a key, and the write is dropped.
    if (typeof container !== "object") return
    // Assigning a string to "__proto__" does nothing in ST either.
    if (index !== "__proto__") {
      const key = numeric ? String(Number(index)) : index
      // An index past the end pads the array with nulls when it's serialized.
      if (Array.isArray(container) && Number(key) > container.length) this.charge((Number(key) - container.length) * 5)
      container = Object.assign(container, { [key]: value })
    }
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
    this.effects.push({ scope: this.scope, name, value: null })
  }

  snapshot(): Readonly<Record<string, VarValue>> {
    return Object.fromEntries(this.values)
  }
}

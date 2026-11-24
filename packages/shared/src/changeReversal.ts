// Revert and Redo of one change, like git revert (spec/WORKSHOP-CARDS.md §8.1): a change is the
// pair (B, A), the document before it and after it, and H is the document now. Each field the
// change touched is taken back on H: set to B where H still equals A, else the change's hunks are
// reversed on H's text (a three-way merge of B and H on base A). Where that doesn't apply cleanly
// the field is a conflict, and nothing is written until the user picks for it. Pure, so the
// writer, the files host and the client compute the same thing.
import { canonicalJson } from "./editing.ts"
import { merge3 } from "./merge.ts"

type Path = ReadonlyArray<string>

const isObject = (u: unknown): u is Record<string, unknown> => typeof u === "object" && u !== null && !Array.isArray(u)
const own = (object: Record<string, unknown>, key: string) => (Object.hasOwn(object, key) ? object[key] : undefined)
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b)

export const ORDER_UNIT = "@order"

const IDENTITIES = ["id", "identifier", "uid"] as const

/** The key that names every element of these lists, as History's comparisons split them. */
const identityOf = (lists: ReadonlyArray<ReadonlyArray<unknown>>) =>
  IDENTITIES.find((key) =>
    lists.every((list) =>
      list.every((element) => {
        if (!isObject(element)) return false
        const id = own(element, key)
        return typeof id === "string" || typeof id === "number"
      })
    )
  )

const namedEntries = (list: ReadonlyArray<unknown>, identity: string) =>
  new Map(list.map((entry) => [`${identity}=${String((entry as Record<string, unknown>)[identity])}`, entry]))

const commonOrder = (order: ReadonlyArray<string>, other: ReadonlySet<string>) => order.filter((key) => other.has(key))

export const changedEntryOrder = (before: ReadonlyArray<string>, after: ReadonlyArray<string>) =>
  !same(commonOrder(before, new Set(after)), commonOrder(after, new Set(before)))

/** A field's key: its path as JSON, `["description"]` or `["entries","uid=3"]`. */
export const unitKey = (path: Path) => JSON.stringify(path)
export const unitPath = (key: string): Path => {
  const parsed = JSON.parse(key) as unknown
  return Array.isArray(parsed) && parsed.every((s) => typeof s === "string") ? parsed : []
}

/**
 * The fields that differ between two documents, as a revert takes them: each top-level field,
 * except a list whose elements have ids (a lorebook's entries, a preset's prompts), which is
 * element by element (`uid=3`), as History's comparisons list them.
 */
export const changedUnits = (before: unknown, after: unknown): ReadonlyArray<string> => {
  const b = isObject(before) ? before : {}
  const a = isObject(after) ? after : {}
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])]
  return keys.flatMap((key) => {
    const x = own(b, key)
    const y = own(a, key)
    if (same(x, y)) return []
    if (Array.isArray(x) && Array.isArray(y)) {
      const id = identityOf([x, y])
      if (id !== undefined) {
        const xs = namedEntries(x, id)
        const ys = namedEntries(y, id)
        if (xs.size === x.length && ys.size === y.length) {
          const keys = [...new Set([...xs.keys(), ...ys.keys()])]
          const changed = keys.filter((k) => !same(xs.get(k), ys.get(k))).map((k) => unitKey([key, k]))
          if (changedEntryOrder([...xs.keys()], [...ys.keys()])) changed.unshift(unitKey([key, ORDER_UNIT]))
          if (changed.length > 0) return changed
        }
      }
    }
    return [unitKey([key])]
  })
}

/** The element of `list` that `segment` (`uid=3`) names. */
const findIn = (list: ReadonlyArray<unknown>, segment: string) => {
  const at = segment.indexOf("=")
  const id = segment.slice(0, at)
  const value = segment.slice(at + 1)
  return list.findIndex((e) => isObject(e) && String(own(e, id)) === value)
}

/** A field's value in a document; undefined where it has none. */
const unitValue = (doc: unknown, key: string): unknown => {
  const [top, element] = unitPath(key)
  if (top === undefined || !isObject(doc)) return undefined
  const value = own(doc, top)
  if (element === undefined) return value
  if (!Array.isArray(value)) return undefined
  if (element === ORDER_UNIT) {
    const identity = identityOf([value])
    return identity === undefined ? undefined : [...namedEntries(value, identity).keys()]
  }
  const at = findIn(value, element)
  return at < 0 ? undefined : value[at]
}

/**
 * `doc` with a field set (removed for undefined). An element that isn't in the list goes after
 * the one before it in `order` (the list as the value came from), else first.
 */
const withUnit = (
  doc: Record<string, unknown>,
  key: string,
  value: unknown,
  order: unknown
): Record<string, unknown> => {
  const [top, element] = unitPath(key)
  if (top === undefined) return doc
  if (element === undefined) {
    const next = { ...doc }
    if (value === undefined) delete next[top]
    else next[top] = value
    return next
  }
  const list = Array.isArray(own(doc, top)) ? [...(own(doc, top) as Array<unknown>)] : []
  if (element === ORDER_UNIT) {
    if (!Array.isArray(value)) return doc
    const positions = (value as Array<string>).map((key) => findIn(list, key)).filter((i) => i >= 0)
    const entries = positions.map((i) => list[i])
    positions.sort((a, b) => a - b).forEach((at, i) => (list[at] = entries[i]))
    return { ...doc, [top]: list }
  }
  const at = findIn(list, element)
  if (at >= 0) {
    if (value === undefined) list.splice(at, 1)
    else list[at] = value
  } else if (value !== undefined) {
    const source = Array.isArray(order) ? order : []
    const from = findIn(source, element)
    let place = 0
    for (let i = from - 1; i >= 0; i--) {
      const prior = source[i]
      const id = IDENTITIES.find((k) => isObject(prior) && own(prior, k) !== undefined)
      const there = id === undefined ? -1 : findIn(list, `${id}=${String((prior as Record<string, unknown>)[id])}`)
      if (there >= 0) {
        place = there + 1
        break
      }
    }
    list.splice(place, 0, value)
  }
  return { ...doc, [top]: list }
}

/** A partial document holding these fields' values (keyed by `unitKey`), for `planReversal`. */
export const docOfUnits = (values: Readonly<Record<string, unknown>>): Record<string, unknown> => {
  let doc: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(values)) doc = withUnit(doc, key, value, undefined)
  return doc
}

/** A field that can't be taken back on its own: what it is now, and what it was before the change. */
interface ReversalConflict {
  readonly field: string
  readonly now?: unknown
  readonly before?: unknown
}

/** For a conflicting field: keep it as it is now, or take it as it was before the change. */
export type ConflictChoice = "now" | "before"

/** Choices only apply to the head the user saw. */
export const matchesReversalHead = (
  head: string,
  options: {
    readonly expectedHead?: string | undefined
    readonly choices?: Readonly<Record<string, ConflictChoice>> | undefined
  }
) => options.expectedHead === head || (options.expectedHead === undefined && options.choices === undefined)

export interface ReversalPlan {
  /** The document with the fields taken back; null when a conflict is left. */
  readonly doc: Record<string, unknown> | null
  /** The fields taken back (already as before counts). */
  readonly fields: ReadonlyArray<string>
  /** Each field's value before and after the reversal, for the record (absent: none). */
  readonly before: Readonly<Record<string, unknown>>
  readonly after: Readonly<Record<string, unknown>>
  readonly conflicts: ReadonlyArray<ReversalConflict>
  /** Conflicting fields kept as they are now. */
  readonly kept: ReadonlyArray<string>
}

export interface ReversalPatch {
  readonly original: unknown
  readonly changed: unknown
  readonly fields: ReadonlyArray<string>
}

/** Applies one inverse patch using the same planner as a group of changes. */
export const planReversal = (
  input: ReversalPatch & {
    readonly now: Record<string, unknown>
    readonly choices?: Readonly<Record<string, ConflictChoice>>
  }
): ReversalPlan => planGroupedReversal([input], input.now, input.choices)

/** Merge the relative order of surviving shared entries, independently of their values. */
const mergeUnit = (field: string, changed: unknown, now: unknown, original: unknown) => {
  if (unitPath(field)[1] !== ORDER_UNIT || !Array.isArray(changed) || !Array.isArray(now) || !Array.isArray(original))
    return merge3(changed, now, original)
  const shared = new Set(commonOrder(changed, new Set(now)).filter((key) => original.includes(key)))
  return merge3(commonOrder(changed, shared), commonOrder(now, shared), commonOrder(original, shared))
}

/** Apply the selected inverse patches newest first, on a tentative document. */
export const planGroupedReversal = (
  patches: ReadonlyArray<ReversalPatch>,
  now: Record<string, unknown>,
  choices?: Readonly<Record<string, ConflictChoice>>
): ReversalPlan => {
  let doc = now
  const fields = new Set<string>()
  const conflicts = new Set<string>()
  const kept = new Set<string>()
  for (const patch of patches) {
    for (const field of patch.fields) {
      if (kept.has(field)) continue
      const a = unitValue(patch.changed, field)
      const b = unitValue(patch.original, field)
      const h = unitValue(doc, field)
      const merged = mergeUnit(field, a, h, b)
      const choice = choices?.[field]
      let value = merged.value
      if (merged.conflicts.length > 0) {
        if (choice === "before") value = b
        else if (choice === "now") {
          kept.add(field)
          fields.delete(field)
          doc = withUnit(doc, field, unitValue(now, field), own(now, unitPath(field)[0]!))
          continue
        } else {
          // Compute the result of Take before for the preview without committing it.
          conflicts.add(field)
          value = b
        }
      }
      fields.add(field)
      const [top] = unitPath(field)
      doc = withUnit(
        doc,
        field,
        value,
        top === undefined || !isObject(patch.original) ? undefined : own(patch.original, top)
      )
    }
  }
  const values = (source: Record<string, unknown>) =>
    Object.fromEntries(
      [...fields].flatMap((field) => {
        const value = unitValue(source, field)
        return value === undefined ? [] : [[field, value]]
      })
    )
  return {
    doc: conflicts.size > 0 ? null : doc,
    fields: [...fields].filter((field) => !conflicts.has(field)),
    before: values(now),
    after: values(doc),
    conflicts: [...conflicts].map((field) => {
      const current = unitValue(now, field)
      const before = unitValue(doc, field)
      return { field, ...(current === undefined ? {} : { now: current }), ...(before === undefined ? {} : { before }) }
    }),
    kept: [...kept]
  }
}

/**
 * Each field's state from its reversal records, oldest first: reverted when its latest record
 * that names it is a revert.
 */
export const revertedFields = (
  records: ReadonlyArray<{ readonly action: "revert" | "redo"; readonly fields: ReadonlyArray<string> }>
): ReadonlySet<string> => {
  const state = new Map<string, boolean>()
  for (const record of records) for (const field of record.fields) state.set(field, record.action === "revert")
  return new Set([...state].filter(([, reverted]) => reverted).map(([field]) => field))
}

/**
 * A card file's edits in one turn, oldest first, as one change: each field as before the first
 * edit that changed it and after the last (`undo.card` of `edit_card_file`).
 */
export const combinedFileEdits = (
  edits: ReadonlyArray<{
    readonly before: Readonly<Record<string, unknown>>
    readonly after: Readonly<Record<string, unknown>>
  }>
) => {
  const before: Record<string, unknown> = {}
  const after: Record<string, unknown> = {}
  const seen = new Set<string>()
  for (const edit of edits)
    for (const key of new Set([...Object.keys(edit.before), ...Object.keys(edit.after)])) {
      if (!seen.has(key)) {
        seen.add(key)
        if (Object.hasOwn(edit.before, key)) before[key] = edit.before[key]
      }
      delete after[key]
      if (Object.hasOwn(edit.after, key)) after[key] = edit.after[key]
    }
  return { before, after }
}

/** A unit as the assistant names it: "description", "entries uid=3". */
export const unitName = (unit: string) => {
  const [field, part] = unitPath(unit)
  return part === undefined ? (field ?? "") : `${field} ${part === ORDER_UNIT ? "order" : part}`
}

/** The units a list of names given by the assistant picks: by its name or its top-level field. */
export const pickedUnits = (units: ReadonlyArray<string>, names: ReadonlyArray<string> | undefined) =>
  names === undefined
    ? units
    : units.filter((unit) => names.some((n) => n === unitName(unit) || n === (JSON.parse(unit) as Array<string>)[0]))

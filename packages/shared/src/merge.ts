// Three-way merge of library documents (DATA-MODEL §3.2): merges a variant's edits with
// a new upstream version, field by field. Shared so the server merges and the client's
// conflict resolver shows exactly the same result.
//
// - Objects merge per key.
// - Arrays whose elements all carry a unique `id`, `identifier` or `uid` (preset
//   prompts, card modules, lorebook entries) merge per element, so additions on either
//   side survive. Order follows ours, with theirs' new elements placed after their
//   predecessor. Reorderings on both sides aren't detected as conflicts.
// - Other arrays are atomic: if both sides changed one differently, that's a conflict.
// - Strings changed on both sides merge word by word (diff3), so edits to different
//   sentences of one paragraph combine. Overlapping edits are a conflict.
//
// A conflict leaves ours in the merged value and is reported with its path.
import { diff3Merge } from "node-diff3"

export type PathSegment = string | number
export interface MergeConflict {
  readonly path: ReadonlyArray<PathSegment>
  readonly base: unknown
  readonly ours: unknown
  readonly theirs: unknown
}
export interface MergeResult {
  readonly value: unknown
  readonly conflicts: ReadonlyArray<MergeConflict>
}

const isObject = (u: unknown): u is Record<string, unknown> => typeof u === "object" && u !== null && !Array.isArray(u)

export const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]))
  if (isObject(a)) {
    if (!isObject(b)) return false
    const ka = Object.keys(a).filter((k) => a[k] !== undefined)
    const kb = Object.keys(b).filter((k) => b[k] !== undefined)
    return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]))
  }
  return false
}

/** Words and the whitespace between them, so a merge never splits a word. */
const tokens = (text: string) => text.split(/(\s+)/).filter((t) => t.length > 0)

/** Merges two edits of one text. Returns undefined if they overlap. */
export const mergeText = (base: string, ours: string, theirs: string): string | undefined => {
  const regions = diff3Merge(tokens(ours), tokens(base), tokens(theirs), { excludeFalseConflicts: true })
  let merged = ""
  for (const region of regions) {
    if (region.conflict) return undefined
    merged += (region.ok ?? []).join("")
  }
  return merged
}

const KEY_FIELDS = ["id", "identifier", "uid"] as const

/** The field that identifies elements in all three arrays, if there is one. */
const identityField = (arrays: ReadonlyArray<ReadonlyArray<unknown>>): string | undefined =>
  KEY_FIELDS.find((field) =>
    arrays.every((array) => {
      const seen = new Set<unknown>()
      return array.every((element) => {
        if (!isObject(element)) return false
        const key = element[field]
        if ((typeof key !== "string" && typeof key !== "number") || seen.has(key)) return false
        seen.add(key)
        return true
      })
    })
  )

export const merge3 = (base: unknown, ours: unknown, theirs: unknown): MergeResult => {
  const conflicts: Array<MergeConflict> = []

  const merge = (path: ReadonlyArray<PathSegment>, b: unknown, o: unknown, t: unknown): unknown => {
    if (deepEqual(o, t)) return o
    if (deepEqual(b, o)) return t
    if (deepEqual(b, t)) return o

    if (typeof o === "string" && typeof t === "string" && (b === undefined || typeof b === "string")) {
      const text = mergeText(b ?? "", o, t)
      if (text !== undefined) return text
    } else if (isObject(o) && isObject(t) && (b === undefined || isObject(b))) {
      return mergeObject(path, b ?? {}, o, t)
    } else if (Array.isArray(o) && Array.isArray(t) && (b === undefined || Array.isArray(b))) {
      const field = identityField([b ?? [], o, t])
      if (field) return mergeKeyed(path, field, (b ?? []) as Array<Record<string, unknown>>, o, t)
    }
    conflicts.push({ path, base: b, ours: o, theirs: t })
    return o
  }

  const mergeObject = (
    path: ReadonlyArray<PathSegment>,
    b: Record<string, unknown>,
    o: Record<string, unknown>,
    t: Record<string, unknown>
  ) => {
    const result: Record<string, unknown> = {}
    const keys = [
      ...Object.keys(o),
      ...Object.keys(t).filter((k) => !(k in o)),
      ...Object.keys(b).filter((k) => !(k in o) && !(k in t))
    ]
    for (const key of keys) {
      const value = merge([...path, key], b[key], o[key], t[key])
      if (value !== undefined) result[key] = value
    }
    return result
  }

  const mergeKeyed = (
    path: ReadonlyArray<PathSegment>,
    field: string,
    b: ReadonlyArray<Record<string, unknown>>,
    o: ReadonlyArray<Record<string, unknown>>,
    t: ReadonlyArray<Record<string, unknown>>
  ) => {
    const byKey = (array: ReadonlyArray<Record<string, unknown>>) => new Map(array.map((e) => [e[field], e] as const))
    const [B, O, T] = [byKey(b), byKey(o), byKey(t)]

    // Ours' order, with elements new in theirs inserted after their predecessor in theirs.
    const order: Array<unknown> = o.map((e) => e[field])
    t.forEach((element, index) => {
      const key = element[field]
      if (O.has(key) || B.has(key)) return
      const predecessor = t
        .slice(0, index)
        .reverse()
        .find((p) => order.includes(p[field]))
      order.splice(predecessor ? order.indexOf(predecessor[field]) + 1 : 0, 0, key)
    })
    // Elements ours deleted stay deleted unless the merge says otherwise; keep them in
    // theirs' position so a modify/delete conflict has somewhere to live.
    for (const key of B.keys()) if (!order.includes(key) && T.has(key)) order.push(key)

    const result: Array<unknown> = []
    for (const key of order) {
      const merged = merge([...path, `${field}=${String(key)}`], B.get(key), O.get(key), T.get(key))
      if (merged !== undefined) result.push(merged)
    }
    return result
  }

  const value = merge([], base, ours, theirs)
  return { value, conflicts }
}

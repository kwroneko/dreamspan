// Three-way merge of library documents; the rules are in ARCHITECTURE.md §3.9.
import { diff3Merge, diffIndices } from "node-diff3"
import { MergeConflictInfo } from "./library.ts"

type Path = ReadonlyArray<string | number>

const isObject = (u: unknown): u is Record<string, unknown> => typeof u === "object" && u !== null && !Array.isArray(u)

/** Own properties only, so keys like `constructor` or `__proto__` are plain data. */
const get = (object: Record<string, unknown>, key: string) => (Object.hasOwn(object, key) ? object[key] : undefined)

const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]))
  if (isObject(a)) {
    if (!isObject(b)) return false
    const ka = Object.keys(a).filter((k) => a[k] !== undefined)
    const kb = Object.keys(b).filter((k) => b[k] !== undefined)
    return ka.length === kb.length && ka.every((k) => deepEqual(a[k], get(b, k)))
  }
  return false
}

/** Words and the whitespace between them, so a merge never splits a word. */
const tokens = (text: string) => text.split(/(\s+)/).filter((t) => t.length > 0)

/** Carry edits into independently visible text spans. An edit crossing a span boundary is
 * ambiguous: retain that span's original text rather than disclose its neighbour's text. */
export const editedSpans = (base: string, edited: string, spans: ReadonlyArray<{ from: number; to: number }>) => {
  if (base === edited) return { texts: spans.map((s) => base.slice(s.from, s.to)), ambiguous: false }
  const before = tokens(base)
  const after = tokens(edited)
  const offsets = [0]
  for (const token of before) offsets.push(offsets.at(-1)! + token.length)
  const changes = diffIndices(before, after).map((d) => ({
    from: offsets[d.buffer1[0]]!,
    to: offsets[d.buffer1[0] + d.buffer1[1]]!,
    text: d.buffer2Content.join("")
  }))
  let ambiguous = false
  const texts = spans.map((span) => {
    const own = changes.filter(
      (c) => (c.from < span.to && c.to > span.from) || (c.from === c.to && c.from >= span.from && c.from <= span.to)
    )
    if (own.some((c) => c.from < span.from || c.to > span.to)) {
      ambiguous = true
      return base.slice(span.from, span.to)
    }
    let result = "",
      at = span.from
    for (const change of own) {
      result += base.slice(at, change.from) + change.text
      at = change.to
    }
    return result + base.slice(at, span.to)
  })
  return { texts, ambiguous }
}

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
        const key = get(element, field)
        if ((typeof key !== "string" && typeof key !== "number") || seen.has(key)) return false
        seen.add(key)
        return true
      })
    })
  )

/** `primary`'s keys, with `secondary`'s other keys placed after their predecessor in `secondary`. */
const weave = (primary: ReadonlyArray<unknown>, secondary: ReadonlyArray<unknown>) => {
  const order = [...primary]
  secondary.forEach((key, index) => {
    if (order.includes(key)) return
    const predecessor = secondary
      .slice(0, index)
      .reverse()
      .find((p) => order.includes(p))
    order.splice(predecessor === undefined ? 0 : order.indexOf(predecessor) + 1, 0, key)
  })
  return order
}

export const merge3 = (base: unknown, ours: unknown, theirs: unknown) => {
  const conflicts: Array<MergeConflictInfo> = []
  // A missing value isn't JSON, so a side without one is left out.
  const conflict = (path: Path, base: unknown, ours: unknown, theirs: unknown) =>
    conflicts.push(
      new MergeConflictInfo({
        path: [...path],
        ...Object.fromEntries(Object.entries({ base, ours, theirs }).filter(([, v]) => v !== undefined))
      })
    )

  const merge = (path: Path, b: unknown, o: unknown, t: unknown): unknown => {
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
    conflict(path, b, o, t)
    return o
  }

  const mergeObject = (
    path: Path,
    b: Record<string, unknown>,
    o: Record<string, unknown>,
    t: Record<string, unknown>
  ) => {
    const keys = [
      ...Object.keys(o),
      ...Object.keys(t).filter((k) => !Object.hasOwn(o, k)),
      ...Object.keys(b).filter((k) => !Object.hasOwn(o, k) && !Object.hasOwn(t, k))
    ]
    // fromEntries defines own properties, so a `__proto__` key stays data.
    return Object.fromEntries(
      keys.flatMap((key) => {
        const value = merge([...path, key], get(b, key), get(o, key), get(t, key))
        return value === undefined ? [] : [[key, value]]
      })
    )
  }

  const mergeKeyed = (
    path: Path,
    field: string,
    b: ReadonlyArray<Record<string, unknown>>,
    o: ReadonlyArray<Record<string, unknown>>,
    t: ReadonlyArray<Record<string, unknown>>
  ) => {
    const keys = (array: ReadonlyArray<Record<string, unknown>>) => array.map((e) => e[field])
    const byKey = (array: ReadonlyArray<Record<string, unknown>>) => new Map(array.map((e) => [e[field], e] as const))
    const [B, O, T] = [byKey(b), byKey(o), byKey(t)]

    // A side reordered if the elements all three share are in a different order than in base.
    const shared = (array: ReadonlyArray<Record<string, unknown>>) =>
      keys(array).filter((k) => B.has(k) && O.has(k) && T.has(k))
    const oursMoved = !deepEqual(shared(o), shared(b))
    const theirsMoved = !deepEqual(shared(t), shared(b))
    if (oursMoved && theirsMoved && !deepEqual(shared(o), shared(t))) conflict(path, b, o, t)

    // The order of the side that reordered, with the other side's additions woven in.
    // Elements one side deleted are kept in place so a modify/delete conflict has
    // somewhere to live; merge() drops them otherwise.
    const order = theirsMoved && !oursMoved ? weave(keys(t), keys(o)) : weave(keys(o), keys(t))

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

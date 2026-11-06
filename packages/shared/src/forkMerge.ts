// Explicit library merge contract and pure, replaceable merge policy.
import { Schema } from "effect"
import { Doc, RefId, RevisionId, Revision, MergeConflictInfo, LibraryRef } from "./library.ts"
import { hasSchema, validateDoc } from "./editing.ts"
import type { EntityKind } from "./library.ts"
import { merge3 } from "./merge.ts"
import { makeRegistry } from "./registry.ts"

const MergePath = Schema.Array(Schema.Union([Schema.String, Schema.Number]))
type MergePath = typeof MergePath.Type
const MergeChoice = Schema.Struct({
  path: MergePath,
  /** An omitted value deletes the field or element. */
  value: Schema.optionalKey(Schema.Unknown)
})
export const MergeSelection = Schema.Struct({
  excluded: Schema.Array(MergePath),
  resolutions: Schema.Array(MergeChoice)
})
export type MergeSelection = typeof MergeSelection.Type
const MergeUnit = Schema.Struct({
  path: MergePath,
  oursChanged: Schema.Boolean,
  theirsChanged: Schema.Boolean,
  base: Schema.optionalKey(Schema.Unknown),
  ours: Schema.optionalKey(Schema.Unknown),
  theirs: Schema.optionalKey(Schema.Unknown)
})
export const ForkMergePreview = Schema.Struct({
  ref: LibraryRef,
  baseRevisionId: Schema.NullOr(RevisionId),
  oursRevisionId: RevisionId,
  theirsRevisionId: RevisionId,
  base: Doc,
  ours: Doc,
  theirs: Doc,
  merged: Doc,
  conflicts: Schema.Array(MergeConflictInfo),
  units: Schema.Array(MergeUnit)
})
export const MergeRecord = Schema.Struct({
  revisionId: RevisionId,
  oursRevisionId: RevisionId,
  baseRevisionId: Schema.NullOr(RevisionId),
  /** Null once the revision merged in is gone (its entry deleted for good). */
  theirsRevisionId: Schema.NullOr(RevisionId),
  sourceRefId: Schema.NullOr(RefId),
  selection: MergeSelection,
  createdAt: Schema.Number,
  undoneByRevisionId: Schema.NullOr(RevisionId)
})
export const MergeStatus = Schema.Struct({
  ref: LibraryRef,
  parentRefId: Schema.NullOr(RefId),
  baseRevisionId: Schema.NullOr(RevisionId),
  /** Newest first, on the parent's first-parent line, excluding the merge base. */
  versions: Schema.Array(Revision),
  records: Schema.Array(MergeRecord)
})
export const LibraryGenealogy = Schema.Struct({
  rootRefId: Schema.NullOr(RefId),
  rootNodeId: Schema.String,
  members: Schema.Array(
    Schema.Struct({
      nodeId: Schema.String,
      parentNodeId: Schema.NullOr(Schema.String),
      refId: Schema.NullOr(RefId),
      entityId: Schema.String,
      kind: Schema.String,
      parentRefId: Schema.NullOr(RefId),
      label: Schema.String,
      subtitle: Schema.String,
      state: Schema.Literals(["live", "archived", "binned", "purged"]),
      forkedAt: Schema.NullOr(Schema.Number),
      forkedFromRevisionId: Schema.NullOr(RevisionId),
      lastMergeAt: Schema.NullOr(Schema.Number)
    })
  )
})

const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const equal = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((v, i) => equal(v, b[i]))
  if (!object(a) || !object(b)) return false
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && equal(a[k], b[k]))
}
const get = (v: unknown, k: string | number) => (object(v) && Object.hasOwn(v, k) ? v[k] : undefined)
const identity = (arrays: ReadonlyArray<ReadonlyArray<unknown>>) =>
  ["id", "identifier", "uid"].find((k) =>
    arrays.every(
      (a) =>
        a.every((v) => object(v) && (typeof v[k] === "string" || typeof v[k] === "number")) &&
        new Set(a.map((v) => (v as Record<string, unknown>)[k])).size === a.length
    )
  )
const values = (base: unknown, ours: unknown, theirs: unknown) =>
  Object.fromEntries(Object.entries({ base, ours, theirs }).filter(([, v]) => v !== undefined))
const pathKey = (path: MergePath) => JSON.stringify(path)
const under = (path: MergePath, parent: MergePath) => parent.every((p, i) => p === path[i])

/** Changed scalar fields and keyed elements only; order is an independent, selectable unit. */
const units = (base: Doc, ours: Doc, theirs: Doc) => {
  const out: Array<typeof MergeUnit.Type> = []
  const add = (path: MergePath, b: unknown, o: unknown, t: unknown) => {
    if (!equal(b, o) || !equal(b, t))
      out.push({ path, oursChanged: !equal(b, o), theirsChanged: !equal(b, t), ...values(b, o, t) })
  }
  const walk = (path: MergePath, b: unknown, o: unknown, t: unknown) => {
    if (equal(b, o) && equal(b, t)) return
    if (Array.isArray(o) && Array.isArray(t) && (b === undefined || Array.isArray(b))) {
      const arrays = [b ?? [], o, t] as Array<Array<unknown>>
      const k = identity(arrays)
      if (k) {
        const maps = arrays.map((a) => new Map(a.map((v) => [(v as Record<string, unknown>)[k], v])))
        for (const id of new Set(maps.flatMap((m) => [...m.keys()])))
          add([...path, `${k}=${String(id)}`], ...(maps.map((m) => m.get(id)) as [unknown, unknown, unknown]))
        add(
          [...path, "$order"],
          ...(arrays.map((a) => a.map((v) => (v as Record<string, unknown>)[k])) as [unknown, unknown, unknown])
        )
        return
      }
    }
    if (object(o) && object(t) && (b === undefined || object(b))) {
      for (const k of new Set([...Object.keys(b ?? {}), ...Object.keys(o), ...Object.keys(t)]))
        walk([...path, k], get(b, k), get(o, k), get(t, k))
    } else add(path, b, o, t)
  }
  walk([], base, ours, theirs)
  return out
}

const read = (doc: unknown, path: MergePath): unknown => {
  let value = doc
  for (const p of path) {
    if (Array.isArray(value) && typeof p === "string" && p.includes("=")) {
      const at = p.indexOf("=")
      const k = p.slice(0, at)
      const id = p.slice(at + 1)
      value = value.find((v) => object(v) && String(v[k]) === id)
    } else value = get(value, p)
  }
  return value
}
const put = (root: unknown, path: MergePath, value: unknown): unknown => {
  if (path.length === 0) return value
  const [p, ...rest] = path
  if (Array.isArray(root)) {
    if (p === "$order") {
      if (!Array.isArray(value)) throw new Error("Order must be an array of element identities.")
      const k = identity([root])
      if (!k) throw new Error("This array has no element identities.")
      const positions = new Map(value.map((id, i) => [id, i]))
      return [...root].sort((a, b) => (positions.get(a[k]) ?? value.length) - (positions.get(b[k]) ?? value.length))
    }
    if (typeof p !== "string" || !p.includes("=")) throw new Error("Invalid element path.")
    const at = p.indexOf("=")
    const k = p.slice(0, at)
    const id = p.slice(at + 1)
    const index = root.findIndex((v) => object(v) && String(v[k]) === id)
    const next = put(index < 0 ? undefined : root[index], rest, value)
    const out = [...root]
    if (index >= 0) {
      if (next === undefined) out.splice(index, 1)
      else out[index] = next
    } else if (next !== undefined) out.push(next)
    return out
  }
  const out = Object.fromEntries(Object.entries(object(root) ? root : {}))
  const next = put(get(root, p!), rest, value)
  if (next === undefined) delete out[p!]
  else Object.defineProperty(out, p!, { value: next, enumerable: true, writable: true, configurable: true })
  return out
}
const prepare = (base: Doc, ours: Doc, theirs: Doc, kind?: EntityKind) => {
  const result = merge3(base, ours, theirs)
  const conflicts = result.conflicts.map((c) => {
    if (Array.isArray(c.base) && Array.isArray(c.ours) && Array.isArray(c.theirs)) {
      const k = identity([c.base, c.ours, c.theirs])
      if (k)
        return new MergeConflictInfo({
          path: [...c.path, "$order"],
          base: c.base.map((v) => v[k]),
          ours: c.ours.map((v) => v[k]),
          theirs: c.theirs.map((v) => v[k])
        })
    }
    return c
  })
  const merged = result.value as Doc
  if (kind && hasSchema(kind) && conflicts.length === 0) {
    const check = validateDoc(kind, merged)
    if (!check.ok)
      for (const k of new Set(check.paths.map((p) => String(p[0] ?? "")))) {
        conflicts.push(
          new MergeConflictInfo({
            path: k === "" ? [] : [k],
            ...values(
              k === "" ? base : get(base, k),
              k === "" ? ours : get(ours, k),
              k === "" ? theirs : get(theirs, k)
            )
          })
        )
      }
  }
  return { merged, conflicts, units: units(base, ours, theirs) }
}
const resolve = (base: Doc, ours: Doc, theirs: Doc, selection: MergeSelection, kind?: EntityKind) => {
  const plan = prepare(base, ours, theirs, kind)
  const valid = new Set(plan.units.map((u) => pathKey(u.path)))
  if (
    new Set(selection.excluded.map(pathKey)).size !== selection.excluded.length ||
    selection.excluded.some((p) => !valid.has(pathKey(p)))
  )
    throw new Error("An excluded change is absent or repeated; preview again.")
  const excluded = (p: MergePath) => selection.excluded.some((e) => under(p, e))
  const conflicts = plan.conflicts.filter((c) => !excluded(c.path))
  const keys = new Set(conflicts.map((c) => pathKey(c.path)))
  if (
    new Set(selection.resolutions.map((r) => pathKey(r.path))).size !== selection.resolutions.length ||
    selection.resolutions.some((r) => !keys.has(pathKey(r.path)))
  )
    throw new Error("A resolution is absent or repeated; preview again.")
  if (conflicts.some((c) => !selection.resolutions.some((r) => pathKey(r.path) === pathKey(c.path))))
    throw new Error("Resolve each included conflict before merging.")
  let doc: unknown = structuredClone(plan.merged)
  for (const r of selection.resolutions.filter((r) => r.path.at(-1) !== "$order")) doc = put(doc, r.path, r.value)
  for (const p of selection.excluded.filter((p) => p.at(-1) !== "$order")) doc = put(doc, p, read(ours, p))
  for (const p of selection.excluded.filter((p) => p.at(-1) === "$order")) {
    const u = plan.units.find((u) => pathKey(u.path) === pathKey(p))!
    doc = put(doc, p, u.ours)
  }
  for (const r of selection.resolutions.filter((r) => r.path.at(-1) === "$order")) doc = put(doc, r.path, r.value)
  return doc as Doc
}
interface LibraryMergePolicy {
  readonly id: string
  readonly prepare: typeof prepare
  readonly resolve: typeof resolve
}
export const libraryMergePolicies = makeRegistry<LibraryMergePolicy>()
export const defaultLibraryMergePolicy: LibraryMergePolicy = { id: "library.merge", prepare, resolve }

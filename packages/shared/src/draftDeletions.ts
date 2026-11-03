// Deletion belongs to the logical input, even when its edit history moves elsewhere.
import type { Draft, ObservedDeletion, FieldDeletion } from "./drafts.ts"

export interface DeletionBase {
  readonly draftId: string | null
  readonly expectedRowVersion: number | null
  readonly observedDeletion?: ObservedDeletion
}
type Deletions = Readonly<Record<string, FieldDeletion>>
type DeletionState = Pick<Draft, "id" | "clearedVersion" | "deletions" | "content">

export const deletionMap = (draft: Pick<Draft, "id" | "clearedVersion" | "deletions">): Deletions =>
  draft.deletions ??
  ((draft.clearedVersion ?? 0) > 0 ? { "": { draftId: draft.id, rowVersion: draft.clearedVersion! } } : {})

export const beforeDeletion = (currentId: string, deletion: ObservedDeletion, base: DeletionBase | null) => {
  const seen = base?.observedDeletion
  if (seen?.draftId === deletion.draftId && seen.rowVersion >= deletion.rowVersion) return false
  // A replacement row at this unique logical target was created after the retained barrier.
  if (currentId !== deletion.draftId) {
    if (seen?.draftId === currentId && seen.rowVersion > 0) return false
    if (base?.draftId === currentId && (base.expectedRowVersion ?? 0) > 0) return false
  }
  return base?.draftId !== deletion.draftId || (base.expectedRowVersion ?? 0) < deletion.rowVersion
}

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null
const form = (content: string): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(content)
    return object(parsed) ? parsed : null
  } catch {
    return null
  }
}
const at = (doc: unknown, path: ReadonlyArray<string>): { present: boolean; value?: unknown } => {
  for (const key of path) {
    if (!object(doc) || !Object.hasOwn(doc, key)) return { present: false }
    doc = doc[key]
  }
  return { present: true, value: doc }
}
const pathOf = (key: string): ReadonlyArray<string> | null => {
  try {
    const path: unknown = JSON.parse(key)
    return Array.isArray(path) && path.length > 0 && path.every((k) => typeof k === "string") ? path : null
  } catch {
    return null
  }
}
const valueOf = (token: ObservedDeletion, value: { present: boolean; value?: unknown }): FieldDeletion =>
  value.present
    ? { draftId: token.draftId, rowVersion: token.rowVersion, value: value.value }
    : { draftId: token.draftId, rowVersion: token.rowVersion, missing: true }

/** Record newly cleared inputs; retain their latest values through unrelated edits and commits. */
export const trackDeletions = (
  draft: Pick<Draft, "id" | "clearedVersion" | "deletions" | "rowVersion" | "content">,
  content: string,
  compound: boolean,
  deliberate: boolean
): Deletions => {
  const markers: Record<string, FieldDeletion> = { ...deletionMap(draft) }
  const token = { draftId: draft.id, rowVersion: draft.rowVersion + 1 }
  if (deliberate && draft.content !== "" && content === "") markers[""] = token
  if (!compound) return markers
  const after = form(content),
    before = form(draft.content)
  if (deliberate && before !== null && after !== null) {
    const stack: Array<{ left: unknown; right: unknown; path: ReadonlyArray<string> }> = [
      { left: before, right: after, path: [] }
    ]
    while (stack.length) {
      const { left, right, path } = stack.pop()!
      if (object(left)) {
        for (const key of new Set([...Object.keys(left), ...(object(right) ? Object.keys(right) : [])]))
          stack.push({
            left: Object.hasOwn(left, key) ? left[key] : undefined,
            right: object(right) && Object.hasOwn(right, key) ? right[key] : undefined,
            path: [...path, key]
          })
      } else if (typeof left === "string" && left !== "" && (right === "" || right === null || right === undefined)) {
        markers[JSON.stringify(path)] = token
      }
    }
  }
  if (after !== null)
    for (const [key, marker] of Object.entries(markers)) {
      const path = pathOf(key)
      if (path !== null) markers[key] = valueOf(marker, at(after, path))
    }
  return markers
}

/** Overlay only protected inputs. Other keystrokes in the same serialized form survive. */
export const reconcileDeletedFields = (draft: DeletionState, base: DeletionBase | null, content: string) => {
  const protectedFields = Object.entries(deletionMap(draft)).filter(
    ([key, token]) => key !== "" && beforeDeletion(draft.id, token, base)
  )
  if (protectedFields.length === 0) return { content, changed: false, rejected: false }
  const incoming = form(content)
  if (incoming === null) return { content: draft.content, changed: true, rejected: true }
  const current = form(draft.content)
  let changed = false
  for (const [key, marker] of protectedFields) {
    const path = pathOf(key)
    if (path === null) continue
    const wanted = marker.missing
      ? { present: false }
      : Object.hasOwn(marker, "value")
        ? { present: true, value: marker.value }
        : at(current, path)
    const supplied = at(incoming, path)
    if (supplied.present === wanted.present && JSON.stringify(supplied.value) === JSON.stringify(wanted.value)) continue
    let parent = incoming
    for (const segment of path.slice(0, -1)) {
      if (!Object.hasOwn(parent, segment) || !object(parent[segment]))
        Object.defineProperty(parent, segment, { value: {}, enumerable: true, writable: true, configurable: true })
      parent = parent[segment] as Record<string, unknown>
    }
    const last = path.at(-1)!
    if (wanted.present)
      Object.defineProperty(parent, last, { value: wanted.value, enumerable: true, writable: true, configurable: true })
    else delete parent[last]
    changed = true
  }
  return { content: changed ? JSON.stringify(incoming) : content, changed, rejected: false }
}

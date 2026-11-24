// Deletion belongs to the logical input, even when its edit history moves elsewhere.
import type { Draft, ObservedDeletion, FieldDeletion, EditingOrigin } from "./drafts.ts"
import { uuidv7 } from "./id.ts"

export interface DeletionBase {
  readonly draftId: string | null
  readonly expectedRowVersion: number | null
  readonly observedDeletion?: ObservedDeletion
  readonly editingFrom?: EditingOrigin
}
type Deletions = Readonly<Record<string, FieldDeletion>>
type DeletionState = Pick<Draft, "id" | "clearedVersion" | "deletions" | "content">

export const deletionMap = (draft: Pick<Draft, "id" | "clearedVersion" | "deletions">): Deletions =>
  draft.deletions ??
  ((draft.clearedVersion ?? 0) > 0 ? { "": { draftId: draft.id, rowVersion: draft.clearedVersion! } } : {})

export const beforeDeletion = (currentId: string, deletion: FieldDeletion, base: DeletionBase | null) => {
  const seen = base?.observedDeletion
  if (seen?.draftId === deletion.draftId && seen.rowVersion >= deletion.rowVersion) return false
  // A lost ACK must not strand typing descended from this very clear. This is an
  // authored event identity, never permission borrowed from a later server read.
  if (
    deletion.clearId !== undefined &&
    deletion.draftId === currentId &&
    (base?.draftId === currentId || base?.draftId === null) &&
    typeof base.editingFrom === "object" &&
    base.editingFrom.clearId === deletion.clearId
  )
    return false
  // A replacement row at this unique logical target was created after the retained barrier.
  if (currentId !== deletion.draftId) {
    if (seen?.draftId === currentId && seen.rowVersion > 0) return false
    if (base?.draftId === currentId && (base.expectedRowVersion ?? 0) > 0) return false
  }
  return base?.draftId !== deletion.draftId || (base.expectedRowVersion ?? 0) < deletion.rowVersion
}

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null
const originContent = (origin: EditingOrigin | null | undefined): string | null =>
  typeof origin === "object" && origin !== null ? origin.content : (origin ?? null)

export const mapEditingOrigin = (origin: EditingOrigin, change: (content: string) => string): EditingOrigin =>
  typeof origin === "string" ? change(origin) : { ...origin, content: change(origin.content) }

const form = (content: string | null): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(content ?? "null")
    return object(parsed) ? parsed : null
  } catch {
    return null
  }
}
const identity = (segment: string) => {
  const match = /^(id|identifier|uid)=(.*)$/s.exec(segment)
  return match ? { key: match[1]!, value: match[2]! } : null
}
const identityKey = (lists: ReadonlyArray<ReadonlyArray<unknown>>) =>
  ["id", "identifier", "uid"].find(
    (key) =>
      lists.some((list) => list.length > 0) &&
      lists.every((list) => {
        const ids = list.map((item) =>
          object(item) && Object.hasOwn(item, key) && (typeof item[key] === "string" || typeof item[key] === "number")
            ? String(item[key])
            : null
        )
        return ids.every((id) => id !== null) && new Set(ids).size === ids.length
      })
  )
type Value = { present: boolean; value?: unknown; unsafe?: boolean }
const at = (doc: unknown, path: ReadonlyArray<string>): Value => {
  for (const segment of path) {
    if (Array.isArray(doc)) {
      const id = identity(segment)
      if (id === null) return { present: false, unsafe: true }
      const matches = doc.filter(
        (item) => object(item) && Object.hasOwn(item, id.key) && String(item[id.key]) === id.value
      )
      if (matches.length > 1) return { present: false, unsafe: true }
      if (matches.length === 0) return { present: false }
      doc = matches[0]
    } else {
      if (!object(doc) || !Object.hasOwn(doc, segment)) return { present: false }
      doc = doc[segment]
    }
  }
  return { present: true, value: doc }
}
const pathOf = (key: string): ReadonlyArray<string> | null => {
  try {
    const path: unknown = JSON.parse(key)
    return Array.isArray(path) && path.every((k) => typeof k === "string") ? path : null
  } catch {
    return null
  }
}
const valueOf = (token: ObservedDeletion, value: Value): FieldDeletion =>
  value.present
    ? { draftId: token.draftId, rowVersion: token.rowVersion, value: value.value }
    : { draftId: token.draftId, rowVersion: token.rowVersion, missing: true }
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const own = (value: unknown, key: string): unknown =>
  object(value) && Object.hasOwn(value, key) ? value[key] : undefined
const empty = (value: unknown) => value === "" || value === null || value === undefined
const put = (parent: Record<string, unknown>, key: string, value: unknown) => {
  if (value === undefined) delete parent[key]
  else Object.defineProperty(parent, key, { value, enumerable: true, writable: true, configurable: true })
}
interface Clear {
  readonly path: ReadonlyArray<string>
  readonly array: boolean
}
const textCounts = (value: unknown, counts = new Map<string, number>()) => {
  const stack: unknown[] = [value]
  while (stack.length) {
    const item = stack.pop()
    if (typeof item === "string" && item !== "") counts.set(item, (counts.get(item) ?? 0) + 1)
    else if (object(item)) stack.push(...Object.values(item))
  }
  return counts
}
/** Actual removals from the form the author edited, never differences from another tab's text. */
const clearsFrom = (
  before: unknown,
  after: unknown,
  path: ReadonlyArray<string> = [],
  clears: Clear[] = []
): Clear[] => {
  if (equal(before, after)) return clears
  if (Array.isArray(before)) {
    const next = Array.isArray(after) ? after : []
    const key = identityKey([before, next])
    if (key !== undefined) {
      for (const item of before) {
        const segment = `${key}=${String(own(item, key))}`
        const found = next.find((candidate) => String(own(candidate, key)) === String(own(item, key)))
        if (found === undefined) clears.push({ path: [...path, segment], array: false })
        else clearsFrom(item, found, [...path, segment], clears)
      }
    } else {
      const remaining = textCounts(after)
      if ([...textCounts(before)].some(([text, count]) => (remaining.get(text) ?? 0) < count))
        clears.push({ path, array: true })
    }
  } else if (object(before)) {
    for (const key of Object.keys(before)) clearsFrom(before[key], own(after, key), [...path, key], clears)
  } else if (typeof before === "string" && before !== "" && empty(after)) clears.push({ path, array: false })
  return clears
}
// A clear is an authored event. Later insertion of the same string cannot cancel it.
const intendedClears = (origin: EditingOrigin | null | undefined, before: unknown, after: unknown): Clear[] => {
  const recorded = typeof origin === "object" && origin !== null ? origin.clearedArrays : []
  return [...clearsFrom(before, after), ...recorded.map((path) => ({ path, array: true }))]
}
/** Record only author-proved clears, and retain protected values through edits and commits. */
export const trackDeletions = (
  draft: Pick<Draft, "id" | "clearedVersion" | "deletions" | "rowVersion" | "content">,
  content: string,
  compound: boolean,
  deliberate: boolean,
  edit?: { readonly before: EditingOrigin | null; readonly content: string }
): Deletions => {
  const markers: Record<string, FieldDeletion> = { ...deletionMap(draft) }
  const token = { draftId: draft.id, rowVersion: draft.rowVersion + 1 }
  const clearId = typeof edit?.before === "object" && edit.before !== null ? edit.before.clearId : undefined
  if (
    deliberate &&
    (clearId !== undefined ||
      (edit
        ? originContent(edit.before) !== null && originContent(edit.before) !== "" && edit.content === ""
        : draft.content !== "" && content === "")) &&
    (clearId === undefined || markers[""]?.clearId !== clearId)
  )
    markers[""] = clearId === undefined ? token : { ...token, clearId }
  if (!compound) return markers
  const after = form(content),
    before = form(edit ? originContent(edit.before) : draft.content),
    intended = form(edit ? edit.content : content)
  if (deliberate && before !== null && intended !== null && after !== null) {
    for (const clear of intendedClears(edit?.before, before, intended)) {
      const final = at(after, clear.path)
      if (
        final.unsafe ||
        !(clear.array ? equal(final.value, at(intended, clear.path).value) : !final.present || empty(final.value))
      )
        continue
      const key = JSON.stringify(clear.path)
      const current = at(form(draft.content), clear.path)
      // Retrying the same clear while changing another input is not a new deletion.
      if (
        markers[key] !== undefined &&
        (clear.array ? equal(current.value, final.value) : !current.present || empty(current.value))
      )
        continue
      markers[key] = token
    }
  }
  if (after !== null)
    for (const [key, marker] of Object.entries(markers)) {
      const path = pathOf(key)
      if (path !== null) {
        const value = at(after, path)
        if (!value.unsafe) markers[key] = valueOf(marker, value)
      }
    }
  return markers
}

const clone = (value: unknown): unknown => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))

const assign = (incoming: Record<string, unknown>, current: unknown, path: ReadonlyArray<string>, wanted: Value) => {
  let parent: unknown = incoming
  for (let index = 0; index < path.length - 1; index++) {
    const segment = path[index]!
    if (Array.isArray(parent)) {
      const child = at(parent, [segment])
      // A cleared child cannot recreate an item that the incoming edit removed.
      if (!child.present || !object(child.value)) return
      parent = child.value
    } else if (object(parent)) {
      if (!object(own(parent, segment)))
        put(parent, segment, Array.isArray(at(current, path.slice(0, index + 1)).value) ? [] : {})
      parent = parent[segment]
    } else return
  }
  const last = path.at(-1)!
  if (Array.isArray(parent)) {
    const id = identity(last)
    if (id === null) return
    const index = parent.findIndex((item) => String(own(item, id.key)) === id.value)
    if (!wanted.present) {
      if (index >= 0) parent.splice(index, 1)
    } else if (index >= 0) parent[index] = clone(wanted.value)
    else parent.push(clone(wanted.value))
  } else if (object(parent)) put(parent, last, wanted.present ? clone(wanted.value) : undefined)
}

/** Preserve actual local clears across failed saves, even when typing returned to its original blank. */
export const editingOrigin = (
  origin: EditingOrigin | null,
  before: string,
  content: string,
  replaying?: EditingOrigin | null
): EditingOrigin => {
  if (before !== "" && content === "")
    return {
      // The event protects the old text. Subsequent input edits start from the
      // cleared field, so old form values cannot manufacture new input barriers.
      content: "",
      clearedArrays: [],
      // Replaying a queued transition after an earlier ACK retains its authored id.
      clearId: typeof replaying === "object" && replaying !== null ? (replaying.clearId ?? uuidv7()) : uuidv7()
    }
  const left = form(before),
    right = form(content)
  if (left === null || right === null) return origin ?? before
  let basis = form(originContent(origin)) ?? form(before)!
  const clears = clearsFrom(left, right)
  const arrays = typeof origin === "object" && origin !== null ? [...origin.clearedArrays] : []
  for (const clear of clears) {
    if (clear.array && !arrays.some((path) => equal(path, clear.path))) arrays.push(clear.path)
    if (clear.path.length === 0) {
      basis = left
      continue
    }
    // A locally added, then removed item may not occur in the acknowledged origin yet.
    for (let length = 1; length < clear.path.length; length++) {
      const parent = clear.path.slice(0, length)
      if (!at(basis, parent).present && at(left, parent).present) assign(basis, left, parent, at(left, parent))
    }
    assign(basis, left, clear.path, at(left, clear.path))
  }
  const result = JSON.stringify(basis)
  const clearId = typeof origin === "object" && origin !== null ? origin.clearId : undefined
  return arrays.length === 0 && clearId === undefined
    ? result
    : { content: result, clearedArrays: arrays, ...(clearId === undefined ? {} : { clearId }) }
}

/** Overlay protected inputs by identity. Anonymous-array conflicts retain the entire snapshot. */
export const reconcileDeletedFields = (draft: DeletionState, base: DeletionBase | null, content: string) => {
  const protectedFields = Object.entries(deletionMap(draft)).filter(
    ([key, token]) => key !== "" && beforeDeletion(draft.id, token, base)
  )
  if (protectedFields.length === 0) return { content, changed: false, rejected: false }
  let incoming = form(content)
  if (incoming === null) return { content: draft.content, changed: true, rejected: true }
  const current = form(draft.content)
  let changed = false
  for (const [key, marker] of protectedFields) {
    const path = pathOf(key)
    if (path === null) continue
    const supplied = at(incoming, path),
      now = at(current, path)
    // Older positional markers cannot be projected onto a possibly reordered list.
    if (supplied.unsafe || now.unsafe) return { content: draft.content, changed: true, rejected: true }
    const wanted = marker.missing
      ? { present: false }
      : Object.hasOwn(marker, "value")
        ? { present: true, value: marker.value }
        : now
    if (supplied.present === wanted.present && equal(supplied.value, wanted.value)) continue
    if (path.length === 0) {
      const replacement = clone(wanted.value)
      if (!object(replacement)) return { content: draft.content, changed: true, rejected: true }
      incoming = replacement
    } else assign(incoming, current, path, wanted)
    changed = true
  }
  return { content: changed ? JSON.stringify(incoming) : content, changed, rejected: false }
}

// A preset's structural changes held behind the unsaved bar (owner, 2026-11-01 for moves and
// deletions; 2026-11-02 for the rest: "every preset-level change that has no confirmation of its
// own waits behind the Save/Revert bar, like reorder does", a prompt's on/off switch excepted).
// Prompts moved, deleted or added and lorebooks attached or taken off wait for the bar's Save;
// text, a prompt's options and the on/off switches stay live, used by the next reply as they're
// made. They're kept as the editor's `HELD_FIELD` draft, so they're on the server like any
// typing, and never applied by drafts, a field list's Save or a reply's checkpoint.
//
// An added prompt's definition is a live draft (so its text has a place to be typed into) but
// has no place in the live order, so nothing sends it (`presetOrder` lists a prompt outside the
// order as off); its order entry, switch included, waits here. A reply's checkpoint leaves its
// definition's drafts alone (`heldPromptPaths`), so Revert still takes it away.
import type { PresetLorebook, PresetPrompt, PromptOrderEntry } from "./docs/preset.ts"
import type { FieldPath } from "./editing.ts"
import { presetOrder } from "./presetOrder.ts"

export interface HeldChanges {
  /** The order as arranged, by identifier; empty when nothing moved. */
  readonly order: ReadonlyArray<string>
  /** Prompts deleted, still in the live document until Save. */
  readonly deleted: ReadonlyArray<string>
  /** Order entries of prompts added since: their definitions are live, these wait. */
  readonly added: ReadonlyArray<PromptOrderEntry>
  /** Lorebooks attached since, in the live document only once saved. */
  readonly attached: ReadonlyArray<PresetLorebook>
  /** Lorebooks taken off, still in the live document until Save. */
  readonly detached: ReadonlyArray<string>
}

export const NO_HELD: HeldChanges = { order: [], deleted: [], added: [], attached: [], detached: [] }

const strings = (list: unknown) => (Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [])

const entries = <A extends object>(list: unknown, key: string, flag: string): ReadonlyArray<A> =>
  Array.isArray(list)
    ? list.filter(
        (x): x is A =>
          typeof x === "object" &&
          x !== null &&
          typeof (x as Record<string, unknown>)[key] === "string" &&
          typeof (x as Record<string, unknown>)[flag] === "boolean"
      )
    : []

export const parseHeld = (text: string | null): HeldChanges | null => {
  if (!text) return null
  try {
    const value = JSON.parse(text) as Record<string, unknown>
    const held: HeldChanges = {
      order: strings(value.order),
      deleted: strings(value.deleted),
      added: entries<PromptOrderEntry>(value.added, "identifier", "enabled"),
      attached: entries<PresetLorebook>(value.attached, "id", "enabled"),
      detached: strings(value.detached)
    }
    return isEmpty(held) ? null : held
  } catch {
    return null
  }
}

const isEmpty = (held: HeldChanges) =>
  held.order.length === 0 &&
  held.deleted.length === 0 &&
  held.added.length === 0 &&
  held.attached.length === 0 &&
  held.detached.length === 0

/** The draft's text: only the parts in use, empty for nothing held. */
export const heldText = (held: HeldChanges | null) => {
  if (held === null || isEmpty(held)) return ""
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(held)) if ((value as ReadonlyArray<unknown>).length > 0) out[key] = value
  return JSON.stringify(out)
}

/** The fields under these paths are an added prompt's definition, which waits for Save with it. */
export const heldPromptPaths = (held: HeldChanges | null): ReadonlyArray<FieldPath> =>
  (held?.added ?? []).map((entry) => ["prompts", `identifier=${entry.identifier}`])

/**
 * The order as shown: the live entries (with their own changes) and the added ones in the held
 * arrangement, the deleted ones out. An entry the arrangement doesn't know (added since, in
 * another tab) follows the entry before it in the live order.
 */
export function arrange(
  live: ReadonlyArray<PromptOrderEntry>,
  held: HeldChanges | null
): ReadonlyArray<PromptOrderEntry> {
  if (held === null) return live
  const deleted = new Set(held.deleted)
  const added = new Map(held.added.map((entry) => [entry.identifier, entry]))
  // An added prompt's definition makes `presetOrder` list it at the end, off: its held entry
  // takes that place, and one the arrangement doesn't place stays at the end.
  const base = [
    ...live.filter((entry) => !added.has(entry.identifier)),
    ...held.added.filter((entry) => !deleted.has(entry.identifier))
  ]
  const byId = new Map(base.map((entry) => [entry.identifier, entry]))
  const out: Array<PromptOrderEntry> = []
  for (const id of held.order) {
    const entry = byId.get(id)
    if (entry && !deleted.has(id) && !out.includes(entry)) out.push(entry)
  }
  base.forEach((entry, index) => {
    if (deleted.has(entry.identifier) || out.includes(entry)) return
    const before = base
      .slice(0, index)
      .reverse()
      .find((e) => out.includes(e))
    out.splice(before ? out.indexOf(before) + 1 : 0, 0, entry)
  })
  return out
}

/** The lorebooks as shown: the live ones less those taken off, then those attached. */
export const arrangeLorebooks = (
  live: ReadonlyArray<PresetLorebook>,
  held: HeldChanges | null
): ReadonlyArray<PresetLorebook> =>
  held === null
    ? live
    : [
        ...live.filter((book) => !held.detached.includes(book.id)),
        ...held.attached.filter((book) => !live.some((l) => l.id === book.id && !held.detached.includes(l.id)))
      ]

/** A preset document as the editor shows it, with the held changes in place. */
export function withHeld<D extends object>(doc: D, held: HeldChanges | null): D {
  if (held === null) return doc
  const record = doc as Record<string, unknown>
  const prompts = (record.prompts as ReadonlyArray<PresetPrompt> | undefined) ?? []
  const order = presetOrder(prompts, (record.order as ReadonlyArray<PromptOrderEntry> | undefined) ?? [])
  const live = (record.lorebooks as ReadonlyArray<PresetLorebook> | undefined) ?? []
  const lorebooks = arrangeLorebooks(live, held)
  return {
    ...doc,
    prompts: prompts.filter((p) => !held.deleted.includes(p.identifier)),
    order: arrange(order, held),
    ...(record.lorebooks === undefined && lorebooks.length === 0 ? {} : { lorebooks })
  }
}

/**
 * An order the user made from the shown one, split into what's live and what's held: each kept
 * live entry's own change (its switch) goes live where the live order has it, an entry for a
 * prompt added since (`added`) waits with its switch, any other entry new to the live order (a
 * prompt outside the order switched on) goes live after its nearest neighbour above that the
 * live order has, and the arrangement is held. A deleted prompt stays live until Save; one gone
 * from `next` otherwise is gone live.
 */
export function splitOrder(
  live: ReadonlyArray<PromptOrderEntry>,
  next: ReadonlyArray<PromptOrderEntry>,
  held: Pick<HeldChanges, "deleted" | "added"> & Partial<HeldChanges>
): { readonly live: ReadonlyArray<PromptOrderEntry>; readonly held: HeldChanges | null } {
  const deleted = held.deleted
  const addedIds = new Set(held.added.map((entry) => entry.identifier))
  const inNext = new Map(next.map((entry) => [entry.identifier, entry]))
  const wasLive = new Set(live.map((entry) => entry.identifier))
  const out: Array<PromptOrderEntry> = []
  for (const entry of live) {
    if (addedIds.has(entry.identifier)) continue
    const mine = inNext.get(entry.identifier)
    if (mine) out.push(mine)
    else if (deleted.includes(entry.identifier)) out.push(entry)
  }
  next.forEach((entry, index) => {
    if (wasLive.has(entry.identifier) || addedIds.has(entry.identifier)) return
    const before = next
      .slice(0, index)
      .reverse()
      .find((e) => out.some((o) => o.identifier === e.identifier))
    const at = before ? out.findIndex((o) => o.identifier === before.identifier) + 1 : 0
    out.splice(at, 0, entry)
  })
  const added = held.added.flatMap((entry) => {
    const mine = inNext.get(entry.identifier)
    return mine ? [mine] : []
  })
  // As shown without the held additions placed: where they are is part of the arrangement.
  const shown = arrange(out, { ...NO_HELD, deleted, added }).map((entry) => entry.identifier)
  const arranged = next.map((entry) => entry.identifier)
  const moved = shown.join("\n") !== arranged.join("\n")
  const result: HeldChanges = {
    order: moved ? arranged : [],
    deleted,
    added,
    attached: held.attached ?? [],
    detached: held.detached ?? []
  }
  return { live: out, held: isEmpty(result) ? null : result }
}

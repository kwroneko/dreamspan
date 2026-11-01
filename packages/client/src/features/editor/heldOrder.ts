// A preset's structural changes held behind the Prompt preset tab's unsaved bar (owner,
// 2026-11-01): prompts moved and prompts deleted, easy to do by accident, wait for the bar's
// Save, while everything else (text, switches, a prompt added, its options) is live, used by
// the next reply as it's made. They're kept as the editor's `HELD_FIELD` draft, so they're on
// the server like any typing; the live order keeps the saved positions.
import type { PromptOrderEntry } from "@rp/shared/docs/preset.ts"

export interface HeldChanges {
  /** The order as arranged, by identifier. */
  readonly order: ReadonlyArray<string>
  /** Prompts deleted, still in the live document until Save. */
  readonly deleted: ReadonlyArray<string>
}

export const parseHeld = (text: string | null): HeldChanges | null => {
  if (!text) return null
  try {
    const value = JSON.parse(text) as Partial<HeldChanges>
    const strings = (list: unknown) =>
      Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : []
    return { order: strings(value.order), deleted: strings(value.deleted) }
  } catch {
    return null
  }
}

export const heldText = (held: HeldChanges | null) =>
  held === null || (held.order.length === 0 && held.deleted.length === 0) ? "" : JSON.stringify(held)

/**
 * The order as shown: the live entries (with their own changes) in the held arrangement, the
 * deleted ones out. A live entry the arrangement doesn't know (added since, in another tab)
 * follows the entry before it in the live order.
 */
export function arrange(
  live: ReadonlyArray<PromptOrderEntry>,
  held: HeldChanges | null
): ReadonlyArray<PromptOrderEntry> {
  if (held === null) return live
  const deleted = new Set(held.deleted)
  const byId = new Map(live.map((entry) => [entry.identifier, entry]))
  const out: Array<PromptOrderEntry> = []
  for (const id of held.order) {
    const entry = byId.get(id)
    if (entry && !deleted.has(id) && !out.includes(entry)) out.push(entry)
  }
  live.forEach((entry, index) => {
    if (deleted.has(entry.identifier) || out.includes(entry)) return
    const before = live
      .slice(0, index)
      .reverse()
      .find((e) => out.includes(e))
    out.splice(before ? out.indexOf(before) + 1 : 0, 0, entry)
  })
  return out
}

/**
 * An order the user made from the shown one, split into what's live and what's held: each kept
 * entry's own change (its switch) goes live where the live order has it, an added entry goes
 * live after its nearest neighbour above that the live order has, and the arrangement is held.
 * A deleted prompt stays live until Save; one gone from `next` otherwise is gone live.
 */
export function splitOrder(
  live: ReadonlyArray<PromptOrderEntry>,
  next: ReadonlyArray<PromptOrderEntry>,
  deleted: ReadonlyArray<string>
): { readonly live: ReadonlyArray<PromptOrderEntry>; readonly held: HeldChanges | null } {
  const inNext = new Map(next.map((entry) => [entry.identifier, entry]))
  const wasLive = new Set(live.map((entry) => entry.identifier))
  const out: Array<PromptOrderEntry> = []
  for (const entry of live) {
    const mine = inNext.get(entry.identifier)
    if (mine) out.push(mine)
    else if (deleted.includes(entry.identifier)) out.push(entry)
  }
  next.forEach((entry, index) => {
    if (wasLive.has(entry.identifier)) return
    const before = next
      .slice(0, index)
      .reverse()
      .find((e) => out.some((o) => o.identifier === e.identifier))
    const at = before ? out.findIndex((o) => o.identifier === before.identifier) + 1 : 0
    out.splice(at, 0, entry)
  })
  const shown = out.filter((entry) => !deleted.includes(entry.identifier)).map((entry) => entry.identifier)
  const arranged = next.map((entry) => entry.identifier)
  const moved = shown.join("\n") !== arranged.join("\n")
  return {
    live: out,
    held: moved || deleted.length > 0 ? { order: moved ? arranged : [], deleted } : null
  }
}

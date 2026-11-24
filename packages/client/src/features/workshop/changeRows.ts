// The change rows between a workshop's turns (spec/WORKSHOP-CARDS.md §7): the library items one
// turn made or edited, one row per item however many calls changed it, with the revision pair
// its change view compares. Apart from React, so it's tested on its own.
import type { PathEntry } from "@dreamspan/shared/chat.ts"
import type { FieldChange } from "../editor/fields.ts"
import type { RolloutEffect } from "./effects.ts"

/** One item a turn changed. */
export interface ItemChange {
  /** The entity, as the effects name it. */
  readonly entityId: string
  readonly refId: string
  /** "card", "lorebook" or "preset", as the change's title names it. */
  readonly kind: string
  /** Its name when the change was made. */
  readonly label: string
  /** Made in this turn, not only edited. */
  readonly created: boolean
  /** The revision before the turn's first change; null for an item the turn made. */
  readonly from: string | null
  /** The revision after the turn's last change. */
  readonly to: string
  /** Its changes, newest first, as listed. */
  readonly effects: ReadonlyArray<RolloutEffect>
}

const TITLE = /^(?:Edited|Created) the (card|lorebook|preset) (.*)$/s

/**
 * The items a turn's changes made or edited, in the order they were first changed. A note made
 * with a card is the card's, not a row of its own; changes outside the library aren't rows.
 */
export const itemChanges = (effects: ReadonlyArray<RolloutEffect>): ReadonlyArray<ItemChange> => {
  const items = new Map<string, Array<RolloutEffect>>()
  // Oldest first, so the rows read in the order the turn made them.
  for (const effect of [...effects].reverse()) {
    if (effect.kind !== "library.create" && effect.kind !== "library.revise") continue
    if (!TITLE.test(effect.title) || typeof effect.undo?.refId !== "string") continue
    const list = items.get(effect.targetId)
    if (list) list.push(effect)
    else items.set(effect.targetId, [effect])
  }
  return [...items].map(([entityId, oldestFirst]) => {
    const first = oldestFirst[0]!
    const last = oldestFirst[oldestFirst.length - 1]!
    const [, kind, label] = TITLE.exec(first.title)!
    const created = oldestFirst.some((e) => e.kind === "library.create")
    return {
      entityId,
      refId: String(first.undo!.refId),
      kind: kind!,
      label: label!,
      created,
      from: created ? null : String(first.undo!.before),
      to: String(last.undo!.head),
      effects: [...oldestFirst].reverse()
    }
  })
}

/** The reply a change view comes from: its link back, and the changes its action undoes. */
export interface ChangeReply {
  readonly chatId: string
  /** The slot of the turn's last message, which the link back opens at. */
  readonly slotId: string
  /** The version of the turn's first message: `ListVersionEffects` of it lists the turn's changes. */
  readonly versionId: string
}

export const CHANGE_PATH = /^\/library\/([^/]+)\/change$/

/** The change view of one item and revision pair (§7.4). */
export const changeViewHref = (item: Pick<ItemChange, "refId" | "from" | "to">, reply: ChangeReply) =>
  `/library/${encodeURIComponent(item.refId)}/change?${new URLSearchParams({
    from: item.from ?? "",
    to: item.to,
    reply: reply.versionId,
    chat: reply.chatId,
    slot: reply.slotId
  }).toString()}`

/** What a change view's URL names; null when it isn't one. */
export const changeViewTarget = (url: URL) => {
  const refId = CHANGE_PATH.exec(url.pathname)?.[1]
  const to = url.searchParams.get("to")
  if (refId === undefined || !to) return null
  const reply = {
    chatId: url.searchParams.get("chat") ?? "",
    slotId: url.searchParams.get("slot") ?? "",
    versionId: url.searchParams.get("reply") ?? ""
  }
  return {
    refId: decodeURIComponent(refId),
    from: url.searchParams.get("from") || null,
    to,
    reply: reply.chatId && reply.versionId ? reply : null
  }
}

/** Every change of the item is undone: the row says so, muted. */
export const itemUndone = (item: ItemChange) => item.effects.every((e) => e.undoneAt !== null)

/**
 * The turn a message ends (§7.1): its first and last messages, when `slotId` is the last reply
 * before the next user message (or the last message shown). Null for any other message.
 */
export const turnEndingAt = (
  entries: ReadonlyArray<PathEntry>,
  slotId: string
): { readonly first: PathEntry; readonly last: PathEntry } | null => {
  const at = entries.findIndex((e) => e.slotId === slotId)
  if (at < 0) return null
  const last = entries[at]!
  if (last.side !== "assistant" || entries[at + 1]?.side === "assistant") return null
  let start = at
  while (start > 0 && entries[start - 1]!.side === "assistant") start--
  return { first: entries[start]!, last }
}

/** Above this many items a turn's rows fold into one line naming the first few. */
export const FOLD_ABOVE = 5
export const FOLD_NAMED = 3

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/**
 * The row's count (§7.2): "3 fields"; a lorebook's entries by what happened to them ("2 entries
 * added, 1 changed"), its other settings as fields.
 */
export const changeCount = (kind: string, changes: ReadonlyArray<FieldChange>) => {
  if (kind !== "lorebook") return plural(new Set(changes.map((c) => topOf(c))).size, "field")
  const entries = changes.filter((c) => c.path[0] === "entries")
  const added = entries.filter((c) => c.before === undefined).length
  const removed = entries.filter((c) => c.after === undefined).length
  const changed = new Set(
    entries.filter((c) => c.before !== undefined && c.after !== undefined).map((c) => String(c.path[1]))
  ).size
  const fields = new Set(changes.filter((c) => c.path[0] !== "entries").map((c) => topOf(c))).size
  const parts = [
    added > 0 ? `${plural(added, "entry", "entries")} added` : null,
    changed > 0 ? `${added > 0 ? changed : plural(changed, "entry", "entries")} changed` : null,
    removed > 0 ? `${added > 0 || changed > 0 ? removed : plural(removed, "entry", "entries")} removed` : null,
    fields > 0 ? plural(fields, "field") : null
  ].filter((p) => p !== null)
  return parts.length === 0 ? "no fields" : parts.join(", ")
}

/** A field is its top-level key: a card's Description, a preset's prompts as one. */
const topOf = (change: FieldChange) => String(change.path[0])

/** "Description, Scenario, First message" (the first six, then how many more). */
export const changedNames = (labels: ReadonlyArray<string>) => {
  const unique = [...new Set(labels)]
  const shown = unique.slice(0, 6).join(", ")
  return unique.length > 6 ? `${shown} and ${unique.length - 6} more` : shown
}

/**
 * Whether the item changed after the turn (§7.2), from its revisions newest first: by the user,
 * by a later reply, or not at all (null). A revision list that doesn't reach `to` is about one
 * gone far past it: changed since, by whoever made the newest.
 */
export const changedSince = (
  revisions: ReadonlyArray<{ readonly id: string; readonly origin: string }>,
  to: string
): "you" | "reply" | null => {
  const at = revisions.findIndex((r) => r.id === to)
  const later = at < 0 ? revisions : revisions.slice(0, at)
  // A reply's use of changed text cuts a revision of its own: that's not a change.
  const changes = later.filter((r) => r.origin !== "generation")
  if (changes.length === 0) return null
  return changes.some((r) => r.origin !== "agent") ? "you" : "reply"
}

// The lorebook editor's table (DESIGN §1.3, "Standalone lorebook authoring"): what its columns,
// sort orders and row actions are, as registries a plugin can add to, replace or disable
// (spec/PLUGINS.md §8). The defaults are registered in lorebookColumns.tsx.
import type { LorebookDoc, LorebookEntry, LorePosition, LoreRole } from "@dreamspan/shared/docs/lorebook.ts"
import { emptyBook, emptyEntry } from "./lorebookDefaults.ts"
import type { FieldPath } from "@dreamspan/shared/editing.ts"
import type { ComponentType } from "react"
import { makeRegistry } from "../../registry.ts"
import type { IconName } from "../../ui/Icon.tsx"
import type { EditorStore } from "./store.ts"

/** What a cell or an action gets: the entry as the store has it now, and where it is. */
export interface LorebookEntryContext {
  readonly store: EditorStore
  /** The book in the store's document: `[]` for a standalone lorebook, `["character_book"]` in a card. */
  readonly root: FieldPath
  readonly entry: LorebookEntry
  /** The entry's path: `[...root, "entries", "uid=…"]`. */
  readonly path: FieldPath
  /** Its title as typed, or "Untitled entry", for accessible names. */
  readonly title: string
}

/** A column after the title: its header, its width as a grid track, and its cell. */
export interface LorebookColumn {
  readonly id: string
  readonly order: number
  readonly header: string
  readonly description?: string
  /** A CSS grid track, e.g. "5rem". On a narrow screen cells wrap under the title instead. */
  readonly width: string
  readonly cell: ComponentType<LorebookEntryContext>
}
export const lorebookColumns = makeRegistry<LorebookColumn>()

/** What a sort reads about an entry besides the entry itself. */
export interface SortFacts {
  /** Its position in the book's list. */
  readonly index: number
  /** Its title as typed. */
  readonly title: string
  /** Whether any of its fields has changes not saved as a revision yet. */
  readonly changed: boolean
}

export interface LorebookSort {
  readonly id: string
  readonly order: number
  readonly label: string
  /** What the order is, when the label doesn't say: shown beside it in the picker. */
  readonly description?: string
  /** Smaller first; ties keep the book's order. */
  readonly compare: (a: LorebookEntry, b: LorebookEntry, facts: (entry: LorebookEntry) => SortFacts) => number
}
export const lorebookSorts = makeRegistry<LorebookSort>()

/** What an action that needs more than a click (a dialog) gets. */
export interface LorebookActionProps extends LorebookEntryContext {
  readonly book: LorebookDoc
  readonly onClose: () => void
}

/** An item in a row's ⋯ menu: runs at once, or opens its dialog. */
export interface LorebookEntryAction {
  readonly id: string
  readonly order: number
  readonly label: string
  /** What it does, when the label doesn't say: shown beside the item in the menu. */
  readonly description?: string
  readonly icon?: IconName
  readonly tone?: "danger"
  /** `reveal` shows an entry it added at the top of the table, open. */
  readonly run?: (
    context: LorebookEntryContext & { readonly book: LorebookDoc; readonly reveal: (uid: number) => void }
  ) => void
  readonly dialog?: ComponentType<LorebookActionProps>
}
export const lorebookEntryActions = makeRegistry<LorebookEntryAction>()

export const entryPath = (root: FieldPath, uid: number): FieldPath => [...root, "entries", `uid=${uid}`]

/** The uid in an entry path segment, or null. */
export const uidOf = (segment: unknown) => {
  const found = typeof segment === "string" ? /^uid=(-?\d+)$/.exec(segment) : null
  return found ? Number(found[1]) : null
}

/** A uid no entry of the book has: random, so it never reuses a removed or saved entry's. */
export const freshUid = (book: LorebookDoc | undefined) => {
  let uid: number
  do uid = crypto.getRandomValues(new Uint32Array(1))[0]!
  while (book?.entries.some((entry) => entry.uid === uid))
  return uid
}

/** A new entry: a whole-entry draft, and the book itself when a card had none. */
export const addEntry = (store: EditorStore, root: FieldPath, book: LorebookDoc | undefined) => {
  const uid = freshUid(book)
  const entry = emptyEntry(uid)
  if (!book) store.setValue(root, { ...emptyBook(), entries: [entry] })
  else store.setValue(entryPath(root, uid), entry)
  return uid
}

export type EnabledFilter = "all" | "on" | "off"

/**
 * The rows shown, in order: those matching the search (title, keys and content, as typed)
 * and the enabled filter, sorted. `pinned` (entries just added or duplicated, newest first)
 * lead whatever the search, filter or sort.
 */
export const arrangeEntries = (
  entries: ReadonlyArray<LorebookEntry>,
  options: {
    readonly query: string
    readonly enabled: EnabledFilter
    readonly sort: LorebookSort | undefined
    readonly facts: (entry: LorebookEntry, index: number) => SortFacts & { readonly content: string }
    readonly pinned?: ReadonlyArray<number>
  }
): ReadonlyArray<number> => {
  const words = options.query.toLowerCase().split(/\s+/).filter(Boolean)
  const pinned = new Set(options.pinned)
  const facts = new Map(entries.map((entry, index) => [entry, options.facts(entry, index)]))
  const shown = entries.filter((entry) => {
    if (pinned.has(entry.uid)) return true
    if (options.enabled === "on" && !entry.enabled) return false
    if (options.enabled === "off" && entry.enabled) return false
    if (words.length === 0) return true
    const own = facts.get(entry)!
    const text = [own.title, own.content, ...entry.keys, ...entry.secondary_keys].join("\n").toLowerCase()
    return words.every((word) => text.includes(word))
  })
  const sorted = options.sort
    ? [...shown].sort(
        (a, b) => options.sort!.compare(a, b, (entry) => facts.get(entry)!) || facts.get(a)!.index - facts.get(b)!.index
      )
    : shown
  const uids = sorted.map((entry) => entry.uid)
  if (pinned.size === 0) return uids
  const lead = (options.pinned ?? []).filter((uid) => uids.includes(uid))
  return [...lead, ...uids.filter((uid) => !pinned.has(uid))]
}

/**
 * ST's position names: `short` as its table shows them, `label` in the open picker, and where
 * each puts the entry when a chat lets entries go where their positions say (by default chats
 * put every entry just after the history: LorebookForm says so).
 */
export const POSITIONS: ReadonlyArray<{
  readonly value: string
  readonly position: LorePosition
  readonly role?: LoreRole
  readonly short: string
  readonly label: string
  readonly description: string
}> = [
  {
    value: "before_char",
    position: "before_char",
    short: "↑Char",
    label: "↑Char · Before the character",
    description: "Inserted at the preset's World Info (before) marker, normally before the character definitions."
  },
  {
    value: "after_char",
    position: "after_char",
    short: "↓Char",
    label: "↓Char · After the character",
    description: "Inserted at the preset's World Info (after) marker, normally right after the character definitions."
  },
  {
    value: "em_top",
    position: "em_top",
    short: "↑EM",
    label: "↑EM · Before the examples",
    description: "As example dialogue, before the character's example messages."
  },
  {
    value: "em_bottom",
    position: "em_bottom",
    short: "↓EM",
    label: "↓EM · After the examples",
    description: "As example dialogue, after the character's example messages."
  },
  {
    value: "at_depth:system",
    position: "at_depth",
    role: "system",
    short: "@D system",
    label: "@D · Depth, system",
    description: "Inserted at the chosen depth with the system role."
  },
  {
    value: "at_depth:user",
    position: "at_depth",
    role: "user",
    short: "@D user",
    label: "@D · Depth, user",
    description: "Inserted at the chosen depth with the user role."
  },
  {
    value: "at_depth:assistant",
    position: "at_depth",
    role: "assistant",
    short: "@D assistant",
    label: "@D · Depth, assistant",
    description: "Inserted at the chosen depth with the assistant role."
  },
  {
    value: "outlet",
    position: "outlet",
    short: "Outlet",
    label: "Outlet",
    description: "Sent only where a prompt has {{outlet::its outlet name}}. Not yet: chats don't fill outlets."
  }
]

/** The position picker's value for an entry: at a depth, its role says which. */
export const positionValue = (entry: Pick<LorebookEntry, "position" | "role">) =>
  entry.position === "at_depth" ? `at_depth:${entry.role}` : entry.position

/** ST's strategies: constant (always in), normal (on a key match), vectorized (by similarity). */
export type Strategy = "constant" | "normal" | "vectorized"
export const strategyOf = (entry: Pick<LorebookEntry, "constant" | "vectorized">): Strategy =>
  entry.constant ? "constant" : entry.vectorized ? "vectorized" : "normal"

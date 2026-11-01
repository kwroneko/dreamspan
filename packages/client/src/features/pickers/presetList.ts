// What a preset list shows, in which order (the owner, 2026-11-01): a text filter, then one of
// four views. Name (A–Z), Last modified and Last used list the presets that aren't archived;
// Archived lists only the archived ones, the most recently archived first. Pure, so the picker,
// the library and the tests share it.
import type { PresetSort } from "@rp/shared/chatApi.ts"
import type { LibraryRef } from "@rp/shared/library.ts"
import { formatAgo as ago } from "../characters/data.ts"

export type PresetView = PresetSort | "archived"

export const PRESET_VIEWS: ReadonlyArray<{
  readonly value: PresetView
  readonly label: string
  readonly hint: string
}> = [
  { value: "name", label: "Name", hint: "Sort by name, A to Z" },
  { value: "modified", label: "Modified", hint: "Sort by when each was last edited, latest first" },
  { value: "used", label: "Used", hint: "Sort by when each last wrote a reply, latest first" },
  { value: "archived", label: "Archived", hint: "Only archived presets, the most recently archived first" }
]

/** Case and accents don't matter: "cafe" finds "Café". */
export const fold = (text: string) => text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()

const byName = (a: LibraryRef, b: LibraryRef) =>
  a.label.localeCompare(b.label) || a.subtitle.localeCompare(b.subtitle) || a.id.localeCompare(b.id)

/** Latest first; never (null) after every time, by name among themselves. */
const latest = (at: (ref: LibraryRef) => number | null | undefined) => (a: LibraryRef, b: LibraryRef) =>
  (at(b) ?? -Infinity) - (at(a) ?? -Infinity) || byName(a, b)

const ORDER: Record<PresetView, (a: LibraryRef, b: LibraryRef) => number> = {
  name: byName,
  modified: latest((ref) => ref.updatedAt),
  used: latest((ref) => ref.lastUsedAt),
  archived: latest((ref) => ref.archivedAt)
}

const matchesPreset = (ref: LibraryRef, query: string) => {
  const q = fold(query.trim())
  return q === "" || fold(ref.label).includes(q) || fold(ref.subtitle).includes(q)
}

/**
 * The presets a view lists, filtered by the text, in its order. `live` and `archived` are the
 * library's two lists; an entry in both (a list read mid-change) counts where `archivedAt` puts it.
 */
export function presetsInView(
  view: PresetView,
  query: string,
  live: ReadonlyArray<LibraryRef>,
  archived: ReadonlyArray<LibraryRef>
): ReadonlyArray<LibraryRef> {
  const all = new Map<string, LibraryRef>()
  for (const ref of [...live, ...archived]) all.set(ref.id, ref)
  return [...all.values()]
    .filter((ref) => (view === "archived") === isArchived(ref) && matchesPreset(ref, query))
    .sort(ORDER[view])
}

export const isArchived = (ref: LibraryRef) => ref.archivedAt != null

/**
 * A plain select's presets: those not archived, and the chosen one though archived, marked so
 * (Settings → Chats, a connection's locked preset).
 */
export const selectablePresets = (
  live: ReadonlyArray<LibraryRef>,
  archived: ReadonlyArray<LibraryRef>,
  chosen: string | null
) => [
  ...live.map((ref) => ({ value: ref.id as string, label: ref.label })),
  ...archived
    .filter((ref) => ref.id === chosen)
    .map((ref) => ({ value: ref.id as string, label: `${ref.label} (archived)` }))
]

const exact = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" })
export const exactTime = (at: number) => exact.format(at)

/**
 * The muted line under a preset's name: when it was edited, and in the views that sort by
 * something else, that first ("used 2 hours ago · edited 3 days ago").
 */
export function presetDetail(ref: LibraryRef, view: PresetView, now = Date.now()) {
  const edited = `edited ${ago(ref.updatedAt, now)}`
  if (view === "used")
    return `${ref.lastUsedAt == null ? "never used" : `used ${ago(ref.lastUsedAt, now)}`} · ${edited}`
  if (ref.archivedAt != null) return `archived ${ago(ref.archivedAt, now)} · ${edited}`
  return edited
}

/** The exact times behind the line, for its tooltip. */
export function presetTimes(ref: LibraryRef) {
  return [
    `Edited ${exactTime(ref.updatedAt)}`,
    ref.lastUsedAt == null ? "Not used for a reply yet" : `Last used ${exactTime(ref.lastUsedAt)}`,
    ...(ref.archivedAt == null ? [] : [`Archived ${exactTime(ref.archivedAt)}`])
  ]
}

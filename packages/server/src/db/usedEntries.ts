// The library entries an assembly read (owner, 2026-11-01: live text is what's sent), a reply's
// or a summary's, for `CheckpointLiveText` to cut revisions of their live text.
import type { ContextSnapshot } from "../assembler/types.ts"
import type { UsedEntry } from "./ops.ts"

/**
 * The library entries an assembly read, each once: the preset, the cards, the lorebooks, the
 * notes and the shared notes they show, each with the revision read.
 */
export const usedEntries = (snapshot: ContextSnapshot): ReadonlyArray<UsedEntry> => {
  const used = new Map<string, UsedEntry>()
  const add = (entity: string, ref: string | null, revision: string | null) => {
    if (revision === null) return
    used.set(`${entity}\n${ref ?? ""}\n${revision}`, { entity, ref, revision })
  }
  const { preset, cards } = snapshot.inputs
  if (preset.ref !== null) add("", preset.ref, preset.revision)
  for (const card of cards) add(card.entity, card.ref, card.revision)
  const pins = snapshot.sources
  for (const read of pins?.cards ?? []) for (const card of read.found) add(card.entity, card.ref, card.revision)
  for (const read of pins?.lorebooks ?? []) for (const book of read.found) add(book.entity, book.id, book.revision)
  for (const read of pins?.notes ?? [])
    for (const note of read.found) {
      add(note.entity, null, note.revision)
      if (note.link) add(note.link.entity, null, note.link.revision)
    }
  return [...used.values()]
}

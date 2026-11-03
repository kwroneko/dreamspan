import type { LorebookEntry } from "./docs/lorebook.ts"

/** ST applies the name and tag gates separately, against the current speaker. */
export const characterFilterPasses = (
  filter: LorebookEntry["character_filter"],
  speaker: { readonly entity: string; readonly name?: string; readonly tags?: ReadonlyArray<string> } | undefined
) => {
  if (!filter) return true
  const cards = filter.cards ?? []
  if (cards.length || filter.names.length) {
    const included =
      cards.some((card) => card.entity === speaker?.entity) ||
      (speaker?.name !== undefined && filter.names.includes(speaker.name))
    if (filter.is_exclude ? included : !included) return false
  }
  // ST bypasses the tag gate when there is no mapped array. An empty array does filter.
  if (filter.tags.length && speaker?.tags !== undefined) {
    const included = speaker.tags.some((tag) => filter.tags.includes(tag))
    if (filter.is_exclude ? included : !included) return false
  }
  return true
}

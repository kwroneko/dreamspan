import type { LorebookDoc } from "@dreamspan/shared/docs/lorebook.ts"
import type { StLoreMapping } from "../importer/ops.ts"

/** Resolve installation-local ST identities before the imported revision is stored. */
export const mapLorebookFilters = (book: LorebookDoc, mapping: StLoreMapping): LorebookDoc => ({
  ...book,
  entries: book.entries.map((entry) => {
    const filter = entry.character_filter
    if (!filter) return entry
    const cards = (filter.cards ?? []).map((card) => ({ ...card, entity: mapping.cards[card.name] ?? card.entity }))
    const names = filter.names.filter((name) => {
      const entity = mapping.cards[name]
      if (entity === undefined) return true
      if (!cards.some((card) => card.entity === entity)) cards.push({ entity, name })
      return false
    })
    const tagIds = { ...filter.tag_ids }
    const tags = filter.tags.map((id) => {
      const name = mapping.tags[id]
      if (name === undefined) return id
      tagIds[name] = id
      return name
    })
    return {
      ...entry,
      character_filter: {
        ...filter,
        names,
        ...(cards.length || filter.cards !== undefined ? { cards } : {}),
        tags,
        ...(Object.keys(tagIds).length ? { tag_ids: tagIds } : {})
      }
    }
  })
})

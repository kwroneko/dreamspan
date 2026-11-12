import type { LorebookEntry } from "@rp/shared/docs/lorebook.ts"

export { lorebookFields, standaloneLorebookFields } from "@rp/shared/libraryText.ts"

/** Whether an entry's title, keys or text contain the filter, ignoring case. */
export const entryMatches = (entry: LorebookEntry, filter: string) => {
  const needle = filter.trim().toLowerCase()
  if (needle === "") return true
  return [entry.comment, entry.content, ...entry.keys, ...entry.secondary_keys].some((text) =>
    text.toLowerCase().includes(needle)
  )
}

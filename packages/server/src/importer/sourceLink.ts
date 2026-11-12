// A card's link back to the page it came from (a card source's page for the card, spec/CARD-SOURCES.md
// §4.5): added to its CCv3 `source` list unless it's there. Adding a card from a source adds it,
// and so does each newer version of that card taken from the source (§3.8), so a newer file,
// which doesn't name it, never reads as removing it.
import { docHash, searchText } from "../db/documents.ts"

export const withSourceLink = <
  L extends { readonly docJson: string; readonly docHash: string; readonly searchText: string }
>(
  library: L,
  link: string
): L => {
  const doc = JSON.parse(library.docJson) as Record<string, unknown>
  const sources = Array.isArray(doc.source) ? doc.source.filter((s): s is string => typeof s === "string") : []
  if (sources.includes(link)) return library
  const stored = { ...doc, source: [...sources, link] }
  return {
    ...library,
    docJson: JSON.stringify(stored),
    docHash: docHash(stored as never),
    searchText: searchText(stored)
  }
}

/**
 * A standalone lorebook from a card source (§3.9), named as the source lists it: a World Info
 * file names no lorebook, so the importer names it after its file, which a source names by its
 * id. A name the file itself gives is kept.
 */
export const withSourceName = <
  L extends { readonly label: string; readonly docJson: string; readonly docHash: string; readonly searchText: string }
>(
  library: L,
  name: string,
  fileBase: string
): L => {
  const doc = JSON.parse(library.docJson) as Record<string, unknown>
  if (!name || (doc.name !== fileBase && doc.name !== "")) return library
  const stored = { ...doc, name }
  return {
    ...library,
    label: name,
    docJson: JSON.stringify(stored),
    docHash: docHash(stored as never),
    searchText: searchText(stored)
  }
}

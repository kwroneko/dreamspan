// Which world file replaces a card's own lorebook. The assembler and the chat's Lorebooks tab both
// ask here, so the tab shows what is read.

/** A world file's name: the last part of the path it was imported from, without ".json". */
export const bookSourceName = (path: string | null | undefined): string | null =>
  path
    ?.replaceAll("\\", "/")
    .split("/")
    .at(-1)
    ?.replace(/\.json$/i, "") ?? null

/**
 * The read book that replaces a card's own: the one linked to the card (`binding`), or, when the
 * chat holds no link for the card (undefined; null is an explicit "none"), the one whose file name
 * is the card's world (`extensions.world`). Null when the card's own book is used.
 */
export const replacingBook = (
  binding: string | null | undefined,
  world: unknown,
  books: ReadonlyArray<{ readonly id: string; readonly sourceName?: string | null | undefined }>
): string | null =>
  books.find(
    (book) =>
      binding === book.id ||
      (binding === undefined &&
        typeof book.sourceName === "string" &&
        book.sourceName !== "" &&
        world === book.sourceName)
  )?.id ?? null

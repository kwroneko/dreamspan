/**
 * Estimated retained characters of a flat planning row. Count every string, including
 * error/audience/image metadata and ids; the allowance covers scalar fields and references.
 * This is cache accounting, not a byte-exact bound on V8's heap or mapped SQLite pages.
 */
export const factRowCharacters = (row: object): number =>
  Object.values(row).reduce<number>((n, value) => n + (typeof value === "string" ? value.length : 0) + 32, 64)

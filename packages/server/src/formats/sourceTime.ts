/** A source timestamp that fits both a JS Date and SQLite integer milliseconds. */
export const sourceTime = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 8.64e15 ? Math.trunc(value) : null

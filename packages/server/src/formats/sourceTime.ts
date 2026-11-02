/** A source timestamp that fits both a JS Date and SQLite integer milliseconds. */
export const sourceTime = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 8.64e15 ? Math.trunc(value) : null

/** ST generates persona filenames and group ids with Date.now(), in milliseconds. */
export const stIdTime = (value: string): number | null => {
  const match = /^(\d{13})(?:$|[-.])/.exec(value)
  return match ? sourceTime(Number(match[1])) : null
}

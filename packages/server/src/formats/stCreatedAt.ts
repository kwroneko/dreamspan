/** ST's installation-local create_date; distinct from CCv3 data.creation_date. */
export const parseStCreatedAt = (value: unknown): number | null => {
  if (typeof value === "number") {
    const at = new Date(value).getTime()
    return Number.isFinite(at) && at >= 0 ? at : null
  }
  if (typeof value !== "string" || value.trim() === "") return null
  const text = value.trim()
  if (/^\d+$/.test(text)) return parseStCreatedAt(Number(text))
  const compact = /^(\d{4})-(\d{1,2})-(\d{1,2})\s*@\s*(\d{1,2})h\s*(\d{1,2})m\s*(\d{1,2})s(?:\s*(\d{1,3})ms)?$/.exec(
    text
  )
  if (compact) {
    const [, y, m, d, h, min, sec, ms] = compact
    const date = new Date(
      Date.UTC(Number(y), Number(m) - 1, Number(d), Number(h), Number(min), Number(sec), Number(ms ?? 0))
    )
    return date.getUTCFullYear() === Number(y) &&
      date.getUTCMonth() === Number(m) - 1 &&
      date.getUTCDate() === Number(d) &&
      Number(h) < 24 &&
      Number(min) < 60 &&
      Number(sec) < 60
      ? date.getTime()
      : null
  }
  const human =
    /^(?:January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4} \d{1,2}:\d{2}\s*(?:am|pm)$/i.test(
      text
    )
  const parsed = Date.parse(text.replace(/(\d)(am|pm)$/i, "$1 $2") + (human ? " UTC" : ""))
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

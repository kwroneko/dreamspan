// How a chat is named in lists and headers (DESIGN §2.1: never a file name, never just the
// first character's name). Chats imported from ST carry ST's file name as their title,
// "<card> - 2026-5-11@07h51m55s691ms" or "<group>: <date>"; those show the card or group
// name, with the date they were started beside it.

const ST_STAMP =
  /^(.*?)(?: - |: |)(\d{4})-(\d{1,2})-(\d{1,2})\s*@(\d{2})h(\d{2})m(\d{2})s(\d{1,3})ms(?: - Branch #\d+)?$/

export interface ChatName {
  readonly name: string
  /** When ST started it, from its file name; null for chats made here. */
  readonly started: Date | null
}

export const chatName = (title: string, cast: ReadonlyArray<{ readonly name: string }>): ChatName => {
  const match = ST_STAMP.exec(title.trim())
  const castNames = cast.map((card) => card.name).join(", ")
  if (match) {
    const [, name, y, mo, d, h, mi, s] = match
    const started = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)))
    return { name: name!.trim() || castNames || "Chat", started }
  }
  return { name: title.trim() || castNames || "New chat", started: null }
}

const dayFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" })
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" })
const shortFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" })

export const formatDay = (date: Date) => dayFormat.format(date)

/** "14:05" today, "Mar 4" this year, "Mar 4, 2025" before. */
export const formatWhen = (at: number, now = Date.now()) => {
  const date = new Date(at)
  const today = new Date(now)
  if (date.toDateString() === today.toDateString()) return timeFormat.format(date)
  if (date.getFullYear() === today.getFullYear()) return shortFormat.format(date)
  return dayFormat.format(date)
}

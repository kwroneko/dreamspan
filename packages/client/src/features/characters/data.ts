// Readable usage labels shared by the legacy card and group detail pages.
interface Used {
  readonly chats: number
  readonly lastMessageAt: number | null
}
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" })

/** "5 minutes ago", "yesterday", "3 weeks ago", "last year". */
export const formatAgo = (at: number, now = Date.now()) => {
  const elapsed = now - at
  if (elapsed < 60_000) return "just now"
  // Days count calendar days, so last night is "yesterday" this morning.
  const days = Math.round((new Date(now).setHours(0, 0, 0, 0) - new Date(at).setHours(0, 0, 0, 0)) / 86_400_000)
  if (days === 0) {
    const hours = Math.floor(elapsed / 3_600_000)
    return hours === 0 ? relative.format(-Math.floor(elapsed / 60_000), "minute") : relative.format(-hours, "hour")
  }
  if (days < 7) return relative.format(-days, "day")
  if (days < 30) return relative.format(-Math.floor(days / 7), "week")
  if (days < 365) return relative.format(-Math.floor(days / 30), "month")
  return relative.format(-Math.floor(days / 365), "year")
}

const chatCount = (card: Used) => `${card.chats.toLocaleString()} chat${card.chats === 1 ? "" : "s"}`

/** "12 chats · last chatted 3 days ago", or "Never used". */
export const usageLine = (card: Used, now = Date.now()) => {
  if (card.chats === 0) return "Never used"
  return card.lastMessageAt === null
    ? chatCount(card)
    : `${chatCount(card)} · last chatted ${formatAgo(card.lastMessageAt, now)}`
}

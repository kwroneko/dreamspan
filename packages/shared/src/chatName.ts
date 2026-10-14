// How a chat is named (DESIGN §2.1: never a file name, never just the first character's
// name), shared so the server groups chats by the name the client shows. Chats imported from
// ST carry ST's file name as their title, "<card> - 2026-5-11@07h51m55s691ms" or
// "<group>: <date>"; those are named by the card or group, with the day they were started.

const ST_STAMP =
  /^(.*?)(?: - |: |)(\d{4})-(\d{1,2})-(\d{1,2})\s*@(\d{2})h(\d{2})m(\d{2})s(\d{1,3})ms(?: - Branch #\d+)?$/

export interface ChatName {
  readonly name: string
  /** When ST started it, from its file name; null for chats made here. */
  readonly started: Date | null
}

/** A chat's readable name from its title (without the unfinished-import mark), else its cast's names. */
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

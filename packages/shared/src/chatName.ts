// How a chat is named (DESIGN §2.1: never a file name, never just the first character's
// name), shared so the server groups chats by the name the client shows. Chats imported from
// ST carry ST's file name as their title, "<card> - 2026-5-11@07h51m55s691ms" or
// "<group>: <date>"; those are named by their characters (a card's chat) or the group, with
// the day they were started (owner, 2026-11-02). A chat the user named in ST has that name.

// ST's humanized date: `2026-05-11@07h51m55s691ms` now, `2024-9-10 @13h 44m 41s 16ms` in
// ST before late 2024 (unpadded, with spaces).
const ST_STAMP =
  /^(.*?)(?: - |: |)(\d{4})-(\d{1,2})-(\d{1,2})\s*@\s*(\d{1,2})h\s*(\d{1,2})m\s*(\d{1,2})s\s*(\d{1,3})ms(?: - Branch #\d+)?$/

export interface ChatName {
  readonly name: string
  /**
   * When ST started a chat imported from it: the chat's `createdAt` when the caller has it (its
   * ST header's date, else its first message's time), else its file name's date; null for a
   * chat made here. The file name's date can be stale: ST names a card's first chat by
   * the card's `chat` field, which a downloaded card brings from its maker's ST.
   */
  readonly started: Date | null
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

/** A chat's readable name from its title (without the unfinished-import mark), else its cast's names. */
export const chatName = (
  title: string,
  cast: ReadonlyArray<{ readonly name: string }>,
  createdAt: number | null = null
): ChatName => {
  const match = ST_STAMP.exec(title.trim())
  const castNames = cast.map((card) => card.name).join(", ")
  if (match) {
    const [, name, y, mo, d, h, mi, s] = match
    const started =
      createdAt === null
        ? new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)))
        : new Date(createdAt)
    // Only a stamp (owner, 2026-11-02): ST's own "<card> - <stamp>" says no more than a bare
    // stamp, so both are named by the chat's characters. Any other name before the stamp is
    // one the user gave (a group's name, or a rename here, which keeps the stamp).
    const prefix = name!.trim()
    const automatic = prefix === "" || cast.some((card) => sameName(card.name, prefix))
    return { name: (automatic ? castNames || prefix : prefix) || "Chat", started }
  }
  return { name: title.trim() || castNames || "New chat", started: null }
}

/** The date part of an ST file name, with its separator: what a rename keeps. */
const ST_TAIL =
  /(?: - |: |)(\d{4}-\d{1,2}-\d{1,2}\s*@\s*\d{1,2}h\s*\d{1,2}m\s*\d{1,2}s\s*\d{1,3}ms(?: - Branch #\d+)?)$/

/** A name as typed, on one line: runs of white space (new lines too) become one space. */
export const cleanName = (name: string) => name.replace(/\s+/gu, " ").trim()

/**
 * The title a chat gets when the user names it: the name, and for a chat imported from ST the
 * day ST started it, kept from its file name so lists still say when it began. An empty
 * name gives the chat its automatic name back (its cast's names). The unfinished-import
 * mark goes: the import leaves a renamed chat's title alone.
 */
export const renamedTitle = (title: string, name: string) => {
  const clean = cleanName(name)
  const tail = ST_STAMP.test(title.trim()) ? ST_TAIL.exec(title.trim())?.[1] : undefined
  if (tail === undefined) return clean
  return clean === "" ? tail : `${clean} - ${tail}`
}

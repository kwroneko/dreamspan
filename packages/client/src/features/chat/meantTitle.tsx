// The rename a new chat's page means for its chat: the title typed on the Chats page's start card
// (DraftChatPage.tsx's TitledDraftChatPage). Kept in this browser tab by the chat's id until it's
// seen through, so it's finished wherever the chat shows here next: its new-chat page after a
// reload, or the chat's own page once a first turn started it before the title was read
// (rev-dd4a #6).
import type { ChatId } from "@dreamspan/shared/chat.ts"
import { useEffect, useLayoutEffect, useRef } from "react"
import { useCaller } from "../editor/caller.ts"
import { useUserDraft } from "../editor/userDraft.tsx"

/**
 * `name` (null: the start card's title, not read yet when the chat opened, rev-dd3 #8), the
 * title it replaces, `from`, so a retry after another rename leaves that one (#9), and the start
 * card's title draft, `titleKey`, which ends once its title is the chat's.
 */
export interface MeantTitle {
  readonly name: string | null
  readonly from: string
  readonly titleKey?: string
}

/** Read (`intent` undefined), kept, or done (null). */
export const meantTitle = (chatId: string, intent?: MeantTitle | null): MeantTitle | null => {
  const key = `dreamspan.meantTitle:${chatId}`
  try {
    if (intent === undefined) {
      const kept: unknown = JSON.parse(sessionStorage.getItem(key) ?? "null")
      return typeof kept === "object" && kept !== null && "from" in kept ? (kept as MeantTitle) : null
    }
    if (intent === null) sessionStorage.removeItem(key)
    else sessionStorage.setItem(key, JSON.stringify(intent))
  } catch {
    // Storage unavailable: a reload before the rename leaves the chat its default title.
  }
  return null
}

/**
 * Sees through the rename kept for `chatId` (none: nothing), reading the start card's title
 * (`titleKey`) first when it wasn't read yet. `onNamed`: the title read.
 */
export function FinishMeantTitle({
  chatId,
  titleKey,
  onNamed
}: {
  chatId: ChatId | null
  titleKey: string
  onNamed?: (name: string) => void
}) {
  const title = useUserDraft(titleKey, "Title", "")
  const call = useCaller()
  // What the start card holds when the rename's answer comes.
  const latest = useRef(title)
  useLayoutEffect(() => {
    latest.current = title
  })
  // Sent once per chat shown: a retry is the next time it shows.
  const sent = useRef<string | null>(null)
  useEffect(() => {
    if (chatId === null || sent.current === chatId) return
    const kept = meantTitle(chatId)
    if (kept === null) return
    let name = kept.name
    if (name === null) {
      if (!title.ready) return
      name = title.text.trim()
      onNamed?.(name)
    }
    if (name === "") return void meantTitle(chatId, null)
    const meant = name
    sent.current = chatId
    meantTitle(chatId, { ...kept, name: meant })
    void call((client) => client("RenameChat", { chatId, name: meant, from: kept.from })).then((result) => {
      // Not reached (offline, say): kept for the next time the chat shows here.
      if (!result.ok && result.error.tag !== "EditRefused") return
      meantTitle(chatId, null)
      // The start card's title ends once it's the chat's, and only then: refused (another rename
      // came first, which stays), it stays on the card for the next new chat (rev-dd4a #4).
      const card = latest.current
      if (result.ok && card.ready && card.text.trim() === meant) void card.commit(card.text, async () => true)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per chat, when the title is read
  }, [chatId, title.ready])
  return null
}

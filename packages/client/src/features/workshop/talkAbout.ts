// "Talk about this chat" in a story's ⋯ menu (spec/WORKSHOP.md §4): opens the Workshop tab on the
// newest workshop beside the story; with none yet, on a new one's composer, which the first
// message makes (owner, 2026-11-17: "The chat is created when the first message is sent").
import type { ChatCommandContext } from "../chat/commands.tsx"
import { showToast } from "../../ui/Toast.tsx"
import { sideChatSearch, SIDE_CHAT_TAB } from "./sideChat.ts"

export async function talkAbout({ session, navigate }: ChatCommandContext) {
  const listed = await session.call((client) => client("ListAttachedWorkshops", { chatId: session.id }))
  if (!listed.ok)
    return showToast({ title: `The workshops beside this chat couldn't be read: ${listed.error.message}` })
  const id = listed.value[0]?.id ?? ""
  void navigate?.({
    to: ".",
    search: (prev: Record<string, unknown>) => ({ ...sideChatSearch(prev, id), panel: SIDE_CHAT_TAB }),
    state: (prev) => ({ ...prev, chatPanel: true }),
    resetScroll: false
  })
}

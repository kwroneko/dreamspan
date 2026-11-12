// "Talk about this chat" in a story's ⋯ menu (spec/WORKSHOP.md §4): opens the Workshop tab on the
// newest workshop beside the story, starting one when there's none yet.
import type { ChatCommandContext } from "../chat/commands.tsx"
import { showToast } from "../../ui/Toast.tsx"
import { sideChatSearch, SIDE_CHAT_TAB } from "./sideChat.ts"

export async function talkAbout({ session, navigate }: ChatCommandContext) {
  const listed = await session.call((client) => client("ListAttachedWorkshops", { chatId: session.id }))
  if (!listed.ok)
    return showToast({ title: `The workshops beside this chat couldn't be read: ${listed.error.message}` })
  let target = listed.value[0]
  if (target === undefined) {
    const made = await session.call((client) => client("CreateWorkshop", { attachTo: session.id }))
    if (!made.ok) return showToast({ title: `The workshop couldn't be started: ${made.error.message}` })
    target = made.value
  }
  const id = target.id
  void navigate?.({
    to: ".",
    search: (prev: Record<string, unknown>) => ({ ...sideChatSearch(prev, id), panel: SIDE_CHAT_TAB }),
    state: (prev) => ({ ...prev, chatPanel: true }),
    resetScroll: false
  })
}

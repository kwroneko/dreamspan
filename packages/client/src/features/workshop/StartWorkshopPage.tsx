// /new/workshop: a new workshop, the same page as a new roleplay chat (DraftChatPage.tsx; owner,
// 2026-11-17: "The chat is created when the first message is sent"). The server opens it as a
// pending chat with the assistant and persona chosen (the URL's `workshopCard`, `workshopPersona`,
// as the Chats page's start card sets them), so its greeting is a message, its header, composer,
// strip and panels are the saved workshop's, and the first send starts it in place, moving nothing
// (spec/WORKSHOP-CARDS.md §3). The assistant and persona change there as in any chat: the Cast
// tab and the speaker chip. The title typed on the start card names it.
import { TitledDraftChatPage } from "../chat/DraftChatPage.tsx"
import { useWorkshopStart } from "./StartCard.tsx"
import { NEW_WORKSHOP_TITLE } from "./workshopStart.ts"

export function StartWorkshopPage() {
  const { card, persona } = useWorkshopStart()
  return (
    <TitledDraftChatPage
      draftFor={`workshop:${card}:${persona}`}
      titleKey={NEW_WORKSHOP_TITLE}
      pageTitle="New workshop"
    />
  )
}

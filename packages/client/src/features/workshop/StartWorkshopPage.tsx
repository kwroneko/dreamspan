// /new/workshop: a new workshop, the same page as a new roleplay chat (DraftChatPage.tsx; owner,
// 2026-11-17: "The chat is created when the first message is sent"). The server opens it as a
// pending chat with the assistant and persona chosen (the URL's `workshopCard`, `workshopPersona`,
// as the Chats page's start card sets them), so its greeting is a message, its header, composer,
// strip and panels are the saved workshop's, and the first send starts it in place, moving nothing
// (spec/WORKSHOP-CARDS.md §3). The assistant and persona change there as in any chat: the Cast
// tab and the speaker chip. The title typed on the start card names it.
//
// "Work on in a workshop" → A new workshop opens it with the items in the URL (`workshopAttach`):
// they go into its composer as the saved composer's attachments (`composer_library` on its
// draft), so a reload keeps them and the first send carries them; the URL then drops them.
import { useSearch } from "@tanstack/react-router"
import { useEffect, useRef } from "react"
import { usePlaceParam } from "../../usePlaceParam.ts"
import { useLiveLibraryComposers } from "../chat/libraryAttachments.tsx"
import { DRAFT_PARAM, TitledDraftChatPage } from "../chat/DraftChatPage.tsx"
import { useWorkshopStart } from "./StartCard.tsx"
import { NEW_WORKSHOP_TITLE, WORKSHOP_ATTACH_KEY } from "./workshopStart.ts"

export function StartWorkshopPage() {
  const { card, persona } = useWorkshopStart()
  const [attachParam, setAttach] = usePlaceParam(WORKSHOP_ATTACH_KEY, "")
  const search = useSearch({ strict: false }) as Record<string, unknown>
  const draft = typeof search[DRAFT_PARAM] === "string" ? (search[DRAFT_PARAM] as string) : ""
  const composers = useLiveLibraryComposers()
  const composer = draft === "" ? undefined : composers.find((live) => live.chatId === draft)
  // Handed over once, when the new workshop's composer is there.
  const handed = useRef(false)
  useEffect(() => {
    if (handed.current || composer === undefined) return
    const ids = attachParam.split(",").filter((id) => id !== "")
    if (ids.length === 0) return
    handed.current = true
    composer.add(ids)
    setAttach("", true)
  }, [composer, attachParam, setAttach])
  return (
    <TitledDraftChatPage
      draftFor={`workshop:${card}:${persona}`}
      titleKey={NEW_WORKSHOP_TITLE}
      pageTitle="New workshop"
    />
  )
}

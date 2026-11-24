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
import type { ChatId } from "@dreamspan/shared/chat.ts"
import { uuidv7 } from "@dreamspan/shared/id.ts"
import { useSearch } from "@tanstack/react-router"
import { useEffect, useLayoutEffect, useRef } from "react"
import { usePlaceParam } from "../../usePlaceParam.ts"
import { useLiveLibraryComposers } from "../chat/libraryAttachments.tsx"
import { DRAFT_PARAM, TitledDraftChatPage } from "../chat/DraftChatPage.tsx"
import { useWorkshopStart } from "./StartCard.tsx"
import { NEW_WORKSHOP_TITLE, WORKSHOP_ATTACH_KEY } from "./workshopStart.ts"

/** Bind the operation in the same URL write that first names the draft. */
function bindHandover(search: Record<string, unknown>, chatId: ChatId) {
  const refs = search[WORKSHOP_ATTACH_KEY]
  if (typeof refs !== "string" || refs === "" || refs.includes(":")) return search
  const original = search[DRAFT_PARAM]
  // An older URL that already names a draft might have made the write. Treat it as a carry.
  const binding = typeof original === "string" && original !== "" ? `${original}:` : `${chatId}:${uuidv7()}`
  return { ...search, [WORKSHOP_ATTACH_KEY]: `${binding}:${refs}` }
}

export function StartWorkshopPage() {
  const { card, persona } = useWorkshopStart()
  const [attachParam, setAttach] = usePlaceParam(WORKSHOP_ATTACH_KEY, "")
  const search = useSearch({ strict: false }) as Record<string, unknown>
  const draft = typeof search[DRAFT_PARAM] === "string" ? (search[DRAFT_PARAM] as string) : ""
  const composers = useLiveLibraryComposers()
  const composer = draft === "" ? undefined : composers.find((live) => live.chatId === draft)
  // Handed over once per workshop and items, when its composer is there: a workshop opened in
  // place of one swept meanwhile gets them too (rev-dd3 #5). The URL keeps them until the server
  // has them on that draft, so a reload before that hands them over again; an answer for a
  // workshop or items the page no longer shows leaves the URL as it is.
  const handed = useRef<string | null>(null)
  const current = useRef("")
  useLayoutEffect(() => {
    current.current = `${draft}|${attachParam}`
  })
  const shown = useRef(true)
  useEffect(() => {
    shown.current = true
    return () => {
      shown.current = false
    }
  }, [])
  useEffect(() => {
    const handoff = `${draft}|${attachParam}`
    if (handed.current === handoff || composer === undefined) return
    const [originChatId, operationId, refs] = attachParam.split(":")
    const ids = (refs ?? attachParam).split(",").filter((id) => id !== "")
    if (ids.length === 0) return
    handed.current = handoff
    const transfer = operationId
      ? { handover: { originChatId: originChatId as ChatId, operationId } }
      : { carriedFrom: refs === undefined ? draft : originChatId! }
    void composer.add(ids, transfer).then((ok) => {
      if (ok && shown.current && current.current === handoff) setAttach("", true)
    })
  }, [composer, draft, attachParam, setAttach])
  return (
    <TitledDraftChatPage
      draftFor={`workshop:${card}:${persona}`}
      titleKey={NEW_WORKSHOP_TITLE}
      pageTitle="New workshop"
      prepareSearch={bindHandover}
    />
  )
}

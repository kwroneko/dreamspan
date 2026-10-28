// Card data and actions stay in their feature; the panel host only sees its descriptor.
import { useMemo } from "react"
import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import type { EntityId } from "@rp/shared/chat.ts"
import { AppClient } from "../../rpc.ts"
import { CharacterPanel } from "../characters/CharacterPanel.tsx"
import { ChatCardActions } from "./presentation.tsx"
import type { ChatSession, ChatView } from "./session.ts"
import { useIsPanelTab, type PanelProps } from "./panels.tsx"

export function CharacterTab({ session, view, tab, onNotes }: PanelProps) {
  const entityId = tab.slice(5) as EntityId
  return <ChatCharacterPanel session={session} view={view} entityId={entityId} onNotes={() => onNotes(entityId)} />
}

function ChatCharacterPanel({
  session,
  view,
  entityId,
  onNotes
}: {
  session: ChatSession
  view: ChatView
  entityId: EntityId
  onNotes: () => void
}) {
  const notesPanel = useIsPanelTab("notes", view)
  const card = view.cast?.participants.includes(entityId)
    ? view.cast.cards.find((item) => item.entityId === entityId)
    : undefined
  const live = card !== undefined && !card.inBin
  const query = useMemo(
    () =>
      AppClient.query(
        "ListChatCards",
        { chatId: session.id, slotId: view.leafSlotId, forkId: view.forkId, entityIds: live ? [entityId] : [] },
        { reactivityKeys: ["library", `chat-cards:${session.id}`] }
      ),
    [session.id, view.leafSlotId, view.forkId, entityId, live]
  )
  const result = useAtomValue(query)
  const info = AsyncResult.isSuccess(result) ? result.value[0] : undefined
  return (
    <CharacterPanel
      entityId={entityId}
      {...(notesPanel ? { onNotes } : {})}
      actions={
        card && (
          <div className="flex flex-col gap-2">
            {info && (
              <p className="text-xs text-muted">
                used by {info.usedByChats} {info.usedByChats === 1 ? "chat" : "chats"}
              </p>
            )}
            <div className="flex flex-wrap gap-1">
              <ChatCardActions key={entityId} session={session} card={card} info={info} />
            </div>
            {AsyncResult.isFailure(result) && (
              <p role="alert" className="text-sm text-danger">
                The card's details couldn't be read.
              </p>
            )}
          </div>
        )
      }
    />
  )
}

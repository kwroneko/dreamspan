// Who you play in this chat (`{{user}}`, DESIGN §2.2), switched from the This chat, Cast and
// persona tabs alike: one persona, in one write, from the latest message on, on this branch.
// A card not in the chat joins; a persona-folder card played until now leaves.
import type { CastCard } from "@dreamspan/shared/chat.ts"
import { type ReactNode, useCallback, useMemo, useState, useSyncExternalStore } from "react"
import type { AppError } from "../../errors.ts"
import { castView, CastContext } from "./cast.ts"
import type { PendingChat } from "./pendingChat.ts"
import type { ChatSession } from "./session.ts"
import { SpeakerSwitcher } from "./SpeakerSwitcher.tsx"
import { SlotOutlet } from "../../slots.tsx"
import { pendingPersonaPickerRows } from "./presentation.tsx"
import { isGroupDraft, isPendingChat } from "./chatStarted.ts"
import { remoteOf } from "@dreamspan/shared/cardSources.ts"

/** The persona picker's top rows on the new-chat page's PendingChat: its one character, and who you play. */
export function PendingPersonaPickerRows({ pending }: { pending: PendingChat }) {
  const state = useSyncExternalStore(pending.subscribe, pending.snapshot)
  // The chat's one character now: none once another joins in the Cast tab.
  return (
    <SlotOutlet
      slot={pendingPersonaPickerRows}
      props={{ card: pending.lockCard(state), persona: pending.playing(state) }}
    />
  )
}

/**
 * The same rows on a new chat that is a pending chat (DraftChatPage.tsx), until it starts: its
 * one character in the cast before the greetings, who you play, as the new-chat page's.
 */
export function ChatPersonaPickerRows({ session }: { session: ChatSession }) {
  const chat = useSyncExternalStore(session.subscribe, () => session.snapshot().chat)
  const cast = useSyncExternalStore(session.subscribe, () => session.snapshot().cast)
  if (!isPendingChat(chat) || cast === null || isGroupDraft(session.chatId)) return null
  const characters = [...new Set(cast.participants.filter((id) => !cast.playedByMe.includes(id)))]
  const only = characters.length === 1 ? (cast.cards.find((card) => card.entityId === characters[0]) ?? null) : null
  const played = cast.playedByMe[0]
  const persona = played === undefined ? null : (cast.cards.find((card) => card.entityId === played) ?? null)
  return (
    <SlotOutlet
      slot={pendingPersonaPickerRows}
      props={{ card: only !== null && remoteOf(only.entityId) === null ? only : null, persona }}
    />
  )
}

export function PersonaSwitch({
  session,
  trigger,
  place
}: {
  session: ChatSession
  trigger?: ReactNode
  /** Where on the page it is ("cast", "this-chat"), as SpeakerSwitcher's `place`. */
  place: string
}) {
  const cast = useSyncExternalStore(session.subscribe, () => session.snapshot().cast)
  const chat = useSyncExternalStore(session.subscribe, () => session.snapshot().chat)
  const view = useMemo(() => castView(cast), [cast])
  const listCards = useCallback(() => session.listCards(), [session])
  const [error, setError] = useState<AppError | null>(null)
  const persona = cast?.playedByMe[0] ?? null
  const pick = async (card: CastCard) => {
    if (cast === null || (cast.playedByMe.length === 1 && cast.playedByMe[0] === card.entityId)) return
    const outcome = await session.changeCast({ _tag: "Persona", entityId: card.entityId })
    setError(outcome.ok ? null : outcome.error)
  }
  return (
    <>
      <CastContext value={view}>
        <SpeakerSwitcher
          listCards={listCards}
          speaker={persona}
          recent={[]}
          persona
          trigger={trigger}
          place={`${place}:${session.chatId}`}
          onPick={(card) => void pick(card)}
          // A new chat's, as the new-chat page's: the account default says so until it starts.
          markDefault={isPendingChat(chat)}
          header={<ChatPersonaPickerRows session={session} />}
        />
      </CastContext>
      {error && (
        <p role="alert" className="basis-full text-sm text-danger">
          {error.message}
        </p>
      )}
    </>
  )
}

/** The same switch in a chat not made yet: who `{{user}}` is from its greetings on, or no persona. */
export function PendingPersonaSwitch({ pending, trigger }: { pending: PendingChat; trigger?: ReactNode }) {
  const state = useSyncExternalStore(pending.subscribe, pending.snapshot)
  const view = useMemo(
    () => castView(pending.view(state).cast, [...state.greeters.map((item) => item.card), ...pending.cards]),
    [pending, state]
  )
  return (
    <CastContext value={view}>
      <SpeakerSwitcher
        listCards={pending.listCards}
        speaker={state.persona}
        recent={[]}
        persona
        pending
        trigger={trigger}
        place="pending-cast"
        onPick={(card) => pending.setPersona(card.entityId)}
        onNone={() => pending.setPersona(null)}
        header={<PendingPersonaPickerRows pending={pending} />}
      />
    </CastContext>
  )
}

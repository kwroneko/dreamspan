// Who you play in this chat (`{{user}}`, DESIGN §2.2), switched from the This chat, Cast and
// persona tabs alike: one persona, in one write, from the latest message on, on this branch.
// A card not in the chat joins; a persona-folder card played until now leaves.
import type { CastCard } from "@rp/shared/chat.ts"
import { type ReactNode, useCallback, useMemo, useState, useSyncExternalStore } from "react"
import type { AppError } from "../../errors.ts"
import { castView, CastContext } from "./cast.ts"
import type { PendingChat } from "./pendingChat.ts"
import type { ChatSession } from "./session.ts"
import { SpeakerSwitcher } from "./SpeakerSwitcher.tsx"

export function PersonaSwitch({ session, trigger }: { session: ChatSession; trigger?: ReactNode }) {
  const cast = useSyncExternalStore(session.subscribe, () => session.snapshot().cast)
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
          onPick={(card) => void pick(card)}
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
        onPick={(card) => pending.setPersona(card.entityId)}
        onNone={() => pending.setPersona(null)}
      />
    </CastContext>
  )
}

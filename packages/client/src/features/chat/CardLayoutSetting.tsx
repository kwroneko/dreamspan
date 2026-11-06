// Card swap (DESIGN §5.2; spec/CHARACTER-CONTEXT.md §4.1), This chat's `settings.card-layout`
// section: on, the prompt preset's card places hold only the replying character's card, with or
// without tools. A `cards.rotation` state event at the leaf shown. The card-swap reply mode
// always swaps, so the switch shows on and disabled in it.
import { useState, useSyncExternalStore } from "react"
import { Switch } from "../../ui/Choice.tsx"
import type { ChatSession } from "./session.ts"

const CARD_SWAP_MODE = "card-swap"

export function CardLayoutSetting({ session }: { session: ChatSession }) {
  const cast = useSyncExternalStore(session.subscribe, () => session.snapshot().cast)
  const [pending, setPending] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (cast === null) return null
  const byMode = cast.replyMode === CARD_SWAP_MODE
  const on = byMode || (pending ?? cast.cardsRotation === true)
  const change = async (next: boolean) => {
    setPending(next)
    const outcome = await session.changeCast({ _tag: "CardsRotation", on: next })
    setPending(null)
    setError(outcome.ok ? null : `Card swap wasn't changed: ${outcome.error.message}`)
  }
  return (
    <section aria-label="Card swap" className="flex flex-col gap-2 [&_[role=switch]]:mt-0">
      <Switch
        checked={on}
        disabled={byMode || pending !== null}
        onCheckedChange={(next) => void change(next)}
        {...(byMode
          ? { description: "The Card swap reply mode always sends only the replying character's card." }
          : {})}
        about="Where the prompt preset puts character cards, only the card of the character replying is sent, with its example messages and notes. Everything else, your persona included, stays where the preset puts it. Off: every character's card is sent. The start of the context then changes with each speaker, so less of it can be cached."
      >
        Card swap
      </Switch>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </section>
  )
}

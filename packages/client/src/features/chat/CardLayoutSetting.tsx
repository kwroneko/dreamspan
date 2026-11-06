// Card rotation applies independently of tools; otherwise cards follow the preset's layout.
import { useState, useSyncExternalStore } from "react"
import { Switch } from "../../ui/Choice.tsx"
import { Fieldset } from "../../ui/Field.tsx"
import type { ChatSession } from "./session.ts"

export function CardLayoutSetting({ session }: { session: ChatSession }) {
  const cast = useSyncExternalStore(session.subscribe, () => session.snapshot().cast)
  const [pending, setPending] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (cast === null) return null
  const on = pending ?? cast.cardsRotation === true
  const change = async (next: boolean) => {
    setPending(next)
    const outcome = await session.changeCast({ _tag: "CardsRotation", on: next })
    setPending(null)
    setError(outcome.ok ? null : `Card swap wasn't changed: ${outcome.error.message}`)
  }
  return (
    <section aria-label="Cards" className="flex flex-col gap-2 [&_[role=switch]]:mt-0">
      <Fieldset
        legend="Cards"
        about="Cards follow your preset's layout. Card swap sends only the replying character's card in those places; your persona stays included."
      >
        <Switch
          checked={on}
          disabled={pending !== null}
          onCheckedChange={(next) => void change(next)}
          hint={on ? "Click to send every character's card." : "Click to send only the replying character's card."}
          description={
            on ? "Cards change with each speaker, so less of the context can be cached." : "The preset's layout."
          }
        >
          Card swap
        </Switch>
      </Fieldset>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </section>
  )
}

// This chat's Context setting (spec/CHARACTER-CONTEXT.md §2, §9.2 unit CU1): one shared context
// (the default: every reply sees the whole chat) or separate contexts (each character's reply sees
// only what it was present for). The choices are the server's registered context views, so a
// plugin's own view is offered too. It applies from the latest message on, on this branch, as
// every chat setting does.
import { useState, useSyncExternalStore } from "react"
import type { AppError } from "../../errors.ts"
import { RadioGroup } from "../../ui/Choice.tsx"
import { Fieldset } from "../../ui/Field.tsx"
import { contextChoices } from "./contextChoices.ts"
import type { ChatSession } from "./session.ts"

/** What the setting does, when, and what the model sees: one example, no internals. */
const CONTEXT_ABOUT =
  "Who sees what in a group chat, from the latest message on. With one shared context, every reply sees the whole chat. With separate contexts, each character's reply sees only what that character was there for. Example: you mark Wren away in the Cast tab while Mira and Tobin talk; Wren's next reply leaves their talk out, with a line saying she wasn't there for those messages. A narrator always sees everything."

/** Shown while separate contexts are on: what they cost. */
const SEPARATE_COST =
  "Costs more: once a character misses part of the chat, its replies start differently from the others', so less of the context is reused from the cache. Summaries also run once for each character that missed something, as well as once for the whole chat."

export function ContextSetting({ session }: { session: ChatSession }) {
  const cast = useSyncExternalStore(session.subscribe, () => session.snapshot().cast)
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  if (cast === null) return null
  const { value, options } = contextChoices(cast, pending)
  const change = async (view: string) => {
    setPending(view)
    const outcome = await session.changeCast({ _tag: "ContextPerSpeaker", view })
    setPending(null)
    setError(outcome.ok ? null : outcome.error)
  }
  return (
    <section aria-label="Context" className="flex flex-col gap-2">
      <Fieldset legend="Context" about={CONTEXT_ABOUT}>
        <RadioGroup
          aria-label="Context"
          value={value}
          disabled={pending !== null}
          onValueChange={(next) => void change(next)}
          options={options}
        />
        {value === "separate" && <p className="text-sm text-warning">{SEPARATE_COST}</p>}
      </Fieldset>
      {error && (
        <p role="alert" className="text-sm text-danger">
          Context wasn't changed: {error.message}
        </p>
      )}
    </section>
  )
}

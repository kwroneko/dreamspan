// Stable prompt names are independent of the turn's speaker (DESIGN §5.3).
import { useState, useSyncExternalStore } from "react"
import { Button } from "../../ui/Button.tsx"
import { Field, Input } from "../../ui/Field.tsx"
import { useCast } from "./cast.ts"
import type { ChatSession } from "./session.ts"

function Binding({
  session,
  name,
  resolved,
  pinned
}: {
  session: ChatSession
  name: "user" | "char"
  resolved: string
  pinned: boolean
}) {
  const [text, setText] = useState(resolved)
  const [base, setBase] = useState(resolved)
  // A remote change refreshes the saved value without discarding a typed override.
  if (base !== resolved) {
    setBase(resolved)
    if (text === base) setText(resolved)
  }
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const write = async (value: string | null) => {
    setPending(true)
    const result = await session.changeCast({ _tag: "MacroBinding", name, value })
    setPending(false)
    setError(result.ok ? null : result.error.message)
  }
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        if (!pending) void write(text)
      }}
    >
      <Field
        label={`{{${name}}}`}
        description={`${pinned ? "Pinned" : name === "user" ? "Follows the personas you play" : "Follows the cast"}: ${resolved || "(empty)"}`}
        error={error}
      >
        <Input value={text} onValueChange={setText} disabled={pending} />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" pending={pending} disabled={pending || (pinned && text === resolved)}>
          {pinned ? `Update {{${name}}} pin` : `Pin {{${name}}}`}
        </Button>
        {pinned && (
          <Button type="button" variant="ghost" disabled={pending} onClick={() => void write(null)}>
            Unpin {`{{${name}}}`}
          </Button>
        )}
      </div>
    </form>
  )
}

export function MacroBindings({ session }: { session: ChatSession }) {
  const { cast } = useCast()
  const forkId = useSyncExternalStore(session.subscribe, () => session.snapshot().forkId)
  if (!cast) return null
  return (
    <section aria-label="Prompt names" className="flex flex-col gap-4">
      <h3 className="text-xs font-medium tracking-wide text-muted uppercase">Prompt names</h3>
      <p className="text-sm text-muted">
        These names fill preset and chat macros. Choosing a speaker keeps them stable. Card text uses its own character
        name. Pin the current value or type an override; unpin to follow the cast again. Changes apply from here on in
        this fork and rebuild the prompt cache.
      </p>
      {(["user", "char"] as const).map((name) => (
        <Binding
          key={`${session.id}:${forkId}:${name}`}
          session={session}
          name={name}
          resolved={cast.macroNames[name]}
          pinned={cast.macroBindings[name] !== undefined}
        />
      ))}
    </section>
  )
}

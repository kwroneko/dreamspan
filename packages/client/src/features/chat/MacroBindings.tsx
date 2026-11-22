// The names the prompt uses for you and the character, `{{user}}` and `{{char}}` (DESIGN §5.3):
// they follow the cast, and can be kept fixed so choosing a speaker never changes them.
import { useDurableText, useOpenPlace } from "../editor/durable.tsx"
import { useState, useSyncExternalStore } from "react"
import { Button } from "../../ui/Button.tsx"
import { Field, Input } from "../../ui/Field.tsx"
import { Disclosure } from "../../ui/Surface.tsx"
import { useCast } from "./cast.ts"
import type { ChatSession } from "./session.ts"

const LABELS = {
  user: { label: "Your name in prompts", follows: "Follows the persona you play" },
  char: { label: "The character's name in prompts", follows: "Follows who's in the chat" }
} as const

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
  // Kept as typed; until something is, it shows the value as it resolves (a remote change too).
  const typed = useDurableText(`macro:${session.id}:${name}`, "Name", resolved)
  const text = typed.text
  const setText = typed.setText
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const write = async (value: string | null) => {
    setPending(true)
    const result = await session.changeCast({ _tag: "MacroBinding", name, value })
    setPending(false)
    setError(result.ok ? null : result.error.message)
    if (result.ok) void typed.commit(async () => true)
  }
  const { label, follows } = LABELS[name]
  return (
    <form
      aria-label={label}
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        if (!pending) void write(text)
      }}
    >
      <Field
        label={
          <>
            {label} <code className="font-mono text-xs font-normal text-muted">{`{{${name}}}`}</code>
          </>
        }
        description={
          <span className="line-clamp-3 [overflow-wrap:anywhere]">
            {`${pinned ? "Kept as you set it" : follows}: ${resolved || "(empty)"}.`}
          </span>
        }
        error={error}
      >
        <Input value={text} onValueChange={setText} disabled={pending} />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          pending={pending}
          disabled={pending || (pinned && text === resolved)}
          hint="Uses this name from now on, whoever is in the chat."
        >
          {pinned ? "Keep this name instead" : "Keep this name"}
        </Button>
        {pinned && (
          <Button
            type="button"
            variant="ghost"
            disabled={pending}
            hint="The name follows who's in the chat again."
            onClick={() => void write(null)}
          >
            {name === "user" ? "Follow the persona again" : "Follow the cast again"}
          </Button>
        )}
      </div>
    </form>
  )
}

export function MacroBindings({ session }: { session: ChatSession }) {
  const { cast } = useCast()
  const forkId = useSyncExternalStore(session.subscribe, () => session.snapshot().forkId)
  // Open is URL state: a reload shows the names again, with what was typed in them.
  const [open, setOpen] = useOpenPlace(`macro-names:${session.id}`)
  if (!cast) return null
  return (
    <Disclosure title="Advanced: names in prompts" open={open} onOpenChange={setOpen}>
      <section aria-label="Names in prompts" className="flex flex-col gap-4">
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
    </Disclosure>
  )
}

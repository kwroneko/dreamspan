// "HTML in older messages sent to the model" (spec/HTML-MESSAGES.md §3.6): as written by
// default, as ST sends it; or, from N messages back, text only or text without panels.
import { DEFAULT_HTML_DEPTH, type HtmlDepth } from "@dreamspan/shared/state.ts"
import { useState, useSyncExternalStore } from "react"
import { Field, Fieldset } from "../../ui/Field.tsx"
import { Select } from "../../ui/Select.tsx"
import type { ChatSession } from "./session.ts"

const MODES: ReadonlyArray<{ value: HtmlDepth["mode"]; label: string; description: string }> = [
  {
    value: "as_written",
    label: "As written",
    description: "Older messages go to the model with their HTML, as they were written."
  },
  {
    value: "text",
    label: "Text only",
    description: "Older messages lose their HTML tags and keep their text. Fewer tokens; panels are sent as their text."
  },
  {
    value: "panels",
    label: "Leave out panels",
    description: "Older messages lose their panels entirely, and other HTML keeps only its text. The fewest tokens."
  }
]
const COUNTS = [1, 2, 3, 4, 6, 8, 10, 20]

export function HtmlDepthSetting({ session }: { session: ChatSession }) {
  const cast = useSyncExternalStore(session.subscribe, () => session.snapshot().cast)
  const [pending, setPending] = useState<HtmlDepth | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (cast === null) return null
  const depth = pending ?? cast.htmlDepth ?? DEFAULT_HTML_DEPTH
  const counts = COUNTS.includes(depth.n) ? COUNTS : [...COUNTS, depth.n].sort((a, b) => a - b)
  const change = async (next: HtmlDepth) => {
    setPending(next)
    const outcome = await session.changeCast({ _tag: "HtmlDepth", depth: next })
    setPending(null)
    setError(outcome.ok ? null : `The setting wasn't changed: ${outcome.error.message}`)
  }
  return (
    <section aria-label="HTML in older messages" className="flex flex-col gap-2">
      <Fieldset
        legend="HTML in older messages sent to the model"
        about="What the model sees of HTML in messages further back. What you see in the chat doesn't change."
      >
        <Field label="Send">
          <Select<HtmlDepth["mode"]>
            value={depth.mode}
            disabled={pending !== null}
            onValueChange={(mode) => void change({ ...depth, mode })}
            items={MODES}
          />
        </Field>
        {depth.mode !== "as_written" && (
          <Field
            label="Older than"
            about="Messages further back than this are sent this way. The newest ones always go as written."
          >
            <Select<string>
              value={String(depth.n)}
              disabled={pending !== null}
              onValueChange={(n) => void change({ ...depth, n: Number(n) })}
              items={counts.map((n) => ({
                value: String(n),
                label: n === 1 ? "1 message" : `${n} messages`
              }))}
            />
          </Field>
        )}
      </Fieldset>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </section>
  )
}

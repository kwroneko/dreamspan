// Who replies when nobody is picked, per chat (ST's group "Group reply strategy",
// `activation_strategy`): the Cast tab's `cast.reply-order` section (a `castSections` entry, so
// a plugin can replace or remove it). The choices are the reply policies that have a label
// (`replyPolicy.ts`), each explained beside it; a plugin's policy with a label is offered too.
// The choice is a `reply.order` state event at the leaf shown, imported from ST's group.
import { useState, useSyncExternalStore } from "react"
import { Field } from "../../ui/Field.tsx"
import { Select } from "../../ui/Select.tsx"
import { replyPolicies, replyPolicyOf } from "./replyPolicy.ts"
import type { ChatSession } from "./session.ts"

export function ReplyOrderSection({ session }: { session: ChatSession }) {
  const cast = useSyncExternalStore(session.subscribe, () => session.snapshot().cast)
  const policies = useSyncExternalStore(replyPolicies.subscribe, replyPolicies.snapshot, replyPolicies.snapshot).entries
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (cast === null) return null
  const items = policies.flatMap((policy) =>
    policy.label === undefined ? [] : [{ value: policy.id, label: policy.label, description: policy.description }]
  )
  const current = pending ?? replyPolicyOf(cast)?.id ?? null
  const choose = async (order: string) => {
    if (order === current) return
    setPending(order)
    const outcome = await session.changeCast({ _tag: "ReplyOrder", order })
    setPending(null)
    setError(outcome.ok ? null : `Couldn't change who replies: ${outcome.error.message}`)
  }
  return (
    <section aria-label="Who replies" className="flex flex-col gap-2 border-t border-border pt-3">
      <Field
        label="Who replies"
        description="When you haven't picked anyone under Next, with two or more characters here."
        className="w-full sm:w-72"
      >
        <Select items={items} value={current} onValueChange={(order) => void choose(order)} />
      </Field>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </section>
  )
}

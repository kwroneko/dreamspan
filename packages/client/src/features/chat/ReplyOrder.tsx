// Who replies when nobody is picked, per chat (ST's group "Group reply strategy",
// `activation_strategy`): the Cast tab's `cast.reply-order` section (a `castSections` entry, so
// a plugin can replace or remove it). The choices are the reply policies that have a label
// (`replyPolicy.ts`), each explained beside it; a plugin's policy with a label is offered too.
// The choice is a `reply.order` state event at the leaf shown, imported from ST's group.
import { useState, useSyncExternalStore } from "react"
import { SlotOutlet } from "../../slots.tsx"
import { castSections } from "./presentation.tsx"
import { Switch } from "../../ui/Choice.tsx"
import { Field } from "../../ui/Field.tsx"
import { Select } from "../../ui/Select.tsx"
import { oneReplyAtATime, replyPolicies, replyPolicyOf } from "./replyPolicy.ts"
import type { EntityId } from "@rp/shared/chat.ts"
import type { PendingChat } from "./pendingChat.ts"
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
      <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
        <Field
          label="Who replies"
          about="Who replies to what you send when you haven't picked anyone under Next, with two or more characters here."
          className="w-72 max-w-full shrink-0"
        >
          <Select items={items} value={current} onValueChange={(order) => void choose(order)} />
        </Field>
        <SlotOutlet slot={castSections} only="cast.one-reply" props={{ session }} />
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </section>
  )
}

// One reply per user action (owner, 2026-11-02), the Cast tab's `cast.one-reply` section, beside
// Who replies and apart from it: off (the default, and ST's), everyone the reply order picks
// replies in turn after a send or Reply now (a round); on, only the first does. A `reply.single`
// state event at the leaf shown.
export function OneReplySection({ session }: { session: ChatSession }) {
  const cast = useSyncExternalStore(session.subscribe, () => session.snapshot().cast)
  const [pending, setPending] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (cast === null) return null
  const on = pending ?? oneReplyAtATime(cast)
  const change = async (next: boolean) => {
    setPending(next)
    const outcome = await session.changeCast({ _tag: "ReplySingle", on: next })
    setPending(null)
    setError(outcome.ok ? null : `Couldn't change how many reply: ${outcome.error.message}`)
  }
  return (
    <section
      aria-label="One reply at a time"
      className="flex min-h-9 shrink-0 flex-col justify-center gap-2 [&_[role=switch]]:mt-0"
    >
      <Switch
        checked={on}
        disabled={pending !== null}
        onCheckedChange={(next) => void change(next)}
        about="Each message you send, or Reply now, gets one reply, so you can read or edit it before the next. Off: everyone Who replies picks answers, one after another."
      >
        One reply at a time
      </Switch>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </section>
  )
}

/**
 * In a chat not made yet with two or more characters: who answers the first message you send
 * (the first character unless picked), in the same place (`pendingCastSections`).
 */
export function PendingReplyFrom({ pending }: { pending: PendingChat }) {
  const state = useSyncExternalStore(pending.subscribe, pending.snapshot)
  const repliers = state.greeters.filter((item) => item.card.entityId !== state.persona)
  if (repliers.length < 2) return null
  const value = (repliers.find((item) => item.card.entityId === state.replier) ?? repliers[0]!).card.entityId
  return (
    <section aria-label="Who replies" className="flex flex-col gap-2 border-t border-border pt-3">
      <Field label="Reply from" about="Who answers the first message you send." className="w-full sm:w-72">
        <Select
          items={repliers.map(({ card }) => ({
            value: card.entityId as string,
            label: card.name
          }))}
          value={value}
          onValueChange={(id) => pending.setReplier(id as EntityId)}
        />
      </Field>
    </section>
  )
}

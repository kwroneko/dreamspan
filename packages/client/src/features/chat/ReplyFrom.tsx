// Who replies next (ST-GRIPES E4): the strip's "Next: Aria ▾" chip, Auto (the chat's
// reply order, ST's natural order unless the Cast tab says otherwise: replyPolicy.ts), No one (what
// you send gets no reply, until you choose otherwise; DESIGN §2.3) or one of the cast for one
// reply, after which Auto or No one is back. Beside it, ▶ makes them reply at once, as ST's force
// talk does. The chip stays disabled with no one to choose; ▶, with fewer than two.
import type { EntityId } from "@rp/shared/chat.ts"
import { Icon } from "../../ui/Icon.tsx"
import { listNames, nameOf, type NextInTurn, useCast } from "./cast.ts"
import { ChipText, ChoiceChip } from "./nextReplyStrip.tsx"
import { replyPolicyOf } from "./replyPolicy.ts"

const AUTO = "auto"
/** Next's No one: what you send gets no reply, until another choice under Next. */
export const NO_ONE = "none"
/** A choice under Next: Auto (null), No one, or a character for one reply. */
type ReplyPick = EntityId | null | typeof NO_ONE

export interface ReplyChoice {
  readonly candidates: ReadonlyArray<EntityId>
  /** Muted characters: offered for an explicit pick, never Auto's pick (DESIGN §3.5). */
  readonly muted: ReadonlyArray<EntityId>
  readonly next: NextInTurn | null
  /** Who replies after the next, in turn, in the round the next send starts (DESIGN §2.3). */
  readonly round?: ReadonlyArray<EntityId>
  /** The one picked for the next reply; null: Auto's pick replies, or no one with `noReplies`. */
  readonly picked: EntityId | null
  /** Next is No one: what's sent gets no reply unless a pick names one. */
  readonly noReplies?: boolean
  readonly onPick: (pick: ReplyPick) => void
  /** The turn order isn't read yet: who's next shows as "…", not "no one". */
  readonly loading?: boolean
}

/** Whether there's anyone to choose between, for ▶. */
export const hasReplyChoice = (reply: ReplyChoice) => reply.candidates.length >= 2

export function NextReplyChip({
  candidates,
  muted,
  next,
  round = [],
  picked,
  noReplies = false,
  onPick,
  loading = false
}: ReplyChoice) {
  const view = useCast()
  // No one is a choice even with one character; with none, only to go back to Auto.
  const disabled = candidates.length === 0 && !noReplies
  const off = noReplies && picked === null
  const name = (id: EntityId) => nameOf(view, id) ?? "?"
  const replier = off ? null : (picked ?? next?.id ?? null)
  const who = replier === null ? (loading && !off ? "…" : "no one") : name(replier)
  // The whole round, in turn: the chip says "Next: Mira, Tobin, Wren", the hint as a sentence.
  const all = replier === null ? [] : [replier, ...round].map(name)
  const chipWho = all.length > 1 ? all.join(", ") : who
  const detail = replyPolicyOf(view.cast)?.autoDetail ?? "Picked by the chat's reply order"
  const auto = next === null ? [] : [next.id, ...(picked === null && !off ? round : (next.then ?? []))].map(name)
  return (
    <ChoiceChip<EntityId | typeof AUTO | typeof NO_ONE>
      disabled={disabled}
      label={
        off
          ? "Next: no one, until you choose otherwise. Choose who replies next"
          : `Next: ${chipWho}. Choose who replies next`
      }
      hint={
        disabled
          ? "Choose who replies next when a character can reply."
          : off
            ? "No one replies to what you send, until you choose otherwise here."
            : picked !== null
              ? `${who} replies next: your pick, for one reply`
              : replier === null
                ? "No one is picked to reply"
                : all.length > 1
                  ? `${listNames(all)} reply next, in turn. ${detail}`
                  : `${who} replies next. ${detail}`
      }
      title="Who replies next"
      chip={
        <>
          {/* Chosen, No one shows a struck-through bubble: apart from a chat with no one to reply. */}
          {off && <Icon name="chat-off" size={12} className="text-muted" />}
          <ChipText>Next: {chipWho}</ChipText>
        </>
      }
      choices={[
        {
          value: AUTO,
          label: auto.length === 0 ? "Auto" : `Auto: ${auto.join(", ")}`,
          detail
        },
        {
          value: NO_ONE,
          label: "No one",
          detail: "No reply to what you send, until you choose otherwise",
          hint: "Stops replies to what you send, until you choose otherwise here."
        },
        ...candidates.map((id) => ({
          value: id,
          label: name(id),
          detail: muted.includes(id) ? "Muted: replies only when picked" : "Replies next, for one reply"
        }))
      ]}
      value={picked ?? (noReplies ? NO_ONE : AUTO)}
      onChoose={(value) => onPick(value === AUTO ? null : value)}
      footer={() => (
        <p className="px-2 py-1 text-xs text-muted">
          {noReplies
            ? "A pick is for one reply, with no round after it; then No one again."
            : "A pick is for one reply, with no round after it; then Auto picks again."}
        </p>
      )}
    />
  )
}

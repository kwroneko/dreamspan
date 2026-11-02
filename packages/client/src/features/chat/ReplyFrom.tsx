// Who replies next, in a group (ST-GRIPES E4): the strip's "Next: Aria ▾" chip, Auto (the chat's
// reply order, ST's natural order unless the Cast tab says otherwise: replyPolicy.ts) or one of the cast for one reply, after which Auto picks again. Beside it,
// ▶ makes them reply at once, as ST's force talk does. Shown only when there's a choice to make.
import type { EntityId } from "@rp/shared/chat.ts"
import { listNames, nameOf, type NextInTurn, useCast } from "./cast.ts"
import { ChipText, ChoiceChip } from "./nextReplyStrip.tsx"
import { replyPolicyOf } from "./replyPolicy.ts"

const AUTO = "auto"

export interface ReplyChoice {
  readonly candidates: ReadonlyArray<EntityId>
  /** Muted characters: offered for an explicit pick, never Auto's pick (DESIGN §3.5). */
  readonly muted: ReadonlyArray<EntityId>
  readonly next: NextInTurn | null
  /** Who replies after the next, in turn, in the round the next send starts (DESIGN §2.3). */
  readonly round?: ReadonlyArray<EntityId>
  /** The one picked for the next reply; null: Auto's pick replies. */
  readonly picked: EntityId | null
  readonly onPick: (id: EntityId | null) => void
  /** The turn order isn't read yet: who's next shows as "…", not "no one". */
  readonly loading?: boolean
}

/** Whether there's anyone to choose between. */
export const hasReplyChoice = (reply: ReplyChoice) => reply.candidates.length >= 2

export function NextReplyChip({ candidates, muted, next, round = [], picked, onPick, loading = false }: ReplyChoice) {
  const view = useCast()
  if (candidates.length < 2) return null
  const name = (id: EntityId) => nameOf(view, id) ?? "?"
  const replier = picked ?? next?.id ?? null
  const who = replier === null ? (loading ? "…" : "no one") : name(replier)
  // The whole round, in turn: the chip says "Next: Mira, Tobin, Wren", the hint as a sentence.
  const all = replier === null ? [] : [replier, ...round].map(name)
  const chipWho = all.length > 1 ? all.join(", ") : who
  const detail = replyPolicyOf(view.cast)?.autoDetail ?? "Picked by the chat's reply order"
  const auto = next === null ? [] : [next.id, ...(picked === null ? round : (next.then ?? []))].map(name)
  return (
    <ChoiceChip<EntityId | typeof AUTO>
      label={`Next: ${chipWho}. Choose who replies next`}
      hint={
        picked !== null
          ? `${who} replies next: your pick, for one reply`
          : replier === null
            ? "No one is picked to reply"
            : all.length > 1
              ? `${listNames(all)} reply next, in turn. ${detail}`
              : `${who} replies next. ${detail}`
      }
      title="Who replies next"
      chip={<ChipText>Next: {chipWho}</ChipText>}
      choices={[
        {
          value: AUTO,
          label: auto.length === 0 ? "Auto" : `Auto: ${auto.join(", ")}`,
          detail
        },
        ...candidates.map((id) => ({
          value: id,
          label: name(id),
          detail: muted.includes(id) ? "Muted: replies only when picked" : "Replies next, for one reply"
        }))
      ]}
      value={picked ?? AUTO}
      onChoose={(value) => onPick(value === AUTO ? null : value)}
      footer={() => (
        <p className="px-2 py-1 text-xs text-muted">
          A pick is for one reply, with no round after it; then Auto picks again.
        </p>
      )}
    />
  )
}

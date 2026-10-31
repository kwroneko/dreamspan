// Who replies next, in a group (ST-GRIPES E4): the strip's "Next: Aria ▾" chip, Auto (the next
// in turn) or one of the cast for one reply, after which turns go on round the cast. Beside it,
// ▶ makes them reply at once, as ST's force talk does. Shown only when there's a choice to make.
import type { EntityId } from "@rp/shared/chat.ts"
import { nameOf, type NextInTurn, useCast } from "./cast.ts"
import { ChipText, ChoiceChip } from "./nextReplyStrip.tsx"

const AUTO = "auto"

export interface ReplyChoice {
  readonly candidates: ReadonlyArray<EntityId>
  /** Muted characters: offered for an explicit pick, never next in turn (DESIGN §3.5). */
  readonly muted: ReadonlyArray<EntityId>
  readonly next: NextInTurn | null
  /** The one picked for the next reply; null: the next in turn replies. */
  readonly picked: EntityId | null
  readonly onPick: (id: EntityId | null) => void
}

/** Whether there's anyone to choose between. */
export const hasReplyChoice = (reply: ReplyChoice) => reply.candidates.length >= 2

export function NextReplyChip({ candidates, muted, next, picked, onPick }: ReplyChoice) {
  const view = useCast()
  if (candidates.length < 2) return null
  const name = (id: EntityId) => nameOf(view, id) ?? "?"
  const replier = picked ?? next?.id ?? null
  const who = replier === null ? "no one" : name(replier)
  return (
    <ChoiceChip<EntityId | typeof AUTO>
      label={`Next: ${who}. Choose who replies next`}
      hint={
        picked !== null
          ? `${who} replies next: your pick, for one reply`
          : replier === null
            ? "No one is next in turn"
            : `${who} replies next, in turn`
      }
      title="Who replies next"
      chip={<ChipText>Next: {who}</ChipText>}
      choices={[
        { value: AUTO, label: next === null ? "Auto" : `Auto: ${name(next.id)}, next in turn` },
        ...candidates.map((id) => ({
          value: id,
          label: name(id),
          ...(muted.includes(id) ? { detail: "Muted: replies only when picked" } : {})
        }))
      ]}
      value={picked ?? AUTO}
      onChoose={(value) => onPick(value === AUTO ? null : value)}
      footer={() => <p className="px-2 py-1 text-xs text-muted">A pick is for one reply; then turns go on round the cast.</p>}
    />
  )
}

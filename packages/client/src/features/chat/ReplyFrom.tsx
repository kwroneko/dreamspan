// "Reply from" at the composer (ST-GRIPES E4): the faces of everyone who can answer the next
// send, one tap each, with who's next in turn and why. A face picked is for that one reply;
// then turns go on round the cast. Shown only when there's a choice to make.
import type { EntityId } from "@rp/shared/chat.ts"
import { Avatar } from "../../ui/Avatar.tsx"
import { Button } from "../../ui/Button.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { nameOf, type NextInTurn, useCast } from "./cast.ts"

export function ReplyFrom({
  candidates,
  next,
  picked,
  disabled,
  onPick
}: {
  candidates: ReadonlyArray<EntityId>
  next: NextInTurn | null
  /** The face picked for the next reply; null: the next in turn replies. */
  picked: EntityId | null
  disabled: boolean
  onPick: (id: EntityId | null) => void
}) {
  const view = useCast()
  if (candidates.length < 2) return null
  const name = (id: EntityId) => nameOf(view, id) ?? "?"
  const replier = picked ?? next?.id ?? null
  const why =
    picked !== null
      ? `${name(picked)} replies next: your pick, for this reply`
      : next === null
        ? null
        : next.after === null
          ? `Next in turn: ${name(next.id)}, first in the cast`
          : `Next in turn: ${name(next.id)}, after ${name(next.after)}`
  return (
    <div role="group" aria-label="Reply from" className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <span className="text-xs text-muted">Reply from</span>
      <div className="flex flex-wrap items-center gap-1">
        {candidates.map((id) => {
          const who = name(id)
          const chosen = id === replier
          const label = chosen ? `${who} replies next` : `Reply from ${who}`
          return (
            <Tooltip key={id} label={label}>
              <button
                type="button"
                aria-label={`Reply from ${who}`}
                aria-pressed={chosen}
                disabled={disabled}
                // The next in turn needs no pick; picking them again goes back to the turn order.
                onClick={() => onPick(id === next?.id || id === picked ? null : id)}
                className="inline-flex h-8 max-w-40 min-w-0 shrink-0 items-center gap-1.5 rounded-full border border-border py-0.5 pr-2.5 pl-0.5 text-xs outline-none hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-40 aria-pressed:border-accent aria-pressed:bg-accent/10 aria-pressed:font-medium aria-pressed:ring-1 aria-pressed:ring-accent"
              >
                <Avatar id={id} name={who} mediaId={view.cards.get(id)?.avatarMediaId ?? null} size="chip" />
                <span className="min-w-0 truncate">{who}</span>
              </button>
            </Tooltip>
          )
        })}
      </div>
      {why !== null && (
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-muted">
          <span role="status">{why}</span>
          {picked !== null && next !== null && (
            <Button variant="ghost" className="h-7! px-1.5! text-xs" disabled={disabled} onClick={() => onPick(null)}>
              Back to turn order
            </Button>
          )}
        </span>
      )}
    </div>
  )
}

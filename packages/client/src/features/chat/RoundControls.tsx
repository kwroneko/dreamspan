// The round under way in the fork shown (DESIGN §2.3), above the composer's box: who's still to
// reply after the reply being written, or, once Stop (or a failed reply) stopped it, who was,
// with Continue round and End round. The round's entries are the server's queue entries
// (`QueuedMessage.round`), so a reload or a second tab shows the same; the queue list leaves
// them out. With "Who replies next" on, the decision model chooses each turn's speaker when the
// turn comes, so the strip names the turns already chosen and only counts the rest: Auto's plan
// for them is only a fallback. A `composerControls` entry (`composer.round`), so a plugin can
// replace it.
import type { PathEntry, QueuedMessage, SlotId } from "@rp/shared/chat.ts"
import { useState } from "react"
import { Button } from "../../ui/Button.tsx"
import { Badge } from "../../ui/Surface.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { type CastView, listNames, nameOf, useCast } from "./cast.ts"
import type { ComposerControlContext } from "./composerControls.tsx"

/** The fork's round entries, in turn. */
const roundOf = (queue: ReadonlyArray<QueuedMessage>, forkId: string | null) =>
  queue.filter((entry) => entry.round !== undefined && entry.round.forkId === forkId)

/**
 * The round's replies so far, in the messages shown: from its first reply through the one its
 * next turn waits for (being written, or the last written once the round stopped).
 */
const turnsSoFar = (entries: ReadonlyArray<PathEntry>, start: SlotId | undefined, current: SlotId) => {
  // A queued action has not posted its first reply: the one it waits for belongs
  // to an earlier action, not to this round.
  if (start === undefined) return []
  const last = entries.findIndex((entry) => entry.slotId === current)
  if (last < 0) return []
  const first = entries.findIndex((entry) => entry.slotId === start)
  return entries.slice(first >= 0 && first <= last ? first : last, last + 1)
}

/** "Ash and Wren so far. Choosing who replies now. " — the turns the decision model has had. */
const soFar = (cast: CastView, turns: ReadonlyArray<PathEntry>) => {
  const choosing = turns.some((turn) => turn.version.speakerPick?.by === "auto" && turn.version.status === "generating")
  const named = turns.flatMap((turn) =>
    turn.version.speakerPick?.by === "auto" && turn.version.status === "generating"
      ? []
      : [nameOf(cast, turn.version.speakerEntityId) ?? "?"]
  )
  return `${named.length > 0 ? `${listNames(named)} so far. ` : ""}${choosing ? "Choosing who replies now. " : ""}`
}

const more = (count: number) => (count === 1 ? "1 more" : `${count} more`)

export function RoundControls({ view, session, report }: ComposerControlContext) {
  const cast = useCast()
  const [busy, setBusy] = useState(false)
  const round = roundOf(view.queue, view.forkId)
  if (round.length === 0) return null
  const held = round.some((entry) => entry.round?.held)
  const decides = round.some((entry) => entry.round?.decides === true)
  const names = listNames(round.map((entry) => nameOf(cast, entry.speakerEntityId) ?? "?"))
  const chosen = decides
    ? soFar(
        cast,
        turnsSoFar(
          view.entries,
          round.find((entry) => entry.round?.startSlotId)?.round?.startSlotId,
          round[0]!.replySlotId
        )
      )
    : ""
  const still = decides ? `${more(round.length)}, each chosen when it's their turn` : names
  const run = async (action: "continue" | "end") => {
    setBusy(true)
    report(await session.round(action))
    setBusy(false)
  }
  const end = (
    <Tooltip
      label={
        held
          ? "Drop the rest of this round. Your next message, or Reply now, starts a new one."
          : "Let the reply being written finish, and no one after it in this round."
      }
    >
      <Button variant="ghost" disabled={busy} onClick={() => void run("end")}>
        End round
      </Button>
    </Tooltip>
  )
  return (
    <div
      role="group"
      aria-label="This round"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-dashed border-border px-3 py-2 text-sm"
    >
      <Badge tone={held ? "warning" : "neutral"}>{held ? "round stopped" : "round"}</Badge>
      <span className="min-w-[10rem] flex-1 text-muted [overflow-wrap:anywhere]">
        {chosen}
        {held ? `Still to reply: ${still}` : decides ? `Then ${still}` : `Then ${names}, in turn`}
      </span>
      <span className="ml-auto flex flex-wrap items-center gap-1">
        <Tooltip
          label={
            !held
              ? "This round is already running."
              : busy
                ? "Wait for the round to update."
                : decides
                  ? `${more(round.length)} reply in turn now, after the last message as it is, each chosen when it's their turn.`
                  : `${names} reply in turn now, after the last message as it is.`
          }
        >
          <Button
            variant={held ? "primary" : "ghost"}
            disabled={busy || !held}
            focusableWhenDisabled
            onClick={() => void run("continue")}
          >
            Continue round
          </Button>
        </Tooltip>
        {end}
      </span>
    </div>
  )
}

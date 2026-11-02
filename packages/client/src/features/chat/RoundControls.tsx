// The round under way in the fork shown (DESIGN §2.3), above the composer's box: who's still to
// reply after the reply being written, or, once Stop (or a failed reply) stopped it, who was,
// with Continue round and End round. The round's entries are the server's queue entries
// (`QueuedMessage.round`), so a reload or a second tab shows the same; the queue list leaves
// them out. A `composerControls` entry (`composer.round`), so a plugin can replace it.
import type { QueuedMessage } from "@rp/shared/chat.ts"
import { useState } from "react"
import { Button } from "../../ui/Button.tsx"
import { Badge } from "../../ui/Surface.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { listNames, nameOf, useCast } from "./cast.ts"
import type { ComposerControlContext } from "./composerControls.tsx"

/** The fork's round entries, in turn. */
const roundOf = (queue: ReadonlyArray<QueuedMessage>, forkId: string | null) =>
  queue.filter((entry) => entry.round !== undefined && entry.round.forkId === forkId)

export function RoundControls({ view, session, report }: ComposerControlContext) {
  const cast = useCast()
  const [busy, setBusy] = useState(false)
  const round = roundOf(view.queue, view.forkId)
  if (round.length === 0) return null
  const held = round.some((entry) => entry.round?.held)
  const names = listNames(round.map((entry) => nameOf(cast, entry.speakerEntityId) ?? "?"))
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
      className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-dashed border-border px-3 py-1.5 text-sm"
    >
      <Badge tone={held ? "warning" : "neutral"}>{held ? "round stopped" : "round"}</Badge>
      <span className="min-w-[10rem] flex-1 text-muted [overflow-wrap:anywhere]">
        {held ? `Still to reply: ${names}` : `Then ${names}, in turn`}
      </span>
      <span className="ml-auto flex flex-wrap items-center gap-1">
        {held && (
          <Tooltip
            label={`${names} reply in turn now, after the last message as it is (edited or not). Sending a message instead starts a new round.`}
          >
            <Button variant="primary" disabled={busy} onClick={() => void run("continue")}>
              Continue round
            </Button>
          </Tooltip>
        )}
        {end}
      </span>
    </div>
  )
}

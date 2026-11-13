// The thin rows in the message list where a character left the scene or came back (spec/
// CHARACTER-CONTEXT.md §5, §9.2 unit CU3; awayMarks.ts): under the message the mark is at, as
// the split-chat divider is, with the character's face, who set it, and Undo for the scene
// check's mark, left or back. A `messageStream` entry, so a plugin can replace or remove it.
import type { PathEntry } from "@rp/shared/chat.ts"
import { useState, useSyncExternalStore } from "react"
import { Avatar } from "../../ui/Avatar.tsx"
import { Button } from "../../ui/Button.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { nameOf, useCast } from "./cast.ts"
import { type AwayRow, awayExplanation, awayLabel, awayRowsOf, undoExplanation } from "./awayMarks.ts"
import type { ChatSession } from "./session.ts"

function Row({ row, session }: { row: AwayRow; session: ChatSession }) {
  const view = useCast()
  const [undoing, setUndoing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const name = (id: string) => nameOf(view, id as never) ?? "Someone"
  const card = view.cards.get(row.entityId)
  const who = name(row.entityId)
  const undo = async () => {
    const forkId = session.snapshot().forkId
    if (forkId === null) return
    setUndoing(true)
    const result = await session.call((client) =>
      client("UndoAwayMark", { chatId: session.id, forkId, eventId: row.eventId })
    )
    setUndoing(false)
    setError(
      result.ok
        ? result.value
          ? null
          : "This mark changed meanwhile; nothing was undone."
        : `Not undone: ${result.error.message}`
    )
    awayRowsOf(session).refresh()
  }
  return (
    <div data-away-row className="flex flex-col items-center gap-1">
      <div className="flex w-full items-center gap-3">
        <span aria-hidden="true" className="h-px min-w-4 flex-1 bg-border" />
        <Tooltip label={awayExplanation(row, name)}>
          <span
            tabIndex={0}
            className="flex min-w-0 items-center gap-2 rounded-md px-1 py-0.5 text-xs text-muted outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <Avatar
              id={row.entityId}
              name={who}
              mediaId={card?.avatarMediaId ?? null}
              crop={card?.avatarCrop}
              size="xs"
            />
            <span className="[overflow-wrap:anywhere]">{awayLabel(row, name)}</span>
          </span>
        </Tooltip>
        {row.undoable && (
          <Button
            variant="ghost"
            className="h-7 px-2 text-xs"
            pending={undoing}
            hint={undoExplanation(row, name)}
            onClick={() => void undo()}
          >
            Undo
          </Button>
        )}
        <span aria-hidden="true" className="h-px min-w-4 flex-1 bg-border" />
      </div>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  )
}

export function AwayRows({
  entry,
  session,
  place
}: {
  entry: PathEntry
  session: ChatSession
  place: "above" | "below"
}) {
  const store = awayRowsOf(session)
  const rows = useSyncExternalStore(store.subscribe, () => store.at(entry.slotId))
  if (place !== "below" || rows.length === 0) return null
  return (
    <div role="group" aria-label="Who left or came back here" className="my-1 flex flex-col gap-1">
      {rows.map((row) => (
        <Row key={row.eventId} row={row} session={session} />
      ))}
    </div>
  )
}

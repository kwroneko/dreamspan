// One revision in an editor's History (owner, 2026-11-01): its number and time, what made it
// (a reply that used its text, a Save, an import) and its message, a label added or changed
// in place at any time, never content. Picking it shows how it changed (the editor's own
// comparison below the list).
import { type ReactNode, useState } from "react"
import { Button } from "./Button.tsx"
import { OneLineField } from "./OneLineField.tsx"
import { Badge } from "./Surface.tsx"
import { IconButton } from "./Tooltip.tsx"

const when = (at: number) => new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })

export function RevisionEntry({
  number,
  createdAt,
  title,
  message,
  current,
  selected,
  onSelect,
  onMessage
}: {
  number: number | undefined
  createdAt: number
  /** What made it, in words (and a link to the reply that used it). */
  title: ReactNode
  message: string | null
  /** The head: what the editor's fields hold when nothing changed since. */
  current: boolean
  selected: boolean
  onSelect: () => void
  /** Sets the message (empty removes it); false keeps the field open. */
  onMessage: (message: string) => Promise<boolean>
}) {
  const [editing, setEditing] = useState(false)
  const name = number === undefined ? "Revision" : `Revision ${number}`
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Button
          variant="ghost"
          aria-pressed={selected}
          className="-ml-2 h-8"
          hint="Shows how this revision changed things, and lets you restore it."
          onClick={onSelect}
        >
          <span className="font-medium">{name}</span>
          <span className="text-muted">{when(createdAt)}</span>
        </Button>
        {current && <Badge tone="accent">latest</Badge>}
      </div>
      <p className="text-sm [overflow-wrap:anywhere]">{title}</p>
      {editing ? (
        <OneLineField
          label={`Message of ${name}`}
          initial={message ?? ""}
          placeholder="What changed"
          saveLabel="Save the message"
          saveHint="Saves this message as the revision's label"
          onSave={async (next) => {
            const kept = await onMessage(next)
            if (kept) setEditing(false)
            return kept
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <span className="flex min-w-0 items-center gap-1 text-sm text-muted">
          {message && <span className="min-w-0 [overflow-wrap:anywhere]">“{message}”</span>}
          <IconButton
            label={message ? `Change the message of ${name}` : `Add a message to ${name}`}
            hint={message ? "Change this revision's message" : "Add a message saying what changed"}
            icon="edit"
            className="size-7! shrink-0"
            onClick={() => setEditing(true)}
          />
        </span>
      )}
    </div>
  )
}

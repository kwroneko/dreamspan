// One revision in an editor's History (owner, 2026-11-01): its number and time, what made it
// (a reply that used its text, a Save, an import) and its message, a label added or changed
// in place at any time, never content. Picking it shows how it changed (the editor's own
// comparison directly below the entry).
import { type ReactNode, useState } from "react"
import { Button } from "./Button.tsx"
import { OneLineField } from "./OneLineField.tsx"
import { Badge } from "./Surface.tsx"
import { Icon } from "./Icon.tsx"
import { IconButton } from "./Tooltip.tsx"

const when = (at: number) => new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })

export const revisionName = (number: number | undefined) => (number === undefined ? "Revision" : `Revision ${number}`)

export function RevisionEntry({
  number,
  createdAt,
  title,
  originLabel,
  restore,
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
  originLabel?: string | undefined
  restore: ReactNode
  message: string | null
  /** The head: what the editor's fields hold when nothing changed since. */
  current: boolean
  selected: boolean
  onSelect: () => void
  /** Sets the message (empty removes it); false keeps the field open. */
  onMessage: (message: string) => Promise<boolean>
}) {
  const [editing, setEditing] = useState(false)
  const name = revisionName(number)
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold">{name}</span>
          {current && <Badge tone="accent">latest</Badge>}
          {originLabel && <Badge>{originLabel}</Badge>}
        </div>
        <time dateTime={new Date(createdAt).toISOString()} className="text-xs text-muted">
          {when(createdAt)}
        </time>
      </div>
      {message && <p className="text-sm [overflow-wrap:anywhere]">“{message}”</p>}
      {title && <div className="text-sm [overflow-wrap:anywhere]">{title}</div>}
      <div className="flex flex-wrap items-center gap-2">
        {restore}
        <Button
          variant={selected ? "secondary" : "ghost"}
          aria-label={`${name} ${when(createdAt)}: Compare`}
          aria-pressed={selected}
          className="h-8 px-2"
          hint={selected ? "Click to hide this revision's comparison" : "Click to compare this revision"}
          onClick={onSelect}
        >
          <Icon name="history" />
          Compare
        </Button>
        <Button
          variant="ghost"
          aria-label={message ? `Change the message of ${name}` : `Add a message to ${name}`}
          aria-pressed={editing}
          hint={
            editing
              ? "Click to close the revision message"
              : message
                ? "Click to edit this revision's message"
                : "Click to add a message saying what changed"
          }
          className="h-8 px-2"
          onClick={() => setEditing(!editing)}
        >
          <Icon name="edit" />
          {message ? "Edit message" : "Add message"}
        </Button>
      </div>
      {editing && (
        <div className="relative rounded-md border border-border bg-surface p-3 pt-10">
          <IconButton
            label="Close message"
            hint="Closes the revision message"
            icon="close"
            className="absolute top-2 right-2"
            onClick={() => setEditing(false)}
          />
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
        </div>
      )}
    </div>
  )
}

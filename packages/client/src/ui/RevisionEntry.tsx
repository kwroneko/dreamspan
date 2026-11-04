// One revision in an editor's History (owner, 2026-11-01): its number and time, what made it
// (a reply that used its text, a Save, an import) and its message, a label added or changed
// in place at any time, never content. Picking it shows how it changed (the editor's own
// comparison directly below the entry).
import { type ReactNode } from "react"
import { Button } from "./Button.tsx"
import { RevisionMessage } from "./RevisionMessage.tsx"
import { Badge } from "./Surface.tsx"
import { Icon } from "./Icon.tsx"

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
      <RevisionMessage message={message} name={name} onMessage={onMessage} />
      {title && <div className="text-sm [overflow-wrap:anywhere]">{title}</div>}
      <div role="group" aria-label={`${name} actions`} className="flex flex-wrap items-center gap-2">
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
      </div>
    </div>
  )
}

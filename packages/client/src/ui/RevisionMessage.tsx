// The fixed-height message line uses the same pencil flow as title edits; without `onMessage`
// (a revision a fork inherited, its original's to label) it only reads.
import { useState } from "react"
import { Button } from "./Button.tsx"
import { InlineRename } from "./InlineRename.tsx"
import { Tooltip } from "./Tooltip.tsx"
import { useTruncated } from "./useTruncated.ts"

export function RevisionMessage({
  message,
  name,
  onMessage
}: {
  message: string | null
  name: string
  onMessage?: ((message: string) => Promise<boolean>) | undefined
}) {
  const [expanded, setExpanded] = useState(false)
  const [editing, setEditing] = useState(false)
  const { ref, truncated } = useTruncated(message ?? "")
  const shown = (
    <>
      {message && (
        <Tooltip
          enabled={truncated}
          label={<span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{message}</span>}
        >
          <span
            ref={ref}
            data-layout-audit-ignore="text: Clipped message has an adjacent ellipsis button and full text on hover or expansion"
            className="min-w-0 truncate text-clip!"
          >
            {message}
          </span>
        </Tooltip>
      )}
      {(truncated || expanded) && (
        <Button
          variant="ghost"
          className="h-7 w-7 shrink-0 px-0"
          aria-label={expanded ? `Collapse message of ${name}` : `Expand message of ${name}`}
          aria-expanded={expanded}
          hint={expanded ? "Click to collapse the revision message" : "Click to expand the full revision message"}
          onClick={() => setExpanded(!expanded)}
        >
          …
        </Button>
      )}
    </>
  )
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div data-revision-message-row className="flex h-8 min-w-0 items-center">
        {onMessage ? (
          <InlineRename
            value={message ?? ""}
            label={`message of ${name}`}
            fieldLabel={`Message of ${name}`}
            editLabel={message ? `Edit message of ${name}` : `Add message to ${name}`}
            editText={message ? undefined : "Add message"}
            hint={message ? "Edits this revision's message" : "Adds a message saying what changed"}
            saveLabel="Save message"
            cancelLabel="Cancel editing message"
            maxLength={500}
            allowEmpty
            className="h-8 w-full text-sm"
            onEditingChange={setEditing}
            onRename={async (next) => {
              const kept = await onMessage(next.trim())
              if (kept) setExpanded(false)
              return kept
            }}
          >
            {shown}
          </InlineRename>
        ) : (
          <div className="flex h-8 w-full min-w-0 items-center text-sm">{shown}</div>
        )}
      </div>
      {expanded && !editing && (
        <div
          role="region"
          aria-label={`Full message of ${name}`}
          className="rounded-md border border-border bg-surface p-2 text-sm whitespace-pre-wrap [overflow-wrap:anywhere]"
        >
          {message}
        </div>
      )}
    </div>
  )
}

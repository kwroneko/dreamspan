// Saving a revision, the same in every editor (owner, 2026-11-01): what's typed is used as it's
// typed, so a revision is only a checkpoint. The state says honestly whether the text changed
// since the last one ("Changed since revision N", never "not sent"); a plain Save asks nothing;
// beside it, "Save with a message…" opens a one-line field for a label (Enter saves, Escape
// cancels), which History can add or change later too. Editors bind it to their store.
import { useState } from "react"
import { Button } from "./Button.tsx"
import { OneLineField } from "./OneLineField.tsx"

/** The state line: whether the live text has changed since the head revision. */
export const revisionState = (revision: number, changed: boolean) =>
  changed ? `Changed since revision ${revision}` : `Saved as revision ${revision}`

export function SaveControls({
  revision,
  changed,
  pending = false,
  blocked = null,
  onSave,
  showState = true
}: {
  /** The head revision's number. */
  revision: number
  /** The live text differs from it. */
  changed: boolean
  pending?: boolean
  /** Why saving can't happen now (a name another card has, say); null when it can. */
  blocked?: string | null
  /** Saves a revision with this message (null: none); false keeps the message field open. */
  onSave: (message: string | null) => Promise<boolean>
  /** The state line beside the buttons; off where the editor shows it elsewhere. */
  showState?: boolean
}) {
  const [writing, setWriting] = useState(false)
  const next = revision + 1
  const disabled = !changed || blocked !== null
  const why = blocked ?? (changed ? null : `Nothing changed since revision ${revision}.`)
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-2">
      {showState && (
        <span role="status" className="text-sm text-muted">
          {revisionState(revision, changed)}
        </span>
      )}
      {writing ? (
        <OneLineField
          label="Revision message"
          placeholder="What changed"
          saveLabel="Save with this message"
          saveHint={`Saves revision ${next} with this message`}
          onSave={async (message) => {
            const saved = await onSave(message === "" ? null : message)
            if (saved) setWriting(false)
            return saved
          }}
          onCancel={() => setWriting(false)}
        />
      ) : (
        <>
          <Button
            variant="primary"
            pending={pending}
            disabled={disabled}
            hint={
              why ??
              `Saves revision ${next}: a checkpoint in History to come back to. Replies already use what you type as you type it.`
            }
            onClick={() => void onSave(null)}
          >
            Save
          </Button>
          <Button
            variant="ghost"
            disabled={disabled || pending}
            hint={
              why ??
              "Saves a revision with a one-line message saying what changed. History can add or change a message later."
            }
            onClick={() => setWriting(true)}
          >
            Save with a message…
          </Button>
        </>
      )}
    </span>
  )
}

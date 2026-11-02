// Saving a revision, the same in every editor (owner, 2026-11-01): what's typed is used as it's
// typed, so a revision is only a checkpoint. The state says honestly whether the text changed
// since the last one ("Changed since revision N", never "not sent"); a plain Save asks nothing;
// beside it, "Save with a message…" opens a one-line field for a label (Enter saves, Escape
// cancels), which History can add or change later too. Editors bind it to their store.
import { useState } from "react"
import { Button } from "./Button.tsx"
import { Icon } from "./Icon.tsx"
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
  onRevert,
  showState = true,
  compact = false
}: {
  /** A crowded toolbar: on a phone, "Save with a message…" shows as its pen icon only. */
  compact?: boolean
  /** The head revision's number. */
  revision: number
  /** The live text differs from it. */
  changed: boolean
  pending?: boolean
  /** Why saving can't happen now (a name another card has, say); null when it can. */
  blocked?: string | null
  /** Saves a revision with this message (null: none); false keeps the message field open. */
  onSave: (message: string | null) => Promise<boolean>
  /**
   * Puts every changed field back to the head revision; shown while something changed. The
   * text there now stays in each field's edit history, so it asks nothing.
   */
  onRevert?: (() => Promise<unknown>) | undefined
  /** The state line beside the buttons; off where the editor shows it elsewhere. */
  showState?: boolean
}) {
  const [writing, setWriting] = useState(false)
  const [reverting, setReverting] = useState(false)
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
            aria-label="Save with a message…"
            className={compact ? "max-sm:px-2!" : ""}
            hint={
              why ??
              "Saves a revision with a one-line message saying what changed. History can add or change a message later."
            }
            onClick={() => setWriting(true)}
          >
            {compact ? (
              <>
                <Icon name="edit" />
                <span className="max-sm:hidden">Save with a message…</span>
              </>
            ) : (
              "Save with a message…"
            )}
          </Button>
          {/* Shown while something changed; hidden, it keeps its room, so the first key typed in a
              field moves nothing on the page (owner, 2026-11-02). */}
          {onRevert && (
            <Button
              variant="ghost"
              pending={reverting}
              disabled={!changed}
              aria-hidden={!changed || undefined}
              aria-label={`Revert to revision ${revision}`}
              className={`${compact ? "max-sm:px-2!" : ""} ${changed ? "" : "invisible"}`}
              hint={`Puts every field back to revision ${revision}. What's there now stays in each field's edit history.`}
              onClick={() => {
                setReverting(true)
                void onRevert().finally(() => setReverting(false))
              }}
            >
              <Icon name="undo" />
              <span className={compact ? "max-sm:hidden" : ""}>Revert to revision {revision}</span>
            </Button>
          )}
        </>
      )}
    </span>
  )
}

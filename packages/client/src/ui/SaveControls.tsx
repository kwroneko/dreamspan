// The save cluster, the same everywhere something is saved as a version (owner, 2026-11-01 and
// 2026-11-02, DESIGN §10.1): two icon buttons, Save and Save with a message, and Revert beside
// them, always shown and greyed out while nothing changed (owner, 2026-11-02). What's typed is
// already in use as it's typed, so saving keeps a version to come back to; the cluster says
// only what the user needs: whether there's anything to save, that it's saving, that it saved,
// or why it couldn't. It keeps one size in every state, and each state swaps an icon or a
// colour, never text. Its explanations, on hover and focus, carry the words. Save with a
// message opens a one-line field in its place (Enter saves, Escape cancels). Editors bind it
// to their store (`SaveRevision`, `HeldChangesBar`).
import { useEffect, useRef, useState } from "react"
import { Button } from "./Button.tsx"
import { Icon } from "./Icon.tsx"
import { OneLineField } from "./OneLineField.tsx"
import { Spinner } from "./Spinner.tsx"

/** Where the cluster is; `data-save-state` on its group says it to tests and styles. */
type SaveState = "clean" | "unsaved" | "blocked" | "saving" | "saved" | "failed"

/** How long the saved tick shows before the cluster settles back to quiet. */
const SAVED_FOR_MS = 1800

/** The explanations, kept together so they read as one voice. */
const saveHints = {
  save: "Keeps this version in History so you can return to it. Your edits are already in use; you don't need to save them.",
  clean: "Nothing to save: no edits since the last save.",
  saving: "Saving…",
  saved: "Saved. You can return to this version from History.",
  failed: (reason: string) => `Couldn't save: ${reason} Your edits are still here. Save again to retry.`,
  message: "Keeps this version in History with a note saying what changed.",
  revert: "Undoes every edit since the last save. What you undo stays in each field's edit history."
}

/** A reason as a sentence, ending in a full stop. */
const sentence = (text: string) => (/[.!?…]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`)

/** One size for the three, a toolbar icon button's. */
const square = "h-8! w-8! px-0!"
/** Not actionable but still focusable and hoverable, so its explanation can say why. */
const inert =
  "cursor-default bg-transparent! text-muted! opacity-50 data-disabled:pointer-events-auto! data-disabled:opacity-50! hover:bg-transparent!"

export function SaveControls({
  changed,
  pending = false,
  blocked = null,
  failed = null,
  onSave,
  onRevert,
  saveHint = saveHints.save,
  revertLabel = "Revert to the last save",
  revertHint = saveHints.revert,
  labelsInHints = false
}: {
  /** Something differs from the last save. */
  changed: boolean
  pending?: boolean
  /** Why saving can't happen now (a name another card has, say); null when it can. */
  blocked?: string | null
  /** Why the last save failed; null when it didn't. */
  failed?: string | null
  /** Saves with this message (null: none); false keeps the message field open. */
  onSave: (message: string | null) => Promise<boolean>
  /**
   * Puts every change back as the last save had it; always shown, enabled while something
   * changed. The text
   * there now stays in each field's edit history, so it asks nothing.
   */
  onRevert?: (() => Promise<unknown>) | undefined
  /** What Save does, where it does more than keep a version (applying held changes, say). */
  saveHint?: string
  /** Revert's accessible name, where it undoes less than every edit (a held order: "Revert"). */
  revertLabel?: string
  revertHint?: string
  /** Repeat icon labels above their explanations in a compact toolbar. */
  labelsInHints?: boolean
}) {
  const [writing, setWriting] = useState(false)
  const [reverting, setReverting] = useState(false)
  const [justSaved, setJustSaved] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])

  const state: SaveState = pending
    ? "saving"
    : blocked !== null && changed
      ? "blocked"
      : failed !== null
        ? "failed"
        : changed
          ? "unsaved"
          : justSaved
            ? "saved"
            : "clean"

  const save = async (message: string | null) => {
    clearTimeout(timer.current)
    setJustSaved(false)
    const saved = await onSave(message)
    if (saved) {
      setJustSaved(true)
      timer.current = setTimeout(() => setJustSaved(false), SAVED_FOR_MS)
    }
    return saved
  }

  const actionable = state === "unsaved" || state === "failed"
  const revertable = changed && state !== "saving" && !reverting
  const hint =
    state === "saving"
      ? saveHints.saving
      : state === "failed"
        ? saveHints.failed(sentence(failed!))
        : state === "blocked"
          ? blocked!
          : state === "saved"
            ? saveHints.saved
            : state === "clean"
              ? saveHints.clean
              : saveHint
  const explain = (label: string, hint: string) =>
    labelsInHints ? (
      <>
        <span className="font-medium">{label}</span>
        <br />
        <span>{hint}</span>
      </>
    ) : (
      hint
    )
  const announcement = state === "saved" ? "Saved" : state === "failed" ? `Couldn't save: ${sentence(failed!)}` : ""

  return (
    <span role="group" aria-label="Save" data-save-state={state} className="inline-flex shrink-0 items-center gap-1">
      <span role="status" className="sr-only">
        {announcement}
      </span>
      {writing ? (
        <OneLineField
          label="Revision message"
          placeholder="What changed"
          saveLabel="Save with this message"
          saveHint="Saves this version with your note"
          onSave={async (message) => {
            const saved = await save(message === "" ? null : message)
            if (saved) setWriting(false)
            return saved
          }}
          onCancel={() => setWriting(false)}
        />
      ) : (
        <>
          <Button
            variant={state === "failed" ? "danger" : actionable || state === "saving" ? "primary" : "ghost"}
            aria-label="Save"
            disabled={!actionable}
            focusableWhenDisabled
            aria-busy={state === "saving" || undefined}
            className={`${square} ${state === "clean" || state === "blocked" ? inert : ""} ${
              state === "saved"
                ? "cursor-default bg-transparent! text-success! opacity-100! data-disabled:pointer-events-auto!"
                : ""
            } ${state === "saving" ? "data-disabled:pointer-events-auto! data-disabled:opacity-100!" : ""}`}
            hint={explain("Save", hint)}
            onClick={() => actionable && void save(null)}
          >
            {state === "saving" ? (
              <Spinner />
            ) : state === "saved" ? (
              <Icon name="check" />
            ) : state === "failed" ? (
              <Icon name="alert" />
            ) : (
              <Icon name="save" />
            )}
          </Button>
          <Button
            variant="ghost"
            aria-label="Save with a message…"
            disabled={!actionable}
            focusableWhenDisabled
            className={`${square} ${actionable ? "" : inert}`}
            hint={explain(
              "Save with a message…",
              actionable ? saveHints.message : state === "saving" ? saveHints.saving : hint
            )}
            onClick={() => actionable && setWriting(true)}
          >
            <Icon name="save-message" />
          </Button>
          {onRevert && (
            // Always shown (owner, 2026-11-02): greyed out while there's nothing to revert.
            <Button
              variant="ghost"
              aria-label={revertLabel}
              pending={reverting}
              disabled={!revertable}
              focusableWhenDisabled
              className={`${square} ${revertable || reverting ? "" : inert}`}
              hint={explain(
                revertLabel,
                reverting
                  ? "Reverting these edits…"
                  : state === "saving"
                    ? "Wait for this revision to finish saving."
                    : !changed
                      ? "No edits to revert."
                      : revertHint
              )}
              onClick={() => {
                if (!revertable) return
                setReverting(true)
                void onRevert().finally(() => setReverting(false))
              }}
            >
              {!reverting && <Icon name="undo" />}
            </Button>
          )}
        </>
      )}
    </span>
  )
}

// One fixed-size revision cluster for every editor (DESIGN §10.1, saveflow).
import { useEffect, useRef, useState } from "react"
import { Button } from "./Button.tsx"
import { Icon } from "./Icon.tsx"
import { OneLineField } from "./OneLineField.tsx"
import { Spinner } from "./Spinner.tsx"
import { WindowClose } from "./WindowClose.tsx"

const hints = {
  save: "Save a revision: a version of this you can go back to from History.",
  message: "Save a revision with a note saying what changed.",
  revert: "Revert to the last revision.",
  clean: "No changes since the last revision."
}
const square = "h-8! w-8! px-0!"
const inert =
  "cursor-default bg-transparent! text-muted! opacity-50 data-disabled:pointer-events-auto! data-disabled:opacity-50! hover:bg-transparent!"

export function SaveControls({
  changed,
  pending = false,
  blocked = null,
  failed = null,
  onSave,
  onRevert,
  adds = null
}: {
  changed: boolean
  pending?: boolean
  blocked?: string | null
  failed?: string | null
  onSave: (message: string | null) => Promise<boolean>
  onRevert: () => Promise<unknown>
  /** A card not in the user's cards yet, which saving adds (spec/CARD-SOURCES.md §4.5): its name. */
  adds?: string | null
}) {
  const saveHint = adds === null ? hints.save : `Saves your changes and adds ${adds} to your cards.`
  const messageHint =
    adds === null ? hints.message : `Saves your changes with a note saying what changed and adds ${adds} to your cards.`
  const [writing, setWriting] = useState(false)
  const [reverting, setReverting] = useState(false)
  const [justSaved, setJustSaved] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const messageButton = useRef<HTMLButtonElement>(null)
  useEffect(() => () => clearTimeout(timer.current), [])
  const state = pending
    ? "saving"
    : blocked && changed
      ? "blocked"
      : failed
        ? "failed"
        : changed
          ? "unsaved"
          : justSaved
            ? "saved"
            : "clean"
  const actionable = changed && !pending && !reverting && !blocked
  const revertable = changed && !pending && !reverting
  const close = () => {
    setWriting(false)
    messageButton.current?.focus()
  }
  const save = async (message: string | null) => {
    clearTimeout(timer.current)
    setJustSaved(false)
    const saved = await onSave(message)
    if (saved) {
      close()
      setJustSaved(true)
      timer.current = setTimeout(() => setJustSaved(false), 1800)
    }
    return saved
  }
  return (
    <span
      role="group"
      aria-label="Save"
      data-save-state={state}
      className="relative inline-flex shrink-0 items-start gap-1"
    >
      <Button
        variant={failed ? "danger" : actionable || pending ? "primary" : "ghost"}
        aria-label="Save"
        disabled={!actionable}
        focusableWhenDisabled
        aria-busy={pending || undefined}
        className={`${square} ${pending ? "data-disabled:pointer-events-auto! data-disabled:opacity-100!" : actionable ? "" : inert}`}
        hint={actionable ? saveHint : hints.clean}
        onClick={() => actionable && void save(null)}
      >
        {pending ? <Spinner /> : <Icon name="save" />}
      </Button>
      <Button
        ref={messageButton}
        variant="ghost"
        aria-label="Save with message…"
        aria-pressed={writing}
        disabled={!actionable}
        focusableWhenDisabled
        className={`${square} ${actionable ? "" : inert}`}
        hint={actionable ? messageHint : hints.clean}
        onClick={() => actionable && setWriting(!writing)}
      >
        <Icon name="save-message" />
      </Button>
      <Button
        variant="ghost"
        aria-label="Revert"
        pending={reverting}
        disabled={!revertable}
        focusableWhenDisabled
        className={`${square} ${revertable ? "" : inert}`}
        hint={revertable ? hints.revert : hints.clean}
        onClick={() => {
          if (!revertable) return
          setReverting(true)
          void onRevert().finally(() => setReverting(false))
        }}
      >
        {!reverting && <Icon name="undo" />}
      </Button>
      <span
        role="status"
        data-layout-overlay="Brief revision confirmation appears below the fixed save cluster"
        className={`pointer-events-none absolute top-full right-0 z-10 rounded bg-surface text-xs ${failed ? "w-64 whitespace-normal text-danger" : "max-w-full whitespace-normal text-success"}`}
      >
        {failed ? `Couldn't save: ${failed}` : justSaved && !changed ? "Revision saved." : ""}
      </span>
      {writing && (
        <span
          data-layout-overlay="Revision message opens below the save buttons"
          className="absolute top-full right-0 z-20 mt-1 flex w-64 flex-col gap-2 rounded-md border border-border bg-surface-raised p-2 shadow-lg"
        >
          <span className="flex items-center justify-between gap-2 text-sm">
            Revision message
            <WindowClose onClick={close} />
          </span>
          <OneLineField
            label="Revision message"
            placeholder="What changed"
            saveLabel="Save with this message"
            saveHint={messageHint}
            onSave={(message) => save(message === "" ? null : message)}
            onCancel={close}
          />
        </span>
      )}
    </span>
  )
}

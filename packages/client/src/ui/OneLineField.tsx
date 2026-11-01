// A one-line field in place, with its Save and Cancel beside it: Enter saves, Escape cancels.
// What "Save with a message…" and a revision's message in History open (owner, 2026-11-01).
import { useState } from "react"
import { Input } from "./Field.tsx"
import { IconButton } from "./Tooltip.tsx"

export function OneLineField({
  label,
  initial = "",
  placeholder,
  saveLabel,
  saveHint,
  cancelLabel = "Cancel",
  maxLength = 500,
  onSave,
  onCancel
}: {
  /** The field's accessible name. */
  label: string
  initial?: string
  placeholder?: string
  /** The Save button's name and its explanation. */
  saveLabel: string
  saveHint: string
  cancelLabel?: string
  maxLength?: number
  /** False (or a promise of it) keeps the field open. */
  onSave: (text: string) => boolean | void | Promise<boolean | void>
  onCancel: () => void
}) {
  const [text, setText] = useState(initial)
  const [pending, setPending] = useState(false)
  const save = async () => {
    if (pending) return
    setPending(true)
    const kept = await onSave(text.trim())
    setPending(false)
    if (kept === false) return
  }
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1">
      <Input
        aria-label={label}
        value={text}
        autoFocus
        maxLength={maxLength}
        placeholder={placeholder}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setText(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault()
            void save()
          } else if (event.key === "Escape") {
            event.preventDefault()
            event.stopPropagation()
            onCancel()
          }
        }}
        className="h-8 min-w-0 flex-1"
      />
      <IconButton
        label={saveLabel}
        hint={`${saveHint} (Enter)`}
        icon="check"
        disabled={pending}
        onClick={() => void save()}
      />
      <IconButton label={cancelLabel} hint={`${cancelLabel} (Escape)`} icon="close" onClick={onCancel} />
    </span>
  )
}

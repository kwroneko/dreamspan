// A name with a pencil beside it: the pencil turns the name into a field with Save and Cancel
// beside it; Enter saves, Escape cancels. The usual way to rename one thing in place.
import { type ReactNode, useEffect, useRef, useState } from "react"
import { Input } from "./Field.tsx"
import { IconButton } from "./Tooltip.tsx"

export function InlineRename({
  value,
  label,
  onRename,
  children,
  allowEmpty = false,
  className = "",
  inputClassName = "",
  hint = "Rename",
  fieldLabel,
  goTo
}: {
  /** The name as it is, what the field starts with. */
  value: string
  /** What's renamed, for the controls' names: "Rename <label>". */
  label: string
  /** Saves the name; false (or a promise of it) keeps the field open. */
  onRename: (next: string) => boolean | void | Promise<boolean | void>
  /** How the name shows when not being renamed; the value by default. */
  children?: ReactNode
  /** An empty name is allowed (a prompt then shows its first words). */
  allowEmpty?: boolean
  className?: string
  inputClassName?: string
  /** The pencil's tooltip: what the name is, when that isn't obvious ("Rename" by default). */
  hint?: ReactNode
  /** The field's accessible name while renaming ("New name for <label>" by default). */
  fieldLabel?: string
  /** A search match in the name: opens the field with that part selected. */
  goTo?: { readonly at: number; readonly length: number } | undefined
}) {
  const [typed, setTyped] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const [lastGoTo, setLastGoTo] = useState(goTo)
  if (goTo !== lastGoTo) {
    setLastGoTo(goTo)
    if (goTo) setTyped(value)
  }
  useEffect(() => {
    if (!goTo) return
    const frame = requestAnimationFrame(() => {
      input.current?.focus({ preventScroll: true })
      input.current?.setSelectionRange(goTo.at, goTo.at + goTo.length)
    })
    return () => cancelAnimationFrame(frame)
  }, [goTo])
  const [pending, setPending] = useState(false)
  const save = async () => {
    if (typed === null || pending) return
    if (!allowEmpty && typed.trim() === "") return
    if (typed === value) return setTyped(null)
    setPending(true)
    const kept = await onRename(allowEmpty ? typed : typed.trim())
    setPending(false)
    if (kept !== false) setTyped(null)
  }
  if (typed === null)
    return (
      <span className={`flex min-w-0 items-center gap-0.5 ${className}`}>
        {children ?? <span className="min-w-0 [overflow-wrap:anywhere]">{value}</span>}
        <IconButton
          label={`Rename ${label}`}
          hint={hint}
          icon="edit"
          className="size-7! shrink-0"
          onClick={() => setTyped(value)}
        />
      </span>
    )
  return (
    <span className={`flex min-w-0 flex-1 items-center gap-1 ${className}`}>
      <Input
        aria-label={fieldLabel ?? `New name for ${label}`}
        ref={input}
        value={typed}
        autoFocus
        onFocus={(event) => {
          if (!goTo) event.currentTarget.select()
        }}
        onChange={(event) => setTyped(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault()
            void save()
          } else if (event.key === "Escape") {
            event.preventDefault()
            event.stopPropagation()
            setTyped(null)
          }
        }}
        className={`h-8 min-w-0 flex-1 ${inputClassName}`}
      />
      <IconButton
        label="Save the name"
        hint="Save the name (Enter)"
        icon="check"
        disabled={pending || (!allowEmpty && typed.trim() === "")}
        onClick={() => void save()}
      />
      <IconButton label="Cancel renaming" hint="Cancel (Escape)" icon="close" onClick={() => setTyped(null)} />
    </span>
  )
}

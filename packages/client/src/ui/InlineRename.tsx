import { SearchHighlights, type HighlightRange } from "./SearchHighlights.tsx"
// A name with a pencil beside it: the pencil turns the name into a field with Save and Cancel
// beside it; Enter saves, Escape cancels. The usual way to rename one thing in place.
// `lastLine` keeps the pencil after the last visible line of a clamped heading. What's typed,
// and that the field is open, are kept under `place` (ui/durableFields.tsx): a reload opens
// the field again with the text typed in it.
import { type ReactNode, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react"
import { type DurableText, useDurableFields } from "./durableFields.tsx"
import { Input } from "./Field.tsx"
import { IconButton } from "./Tooltip.tsx"
import { Button } from "./Button.tsx"
import { Icon } from "./Icon.tsx"

export function InlineRename({
  place,
  compact = false,
  value,
  label,
  onRename,
  children,
  allowEmpty = false,
  className = "",
  inputClassName = "",
  placeholder,
  hint = "Rename",
  fieldLabel,
  goTo,
  highlights = [],
  lastLine = false,
  editLabel,
  editText,
  saveLabel = "Save the name",
  cancelLabel = "Cancel renaming",
  maxLength,
  onEditingChange
}: {
  /** What's renamed, unique to it ("branch:<fork>", "card-name:<ref>"): the key its typing is kept under. */
  place: string
  /** Fit a branch title without increasing its height. */
  compact?: boolean
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
  placeholder?: string
  /** The pencil's tooltip: what the name is, when that isn't obvious ("Rename" by default). */
  hint?: ReactNode
  /** The field's accessible name while renaming ("New name for <label>" by default). */
  fieldLabel?: string
  /** A search match in the name: opens the field with that part selected. */
  goTo?: { readonly at: number; readonly length: number } | undefined
  /** Matches in the name while its text box is open. */
  highlights?: ReadonlyArray<HighlightRange>
  /** Position the pencil after the last visible line of [data-inline-rename-text]. */
  lastLine?: boolean
  editLabel?: string
  /** Optional text beside the pencil, for an empty value’s add action. */
  editText?: string | undefined
  saveLabel?: string
  cancelLabel?: string
  maxLength?: number
  onEditingChange?: (editing: boolean) => void
}) {
  const fields = useDurableFields()
  const [editing, setEditing] = fields.useOpen(`rename:${place}`)
  useEffect(() => onEditingChange?.(editing), [editing, onEditingChange])
  const display = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    if (!lastLine || editing) return
    const root = display.current!
    const text = root.querySelector<HTMLElement>("[data-inline-rename-text]")!
    const pencil = root.querySelector<HTMLElement>("button")!
    const metrics = document.createElement("canvas").getContext("2d")!
    const place = () => {
      const bounds = root.getBoundingClientRect()
      const area = text.getBoundingClientRect()
      const range = document.createRange()
      range.selectNodeContents(text)
      const lines = [...range.getClientRects()].filter((line) => line.top < area.bottom && line.bottom > area.top)
      const last = lines.at(-1)
      if (!last) return
      const clipped = text.scrollHeight > text.clientHeight + 1
      // A clamped line can end at a word well before its box's right edge. Include
      // the ellipsis there instead of leaving that unused line width before the pencil.
      metrics.font = getComputedStyle(text).font
      const end = Math.min(area.right, last.right + (clipped ? metrics.measureText("…").width : 0))
      pencil.style.left = `${end - bounds.left + 2}px`
      pencil.style.top = `${area.bottom - bounds.top - pencil.offsetHeight}px`
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(root)
    observer.observe(text)
    let active = true
    void document.fonts.ready.then(() => {
      if (active) place()
    })
    return () => {
      active = false
      observer.disconnect()
    }
  }, [lastLine, editing, children])
  // A Go to (a prompt opened at a match in its name) opens the field at the match.
  // Only a new Go to opens it: closing it afterwards stays closed.
  const openAtMatch = useEffectEvent(() => setEditing(true))
  useEffect(() => {
    if (goTo) openAtMatch()
  }, [goTo])
  if (!editing)
    return (
      <span
        ref={display}
        data-layout-audit-ignore={
          lastLine ? "inset: Borderless name and pencil share the header's content inset" : undefined
        }
        className={`${lastLine ? "relative block w-fit max-w-full pr-[30px]" : "flex min-w-0 items-center gap-0.5"} ${className}`}
      >
        {children ?? <span className="min-w-0 [overflow-wrap:anywhere]">{value}</span>}
        {editText ? (
          <Button
            variant="ghost"
            className="h-8 px-2"
            aria-label={editLabel ?? `Rename ${label}`}
            hint={hint}
            onClick={() => setEditing(true)}
          >
            <Icon name="edit" />
            {editText}
          </Button>
        ) : (
          <IconButton
            label={editLabel ?? `Rename ${label}`}
            hint={hint}
            icon="edit"
            data-layout-overlay={
              lastLine ? "Pencil follows the text inside the blank part of a multiline heading's box" : undefined
            }
            className={`${compact ? "size-5! [&_svg]:size-3!" : "size-7!"} shrink-0 ${lastLine ? "absolute" : ""}`}
            onClick={() => setEditing(true)}
          />
        )}
      </span>
    )
  return (
    <RenameField
      useText={fields.useText}
      place={place}
      value={value}
      label={label}
      compact={compact}
      className={className}
      inputClassName={inputClassName}
      placeholder={placeholder}
      fieldLabel={fieldLabel}
      goTo={goTo}
      highlights={highlights}
      saveLabel={saveLabel}
      cancelLabel={cancelLabel}
      maxLength={maxLength}
      allowEmpty={allowEmpty}
      onRename={onRename}
      close={() => setEditing(false)}
    >
      {children}
    </RenameField>
  )
}

/** The open field: its text is read and kept only while it's open, so a list of names reads nothing. */
function RenameField({
  useText,
  place,
  value,
  label,
  compact,
  className,
  inputClassName,
  placeholder,
  fieldLabel,
  goTo,
  highlights,
  saveLabel,
  cancelLabel,
  maxLength,
  allowEmpty,
  onRename,
  close,
  children
}: {
  useText: (key: string, field: string, saved: string) => DurableText
  place: string
  value: string
  label: string
  compact: boolean
  className: string
  inputClassName: string
  placeholder: string | undefined
  fieldLabel: string | undefined
  goTo: { readonly at: number; readonly length: number } | undefined
  highlights: ReadonlyArray<HighlightRange>
  saveLabel: string
  cancelLabel: string
  maxLength: number | undefined
  allowEmpty: boolean
  onRename: (next: string) => boolean | void | Promise<boolean | void>
  close: () => void
  children: ReactNode
}) {
  const draft = useText(`rename:${place}`, "Name", value)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!goTo) return
    const frame = requestAnimationFrame(() => {
      input.current?.focus({ preventScroll: true })
      input.current?.setSelectionRange(goTo.at, goTo.at + goTo.length)
      input.current?.scrollIntoView({ block: "center" })
    })
    return () => cancelAnimationFrame(frame)
  }, [goTo])
  const typed = draft.text
  const [pending, setPending] = useState(false)
  const cancel = () => {
    draft.discard()
    close()
  }
  const save = async () => {
    if (pending) return
    if (!allowEmpty && typed.trim() === "") return
    if (typed === value) return cancel()
    setPending(true)
    const kept = await onRename(allowEmpty ? typed : typed.trim())
    setPending(false)
    if (kept !== false) {
      draft.commit()
      close()
    }
  }
  const editor = (
    <span
      data-renaming=""
      className={`flex min-w-0 flex-1 items-center gap-1 ${compact ? "absolute inset-x-0 top-0 h-5 [&_button]:size-5! [&_button_svg]:size-3!" : ""} ${className}`}
    >
      <SearchHighlights value={typed} ranges={highlights} className="flex max-w-controls flex-1">
        <Input
          aria-label={fieldLabel ?? `New name for ${label}`}
          ref={input}
          value={typed}
          placeholder={placeholder}
          maxLength={maxLength}
          readOnly={!draft.ready}
          autoFocus
          onFocus={(event) => {
            if (!goTo) event.currentTarget.select()
          }}
          onChange={(event) => draft.setText(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault()
              void save()
            } else if (event.key === "Escape") {
              event.preventDefault()
              event.stopPropagation()
              cancel()
            }
          }}
          className={`h-8 min-w-0 flex-1 ${compact ? "h-5! px-1! py-0! text-sm!" : ""} ${inputClassName}`}
        />
      </SearchHighlights>
      <IconButton
        label={saveLabel}
        hint={`${saveLabel} (Enter)`}
        icon="check"
        disabled={pending || (!allowEmpty && typed.trim() === "")}
        onClick={() => void save()}
      />
      <IconButton
        label={cancelLabel}
        hint={cancelLabel === "Cancel renaming" ? "Cancel (Escape)" : `${cancelLabel} (Escape)`}
        icon="close"
        onClick={cancel}
      />
    </span>
  )
  return compact ? (
    <span className={`relative block min-w-0 ${className}`}>
      <span aria-hidden="true" className="invisible flex min-w-0 items-center gap-0.5">
        {children ?? value}
        <span className="size-5 shrink-0" />
      </span>
      {editor}
    </span>
  ) : (
    editor
  )
}

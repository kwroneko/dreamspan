import { Field as BaseField } from "@base-ui/react/field"
import { Fieldset as BaseFieldset } from "@base-ui/react/fieldset"
import { Input as BaseInput } from "@base-ui/react/input"
import { useState, type ComponentProps, type ReactNode, type SyntheticEvent } from "react"
import { EditorTextActions, runEditorShortcut, useEditorFocus } from "../textActions.tsx"

// 16px text on touch screens, so iOS doesn't zoom into a focused field.
const control =
  "w-full min-w-0 rounded-md border border-border bg-surface px-3 text-base text-text shadow-xs outline-none transition-shadow placeholder:text-muted focus-visible:border-focus focus-visible:ring-2 focus-visible:ring-focus/40 disabled:opacity-50 data-invalid:border-danger sm:text-sm"

/**
 * A labelled form control. Base UI ties the label, description and error to the control,
 * so screen readers announce them together.
 */
export function Field({
  label,
  description,
  error,
  children,
  className = "",
  labelHidden = false
}: {
  label: ReactNode
  /** The label names the control for assistive technology only: what's around it already says. */
  labelHidden?: boolean
  description?: ReactNode
  /** Shown under the control, and marks it invalid. */
  error?: string | null | undefined
  children: ReactNode
  className?: string
}) {
  return (
    <BaseField.Root invalid={error ? true : undefined} className={`flex min-w-0 flex-col gap-1.5 ${className}`}>
      <BaseField.Label className={labelHidden ? "sr-only" : "text-sm font-medium text-text"}>{label}</BaseField.Label>
      {children}
      {description && <BaseField.Description className="text-sm text-muted">{description}</BaseField.Description>}
      {error && (
        <BaseField.Error match className="text-sm text-danger">
          {error}
        </BaseField.Error>
      )}
    </BaseField.Root>
  )
}

/** Single-line values are controls; prose belongs in a full-width Textarea or CodeEditor. */
export function Input({
  className = "",
  fullWidth = false,
  ...props
}: ComponentProps<typeof BaseInput> & {
  /** Opt in only when a single-line field genuinely needs the editor's whole width. */
  fullWidth?: boolean
}) {
  const numeric = props.type === "number" || props.inputMode === "numeric" || props.inputMode === "decimal"
  const width = fullWidth ? "max-w-none" : numeric ? "max-w-32" : "max-w-controls"
  return <BaseInput className={`h-9 ${control} ${width} ${className}`} {...props} />
}

/** Whether CSS can mask a text field. Asked at render, so a test can stand in for an old browser. */
const cssMasks = () => typeof CSS !== "undefined" && CSS.supports("-webkit-text-security", "disc")

/**
 * A secret being typed: an API key, a header value, a proxy URL with a password. Read it
 * from the form's data on submit; `onEmptyChange` reports only whether it's empty.
 * - Uncontrolled, so React never mirrors it into the DOM's `value` attribute.
 * - Plain text, so browsers' password managers don't offer to save it as a password and
 *   later fill it into the login form; the password-manager extensions' own opt-outs too.
 * - `masked` hides the characters with CSS (`-webkit-text-security`). A browser without
 *   it gets a password field instead (opt-outs kept), so a key is never shown in clear.
 *   A URL stays readable.
 */
export function SecretInput({
  name,
  masked = true,
  onEmptyChange,
  placeholder,
  className = ""
}: {
  name: string
  masked?: boolean
  onEmptyChange?: (empty: boolean) => void
  placeholder?: string | undefined
  className?: string
}) {
  return (
    <Input
      name={name}
      type={masked && !cssMasks() ? "password" : "text"}
      autoComplete="off"
      autoCapitalize="none"
      autoCorrect="off"
      spellCheck={false}
      placeholder={placeholder}
      data-1p-ignore=""
      data-lpignore="true"
      data-bwignore=""
      data-form-type="other"
      onValueChange={(value) => onEmptyChange?.(value.trim() === "")}
      className={`${masked ? "[-webkit-text-security:disc]" : ""} ${className}`}
    />
  )
}

/** An account password: a real password field for password managers, uncontrolled like `SecretInput`. */
export function PasswordInput({
  name,
  autoComplete,
  onEmptyChange
}: {
  name: string
  autoComplete: "current-password" | "new-password"
  onEmptyChange?: (empty: boolean) => void
}) {
  return (
    <Input
      name={name}
      type="password"
      autoComplete={autoComplete}
      onValueChange={(value) => onEmptyChange?.(value === "")}
    />
  )
}

/**
 * After a submit the client refused: focus the first invalid control once its error has
 * rendered. Its description includes the error, so a screen reader reads it out.
 */
export const focusFirstInvalid = (form: HTMLFormElement) => {
  requestAnimationFrame(() =>
    form.querySelector<HTMLElement>('[aria-invalid="true"], [data-invalid]:is(input, textarea)')?.focus()
  )
}

/** A form field's text, from the form being submitted. */
export const formText = (form: HTMLFormElement, name: string) => {
  const value = new FormData(form).get(name)
  return typeof value === "string" ? value : ""
}

/**
 * A text box; `textActions` for prose (a message, an instruction, an entry's text) puts the
 * editor's text actions under it (Send to snippet, say) while it has focus. A box of settings,
 * keys, tags, patterns or addresses has none (owner, 2026-11-01).
 */
export function Textarea({
  className = "",
  textActions = false,
  ...props
}: ComponentProps<"textarea"> & { textActions?: boolean }) {
  const [text, setText] = useState({ value: "", selection: "" })
  const { focused, onFocus, onBlur } = useEditorFocus()
  if (!textActions || props.disabled)
    return <BaseField.Control render={<textarea className={`min-h-24 py-2 ${control} ${className}`} {...props} />} />
  const read = (event: SyntheticEvent<HTMLTextAreaElement>) => {
    const box = event.currentTarget
    const next = { value: box.value, selection: box.value.slice(box.selectionStart, box.selectionEnd) }
    if (next.value !== text.value || next.selection !== text.selection) setText(next)
  }
  const value = typeof props.value === "string" ? props.value : text.value
  const selection = focused ? text.selection : ""
  return (
    <div
      className="group/text flex min-w-0 flex-col gap-0.5"
      onFocus={onFocus}
      onBlur={onBlur}
      // A key comes from inside, so the box has focus: its selection as it is now.
      onKeyDown={(event) => {
        const box = event.target instanceof HTMLTextAreaElement ? event.target : null
        runEditorShortcut(event, value, box ? box.value.slice(box.selectionStart, box.selectionEnd) : selection)
      }}
    >
      <BaseField.Control
        render={
          <textarea
            className={`min-h-24 py-2 ${control} ${className}`}
            {...props}
            onSelect={(event) => {
              read(event)
              props.onSelect?.(event)
            }}
            onInput={(event) => {
              read(event)
              props.onInput?.(event)
            }}
            onFocus={(event) => {
              read(event)
              props.onFocus?.(event)
            }}
          />
        }
      />
      <EditorTextActions text={value} selection={selection} shown={focused} />
    </div>
  )
}

/** A group of related controls with a legend, such as a set of radio buttons. */
export function Fieldset({
  legend,
  description,
  children,
  className = ""
}: {
  legend: ReactNode
  description?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <BaseFieldset.Root className={`flex min-w-0 flex-col gap-2 ${className}`}>
      <BaseFieldset.Legend className="text-sm font-medium text-text">{legend}</BaseFieldset.Legend>
      {description && <p className="text-sm text-muted">{description}</p>}
      {children}
    </BaseFieldset.Root>
  )
}

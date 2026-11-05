import { Field as BaseField } from "@base-ui/react/field"
import { Fieldset as BaseFieldset } from "@base-ui/react/fieldset"
import { Input as BaseInput } from "@base-ui/react/input"
import { useState, type ComponentProps, type ReactNode, type SyntheticEvent } from "react"
import { EditorTextActions, runEditorShortcut, useEditorFocus } from "../textActions.tsx"
import { AboutHint, LabelWithHelp } from "./AboutHint.tsx"
import { FieldFrame, framedControl } from "./FieldFrame.tsx"

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
  about,
  aboutLabel,
  error,
  children,
  className = "",
  labelHidden = false,
  labelEnd
}: {
  label: ReactNode
  /** At the end of the label's row (or a row of its own, the label hidden): the field's tabs, say. */
  labelEnd?: ReactNode
  /** The label names the control for assistive technology only: what's around it already says. */
  labelHidden?: boolean
  /** Visible state or guidance that must stay beside the control. */
  description?: ReactNode
  /** Help for choosing a value, beside the label. */
  about?: ReactNode
  aboutLabel?: string
  /** Shown under the control, and marks it invalid. */
  error?: string | null | undefined
  children: ReactNode
  className?: string
}) {
  const labelRow = about ? (
    <div className={labelHidden ? "sr-only" : "text-sm leading-5"}>
      <BaseField.Label className="inline text-sm font-medium text-text">{label}</BaseField.Label>
      {"\u00a0"}
      <AboutHint heading={aboutLabel ?? (typeof label === "string" ? label : "this field")}>{about}</AboutHint>
    </div>
  ) : (
    <BaseField.Label className={labelHidden ? "sr-only" : "text-sm font-medium text-text"}>{label}</BaseField.Label>
  )
  return (
    <BaseField.Root invalid={error ? true : undefined} className={`flex min-w-0 flex-col gap-1.5 ${className}`}>
      {labelEnd !== undefined && !labelHidden ? (
        <div className="flex min-w-0 flex-wrap items-end justify-between gap-x-3 gap-y-1">
          {labelRow}
          {labelEnd}
        </div>
      ) : (
        <>
          {labelRow}
          {labelEnd}
        </>
      )}
      {about && <BaseField.Description hidden>{about}</BaseField.Description>}
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

/**
 * Single-line values are controls; prose belongs in a full-width Textarea or CodeEditor.
 * `tools` and `status` go in the box's strip at its end (`FieldFrame`); `frameClassName` sizes the box then.
 */
export function Input({
  className = "",
  fullWidth = false,
  tools,
  status,
  frameClassName = "",
  ...props
}: ComponentProps<typeof BaseInput> & {
  /** Opt in only when a single-line field genuinely needs the editor's whole width. */
  fullWidth?: boolean
  tools?: ReactNode
  status?: ReactNode
  frameClassName?: string
}) {
  const numeric = props.type === "number" || props.inputMode === "numeric" || props.inputMode === "decimal"
  const width = fullWidth ? "max-w-none" : numeric ? "max-w-32" : "max-w-controls"
  if (tools === undefined && status === undefined)
    return <BaseInput className={`h-9 ${control} ${width} ${className}`} {...props} />
  return (
    <FieldFrame side="end" tools={tools} status={status} className={`${width} ${frameClassName}`}>
      <BaseInput
        data-layout-audit-ignore="inset: The text fills its own bordered field"
        className={`h-9 ${framedControl} ${className}`}
        {...props}
      />
    </FieldFrame>
  )
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
 * editor's text actions in its strip (Send to snippet, say) while it has focus. A box of settings,
 * keys, tags, patterns or addresses has none (owner, 2026-11-01). The strip (`FieldFrame`), with
 * `tools` and `status` too, is inside the box along its bottom border.
 */
export function Textarea({
  className = "",
  textActions = false,
  tools,
  status,
  ...props
}: ComponentProps<"textarea"> & { textActions?: boolean; tools?: ReactNode; status?: ReactNode }) {
  const [text, setText] = useState({ value: "", selection: "" })
  const { focused, onFocus, onBlur } = useEditorFocus()
  const actions = textActions && !props.disabled
  if (!actions && tools === undefined && status === undefined)
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
      className="group/text flex min-w-0 flex-col"
      onFocus={onFocus}
      onBlur={onBlur}
      // A key comes from inside, so the box has focus: its selection as it is now.
      onKeyDown={(event) => {
        if (!actions) return
        const box = event.target instanceof HTMLTextAreaElement ? event.target : null
        runEditorShortcut(event, value, box ? box.value.slice(box.selectionStart, box.selectionEnd) : selection)
      }}
    >
      <FieldFrame
        side="bottom"
        status={status}
        tools={
          <>
            {actions && <EditorTextActions text={value} selection={selection} shown={focused} />}
            {tools}
          </>
        }
      >
        <BaseField.Control
          render={
            <textarea
              data-layout-audit-ignore="inset: The text fills its own bordered field"
              className={`min-h-24 py-2 ${framedControl} ${className}`}
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
      </FieldFrame>
    </div>
  )
}

/** A group of related controls with a legend, such as a set of radio buttons. */
/**
 * A group of fields under its legend. `description` is a standing line of state, never an
 * explanation; `about` is an explanation the user needs to choose correctly, in a "?" beside
 * the legend (DESIGN §10.1), named after a string legend.
 */
export function Fieldset({
  legend,
  description,
  about,
  aboutLabel,
  children,
  className = ""
}: {
  legend: ReactNode
  description?: ReactNode
  about?: ReactNode
  aboutLabel?: string
  children: ReactNode
  className?: string
}) {
  const head = <BaseFieldset.Legend className="inline text-sm font-medium text-text">{legend}</BaseFieldset.Legend>
  return (
    <BaseFieldset.Root className={`flex min-w-0 flex-col gap-2 ${className}`}>
      {about ? (
        <LabelWithHelp
          help={
            <AboutHint heading={aboutLabel ?? (typeof legend === "string" ? legend : "this group")}>{about}</AboutHint>
          }
        >
          {head}
        </LabelWithHelp>
      ) : (
        head
      )}
      {description && <p className="text-sm text-muted">{description}</p>}
      {children}
    </BaseFieldset.Root>
  )
}

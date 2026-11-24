import { Field as BaseField } from "@base-ui/react/field"
import { Fieldset as BaseFieldset } from "@base-ui/react/fieldset"
import { Input as BaseInput } from "@base-ui/react/input"
import {
  useRef,
  useState,
  type ComponentProps,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type SyntheticEvent
} from "react"
import { EditorTextActions, runEditorShortcut, useEditorFocus } from "../textActions.tsx"
import { AboutHint, LabelWithHelp, useLabelTrail } from "./AboutHint.tsx"
import { FieldFrame, framedControl } from "./FieldFrame.tsx"
import { textareaResize } from "./HeightGrip.tsx"
import { Icon } from "./Icon.tsx"
import { Tooltip } from "./Tooltip.tsx"
import { TitledContainer, useRepeatsTitle } from "./titledContainer.tsx"

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
  aboutInfo = false,
  error,
  children,
  className = "",
  labelHidden: hideLabel = false,
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
  /** The help as a circled (i) at icon size, beside a bar's control, rather than the small "?". */
  aboutInfo?: boolean
  /** Shown under the control, and marks it invalid. */
  error?: string | null | undefined
  children: ReactNode
  className?: string
}) {
  // A label repeating the title of the popover or panel it's in: the title names the field.
  const repeats = useRepeatsTitle(label, hideLabel, "The field label")
  const labelHidden = hideLabel || repeats
  const trail = useLabelTrail(!labelHidden)
  const labelRow = about ? (
    <div className={labelHidden ? "sr-only" : "text-sm leading-5"}>
      <BaseField.Label className="inline text-sm font-medium text-text">{label}</BaseField.Label>
      {"\u00a0"}
      <AboutHint heading={aboutLabel ?? (typeof label === "string" ? label : "this field")} info={aboutInfo}>
        {about}
      </AboutHint>
      {trail && <> {trail}</>}
    </div>
  ) : trail ? (
    <div className={labelHidden ? "sr-only" : "text-sm leading-5"}>
      <BaseField.Label className="inline text-sm font-medium text-text">{label}</BaseField.Label> {trail}
    </div>
  ) : (
    <BaseField.Label className={labelHidden ? "sr-only" : "text-sm font-medium text-text"}>{label}</BaseField.Label>
  )
  return (
    <BaseField.Root
      invalid={error ? true : undefined}
      {...(repeats ? { "data-title-repeated": "" } : {})}
      className={`flex min-w-0 flex-col gap-1.5 ${className}`}
    >
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
  clearable = false,
  ...props
}: ComponentProps<typeof BaseInput> & {
  /** Opt in only when a single-line field genuinely needs the editor's whole width. */
  fullWidth?: boolean
  tools?: ReactNode
  status?: ReactNode
  frameClassName?: string
  /**
   * An × at the box's end while it has text: it empties the box as typing would (through its
   * `onChange`) and leaves the caret in it. The room for it is kept either way, so the box never
   * resizes; `frameClassName` sizes the box then.
   */
  clearable?: boolean
}) {
  const numeric = props.type === "number" || props.inputMode === "numeric" || props.inputMode === "decimal"
  const width = fullWidth ? "max-w-none" : numeric ? "max-w-32" : "max-w-controls"
  if (clearable && tools === undefined && status === undefined)
    return (
      <ClearableInput
        className={`h-9 ${control} ${className}`}
        frameClassName={`${width} ${frameClassName}`}
        {...props}
      />
    )
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

/** Sets the box's text the way typing does, so its own `onChange` (and whatever keeps the text) runs. */
const typeInto = (input: HTMLInputElement, text: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text)
  input.dispatchEvent(new Event("input", { bubbles: true }))
}

function ClearableInput({
  className,
  frameClassName,
  ref,
  ...props
}: ComponentProps<typeof BaseInput> & { frameClassName: string }) {
  const own = useRef<HTMLInputElement | null>(null)
  const setRef = (node: HTMLInputElement | null) => {
    own.current = node
    if (typeof ref === "function") ref(node)
    else if (ref) ref.current = node
  }
  const empty = props.value !== undefined && String(props.value) === ""
  return (
    <span
      data-layout-audit-ignore="overlap: The clear button sits in the box's end padding, kept free of text for it"
      className={`relative flex w-full min-w-0 ${frameClassName}`}
    >
      <BaseInput ref={setRef} className={`pe-8 ${className}`} {...props} />
      {!empty && !props.disabled && (
        <Tooltip label="Clear">
          <button
            type="button"
            aria-label="Clear"
            data-input-clear
            // Pressing it leaves the caret in the box.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              const input = own.current
              if (!input) return
              typeInto(input, "")
              input.focus()
            }}
            className="absolute inset-y-0 end-0 flex w-8 items-center justify-center rounded-e-md text-muted outline-none transition-colors hover:text-text focus-visible:text-text focus-visible:ring-2 focus-visible:ring-focus"
          >
            <Icon name="close" size={14} />
          </button>
        </Tooltip>
      )}
    </span>
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
  // Its corner resizes it past its max height too, and a double-click there undoes that.
  const resize = {
    onPointerDown: (event: PointerEvent<HTMLTextAreaElement>) => {
      textareaResize.onPointerDown(event)
      props.onPointerDown?.(event)
    },
    onDoubleClick: (event: MouseEvent<HTMLTextAreaElement>) => {
      textareaResize.onDoubleClick(event)
      props.onDoubleClick?.(event)
    }
  }
  if (!actions && tools === undefined && status === undefined)
    return (
      <BaseField.Control
        render={<textarea className={`min-h-24 py-2 ${control} ${className}`} {...props} {...resize} />}
      />
    )
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
              {...resize}
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
  const repeats = useRepeatsTitle(legend, false, "The group's legend")
  const head = (
    <BaseFieldset.Legend className={repeats ? "sr-only" : "inline text-sm font-medium text-text"}>
      {legend}
    </BaseFieldset.Legend>
  )
  return (
    <BaseFieldset.Root
      {...(repeats ? { "data-title-repeated": "" } : {})}
      className={`flex min-w-0 flex-col gap-2 ${className}`}
    >
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
      <TitledContainer title={legend}>{children}</TitledContainer>
    </BaseFieldset.Root>
  )
}

// Checkboxes, switches and radio groups. Each renders inside its own <label>, so the
// whole row is the click target. `description` shows under the label; a checkbox's or a
// switch's `hint` says what turning it on or off does: a tooltip on hover and focus, under
// the label on touch screens and narrow windows, and its description for screen readers.
// Settings use `about` for help in the existing ? button, outside the clickable label.
import { Checkbox as BaseCheckbox } from "@base-ui/react/checkbox"
import { Radio as BaseRadio } from "@base-ui/react/radio"
import { RadioGroup as BaseRadioGroup } from "@base-ui/react/radio-group"
import { Switch as BaseSwitch } from "@base-ui/react/switch"
import { Fragment, type ReactElement, type ReactNode, useId, useRef } from "react"
import { AboutHint, LabelWithHelp } from "./AboutHint.tsx"
import { inlineExplanationClass } from "./Explanation.tsx"
import { useRepeatsTitle } from "./titledContainer.tsx"
import { Tooltip } from "./Tooltip.tsx"

const focusRing =
  "outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"

function ChoiceLabel({
  children,
  description,
  hint,
  hidden = false,
  hintInline = true,
  compact = false,
  labelFor,
  help
}: {
  children: ReactNode
  hidden?: boolean
  description?: ReactNode
  hint?: { readonly id: string; readonly text: string } | undefined
  /** False: the hint is only the tooltip and the description, never a line under the label. */
  hintInline?: boolean
  compact?: boolean
  labelFor?: string
  help?: ReactNode
}) {
  return (
    <span className={hidden ? "sr-only" : "flex min-w-0 flex-col"}>
      <span className={compact ? "text-xs leading-4 text-muted" : "text-sm text-text"}>
        {help ? (
          <LabelWithHelp help={help}>
            <label htmlFor={labelFor}>{children}</label>
          </LabelWithHelp>
        ) : (
          children
        )}
      </span>
      {description && <span className="text-sm text-muted">{description}</span>}
      {hint && (
        // Hidden from the name, and still the description: a reference reads hidden text.
        <span
          id={hint.id}
          aria-hidden="true"
          className={`hidden pt-0.5 text-xs text-muted ${hintInline ? inlineExplanationClass : ""}`}
        >
          {hint.text}
        </span>
      )}
    </span>
  )
}

/** The row, with its hint's tooltip when it has one. */
const withHint = (hint: string | undefined, row: ReactElement) => (hint ? <Tooltip label={hint}>{row}</Tooltip> : row)

export function Checkbox({
  checked,
  onCheckedChange,
  children,
  description,
  about,
  aboutLabel,
  labelHelp,
  hint,
  indeterminate = false,
  disabled = false,
  labelHidden: hideLabel = false,
  hintInline = true
}: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  children: ReactNode
  description?: ReactNode
  about?: ReactNode
  aboutLabel?: string
  /** Custom help popup, using the shared help trigger geometry. */
  labelHelp?: ReactNode
  /** What ticking it does, when the label doesn't say. */
  hint?: string | undefined
  /**
   * False: the hint is only the tooltip, never a line under the label on a phone (a long list of
   * alike boxes whose group explains them).
   */
  hintInline?: boolean
  /** Some but not all of what it stands for are ticked (a list's header checkbox), or mixed values. */
  indeterminate?: boolean
  disabled?: boolean
  /** A checkbox whose visible label is elsewhere: its label stays out of the layout. */
  labelHidden?: boolean
}) {
  const id = useId()
  const aboutId = useId()
  // A label repeating the title of the popover or panel it's in: the title names it.
  const labelHidden = useRepeatsTitle(children, hideLabel, "The label") || hideLabel
  const help =
    labelHelp ??
    (about ? (
      <AboutHint heading={aboutLabel ?? (typeof children === "string" ? children.trim() : "this setting")}>
        {about}
      </AboutHint>
    ) : null)
  const Row = help ? "div" : "label"
  const row = (
    <Row className={`flex min-w-0 items-start ${labelHidden ? "" : "gap-2.5"}`}>
      <BaseCheckbox.Root
        id={id}
        checked={checked}
        indeterminate={indeterminate}
        disabled={disabled}
        onCheckedChange={(next) => onCheckedChange(next)}
        {...(hint || about
          ? { "aria-describedby": [hint ? `${id}-hint` : null, about ? aboutId : null].filter(Boolean).join(" ") }
          : {})}
        className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-border bg-surface text-accent-contrast data-checked:border-accent data-checked:bg-accent data-indeterminate:border-accent data-indeterminate:bg-accent data-disabled:opacity-50 ${focusRing}`}
      >
        <BaseCheckbox.Indicator className="flex data-unchecked:hidden">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true">
            <path d={indeterminate ? "M3.5 8h9" : "m2.5 8.5 4 4 7-9"} strokeWidth="2" />
          </svg>
        </BaseCheckbox.Indicator>
      </BaseCheckbox.Root>
      <ChoiceLabel
        labelFor={id}
        help={help}
        hidden={labelHidden}
        description={description}
        hint={hint ? { id: `${id}-hint`, text: hint } : undefined}
        hintInline={hintInline}
      >
        {children}
      </ChoiceLabel>
      {about && (
        <span id={aboutId} hidden>
          {about}
        </span>
      )}
    </Row>
  )
  return withHint(hint, row)
}

/**
 * A tick that picks one row of a list to act on with others (a message among the selected), its
 * label only for screen readers and its hint the tooltip. The whole 32 px square is the target,
 * as for the icon buttons beside it. `onToggle` hears whether Shift was held, for a range.
 */
export function RowTick({
  checked,
  onToggle,
  label,
  hint,
  disabled = false,
  indeterminate = false,
  className = ""
}: {
  checked: boolean
  onToggle: (checked: boolean, shift: boolean) => void
  label: string
  hint: string
  disabled?: boolean
  /** Some but not all of the rows it stands for are ticked: a list's header tick. */
  indeterminate?: boolean
  className?: string
}) {
  // The pointer or key that toggles it, read before Base UI reports the change.
  const shift = useRef(false)
  const note = (event: { shiftKey: boolean }) => {
    shift.current = event.shiftKey
  }
  return (
    <Tooltip label={hint}>
      {/* Unavailable, it stays hoverable and focusable (read-only), so its tooltip says why. */}
      <BaseCheckbox.Root
        aria-label={label}
        checked={checked}
        indeterminate={indeterminate}
        readOnly={disabled}
        {...(disabled ? { "aria-disabled": true } : {})}
        onPointerDown={note}
        onKeyDown={note}
        onCheckedChange={(next) => {
          if (!disabled) onToggle(next, shift.current)
          shift.current = false
        }}
        className={`group/tick flex size-8 shrink-0 items-center justify-center rounded-md hover:bg-hover ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"} ${focusRing} ${className}`}
      >
        <span className="flex size-4 items-center justify-center rounded-[4px] border border-border bg-surface text-accent-contrast group-data-checked/tick:border-accent group-data-checked/tick:bg-accent group-data-indeterminate/tick:border-accent group-data-indeterminate/tick:bg-accent">
          <BaseCheckbox.Indicator className="flex data-unchecked:hidden">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true">
              <path d={indeterminate ? "M3.5 8h9" : "m2.5 8.5 4 4 7-9"} strokeWidth="2" />
            </svg>
          </BaseCheckbox.Indicator>
        </span>
      </BaseCheckbox.Root>
    </Tooltip>
  )
}

export function Switch({
  checked,
  onCheckedChange,
  children,
  description,
  about,
  aboutLabel,
  labelHelp,
  hint,
  describedBy,
  labelHidden: hideLabel = false,
  disabled = false,
  compact = false,
  mixed = false
}: {
  /** The values it stands for differ (several entries at once): the thumb sits in the middle. */
  mixed?: boolean
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  children: ReactNode
  description?: ReactNode
  about?: ReactNode
  aboutLabel?: string
  /** Custom help popup, using the shared help trigger geometry. */
  labelHelp?: ReactNode
  /** What switching it on or off does, when the label doesn't say. */
  hint?: string | undefined
  /** A small, muted, centred row (a card's header), with its hint only in the tooltip. */
  compact?: boolean
  /** An explanation shown elsewhere (a row's own line), read as its description. */
  describedBy?: string | undefined
  /** A switch beside its own visible title: keep its label out of the flex layout. */
  labelHidden?: boolean
  disabled?: boolean
}) {
  const id = useId()
  const aboutId = useId()
  // A label repeating the title of the popover or panel it's in: the title names it.
  const labelHidden = useRepeatsTitle(children, hideLabel, "The label") || hideLabel
  const help =
    labelHelp ??
    (about ? (
      <AboutHint heading={aboutLabel ?? (typeof children === "string" ? children.trim() : "this setting")}>
        {about}
      </AboutHint>
    ) : null)
  const Row = help ? "div" : "label"
  const row = (
    <Row className={`flex min-w-0 ${compact ? "items-center gap-2" : "items-start gap-3"}`}>
      <BaseSwitch.Root
        id={id}
        disabled={disabled}
        checked={mixed ? false : checked}
        onCheckedChange={(next) => onCheckedChange(next)}
        {...(mixed ? { "data-mixed": "" } : {})}
        {...(hint || about || describedBy
          ? {
              "aria-describedby": [hint ? `${id}-hint` : null, about ? aboutId : null, describedBy]
                .filter(Boolean)
                .join(" ")
            }
          : {})}
        className={`${compact ? "" : "mt-0.5"} flex h-5 w-9 shrink-0 rounded-full border border-border bg-surface-raised p-0.5 transition-colors data-checked:border-accent data-checked:bg-accent data-disabled:opacity-50 data-mixed:border-dashed ${focusRing}`}
      >
        <BaseSwitch.Thumb
          className={`size-3.5 rounded-full bg-muted shadow-xs transition-[translate,background-color] data-checked:translate-x-4 data-checked:bg-accent-contrast motion-reduce:transition-none ${mixed ? "translate-x-2 opacity-60" : ""}`}
        />
      </BaseSwitch.Root>
      <ChoiceLabel
        labelFor={id}
        help={help}
        hidden={labelHidden}
        description={description}
        hint={hint ? { id: `${id}-hint`, text: hint } : undefined}
        hintInline={!compact}
        compact={compact}
      >
        {children}
      </ChoiceLabel>
      {about && (
        <span id={aboutId} hidden>
          {about}
        </span>
      )}
    </Row>
  )
  return withHint(hint, row)
}

export function RadioGroup<Value extends string>({
  value,
  onValueChange,
  options,
  ...aria
}: {
  value: Value
  onValueChange: (value: Value) => void
  options: ReadonlyArray<{
    value: Value
    label: ReactNode
    description?: ReactNode
    /** Not a choice now; `hint` then says why, on hover and focus. */
    disabled?: boolean
    hint?: string
  }>
  disabled?: boolean
  "aria-labelledby"?: string
}) {
  return (
    <BaseRadioGroup
      value={value}
      onValueChange={(next) => onValueChange(next as Value)}
      className="flex flex-col gap-2.5"
      {...aria}
    >
      {options.map((option) => (
        <Fragment key={option.value}>
          {withHint(
            option.hint,
            <label className={`flex items-start gap-2.5 ${option.disabled ? "opacity-60" : ""}`}>
              <BaseRadio.Root
                value={option.value}
                {...(option.disabled ? { disabled: true } : {})}
                className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-border bg-surface data-checked:border-accent data-disabled:opacity-50 ${focusRing}`}
              >
                <BaseRadio.Indicator className="size-2 rounded-full bg-accent data-unchecked:hidden" />
              </BaseRadio.Root>
              <ChoiceLabel description={option.description}>{option.label}</ChoiceLabel>
            </label>
          )}
        </Fragment>
      ))}
    </BaseRadioGroup>
  )
}

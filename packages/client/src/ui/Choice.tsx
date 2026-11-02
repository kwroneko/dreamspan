// Checkboxes, switches and radio groups. Each renders inside its own <label>, so the
// whole row is the click target. `description` shows under the label; a checkbox's or a
// switch's `hint` says what turning it on or off does: a tooltip on hover and focus, under
// the label on touch screens and narrow windows, and its description for screen readers.
import { Checkbox as BaseCheckbox } from "@base-ui/react/checkbox"
import { Radio as BaseRadio } from "@base-ui/react/radio"
import { RadioGroup as BaseRadioGroup } from "@base-ui/react/radio-group"
import { Switch as BaseSwitch } from "@base-ui/react/switch"
import { type ReactElement, type ReactNode, useId } from "react"
import { inlineExplanationClass } from "./Explanation.tsx"
import { Tooltip } from "./Tooltip.tsx"

const focusRing =
  "outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"

function ChoiceLabel({
  children,
  description,
  hint,
  hidden = false
}: {
  children: ReactNode
  hidden?: boolean
  description?: ReactNode
  hint?: { readonly id: string; readonly text: string } | undefined
}) {
  return (
    <span className={hidden ? "sr-only" : "flex min-w-0 flex-col"}>
      <span className="text-sm text-text">{children}</span>
      {description && <span className="text-sm text-muted">{description}</span>}
      {hint && (
        // Hidden from the name, and still the description: a reference reads hidden text.
        <span id={hint.id} aria-hidden="true" className={`hidden pt-0.5 text-xs text-muted ${inlineExplanationClass}`}>
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
  hint
}: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  children: ReactNode
  description?: ReactNode
  /** What ticking it does, when the label doesn't say. */
  hint?: string | undefined
}) {
  const id = useId()
  return withHint(
    hint,
    <label className="flex items-start gap-2.5">
      <BaseCheckbox.Root
        checked={checked}
        onCheckedChange={(next) => onCheckedChange(next)}
        {...(hint ? { "aria-describedby": id } : {})}
        className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-border bg-surface text-accent-contrast data-checked:border-accent data-checked:bg-accent data-disabled:opacity-50 ${focusRing}`}
      >
        <BaseCheckbox.Indicator className="flex data-unchecked:hidden">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true">
            <path d="m2.5 8.5 4 4 7-9" strokeWidth="2" />
          </svg>
        </BaseCheckbox.Indicator>
      </BaseCheckbox.Root>
      <ChoiceLabel description={description} hint={hint ? { id, text: hint } : undefined}>
        {children}
      </ChoiceLabel>
    </label>
  )
}

export function Switch({
  checked,
  onCheckedChange,
  children,
  description,
  hint,
  describedBy,
  labelHidden = false,
  disabled = false
}: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  children: ReactNode
  description?: ReactNode
  /** What switching it on or off does, when the label doesn't say. */
  hint?: string | undefined
  /** An explanation shown elsewhere (a row's own line), read as its description. */
  describedBy?: string | undefined
  /** A switch beside its own visible title: keep its label out of the flex layout. */
  labelHidden?: boolean
  disabled?: boolean
}) {
  const id = useId()
  return withHint(
    hint,
    <label className="flex items-start gap-3">
      <BaseSwitch.Root
        disabled={disabled}
        checked={checked}
        onCheckedChange={(next) => onCheckedChange(next)}
        {...(hint ? { "aria-describedby": id } : describedBy ? { "aria-describedby": describedBy } : {})}
        className={`mt-0.5 flex h-5 w-9 shrink-0 rounded-full border border-border bg-surface-raised p-0.5 transition-colors data-checked:border-accent data-checked:bg-accent data-disabled:opacity-50 ${focusRing}`}
      >
        <BaseSwitch.Thumb className="size-3.5 rounded-full bg-muted shadow-xs transition-[translate,background-color] data-checked:translate-x-4 data-checked:bg-accent-contrast motion-reduce:transition-none" />
      </BaseSwitch.Root>
      <ChoiceLabel hidden={labelHidden} description={description} hint={hint ? { id, text: hint } : undefined}>
        {children}
      </ChoiceLabel>
    </label>
  )
}

export function RadioGroup<Value extends string>({
  value,
  onValueChange,
  options,
  ...aria
}: {
  value: Value
  onValueChange: (value: Value) => void
  options: ReadonlyArray<{ value: Value; label: ReactNode; description?: ReactNode }>
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
        <label key={option.value} className="flex items-start gap-2.5">
          <BaseRadio.Root
            value={option.value}
            className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-border bg-surface data-checked:border-accent data-disabled:opacity-50 ${focusRing}`}
          >
            <BaseRadio.Indicator className="size-2 rounded-full bg-accent data-unchecked:hidden" />
          </BaseRadio.Root>
          <ChoiceLabel description={option.description}>{option.label}</ChoiceLabel>
        </label>
      ))}
    </BaseRadioGroup>
  )
}

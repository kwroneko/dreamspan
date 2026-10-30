// Checkboxes, switches and radio groups. Each renders inside its own <label>, so the
// whole row is the click target.
import { Checkbox as BaseCheckbox } from "@base-ui/react/checkbox"
import { Radio as BaseRadio } from "@base-ui/react/radio"
import { RadioGroup as BaseRadioGroup } from "@base-ui/react/radio-group"
import { Switch as BaseSwitch } from "@base-ui/react/switch"
import type { ReactNode } from "react"

const focusRing =
  "outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"

function ChoiceLabel({ children, description }: { children: ReactNode; description?: ReactNode }) {
  return (
    <span className="flex min-w-0 flex-col">
      <span className="text-sm text-text">{children}</span>
      {description && <span className="text-sm text-muted">{description}</span>}
    </span>
  )
}

export function Checkbox({
  checked,
  onCheckedChange,
  children,
  description
}: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  children: ReactNode
  description?: ReactNode
}) {
  return (
    <label className="flex items-start gap-2.5">
      <BaseCheckbox.Root
        checked={checked}
        onCheckedChange={(next) => onCheckedChange(next)}
        className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-border bg-surface text-accent-contrast data-checked:border-accent data-checked:bg-accent data-disabled:opacity-50 ${focusRing}`}
      >
        <BaseCheckbox.Indicator className="flex data-unchecked:hidden">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true">
            <path d="m2.5 8.5 4 4 7-9" strokeWidth="2" />
          </svg>
        </BaseCheckbox.Indicator>
      </BaseCheckbox.Root>
      <ChoiceLabel description={description}>{children}</ChoiceLabel>
    </label>
  )
}

export function Switch({
  checked,
  onCheckedChange,
  children,
  description,
  disabled = false
}: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  children: ReactNode
  description?: ReactNode
  disabled?: boolean
}) {
  return (
    <label className="flex items-start gap-3">
      <BaseSwitch.Root
        disabled={disabled}
        checked={checked}
        onCheckedChange={(next) => onCheckedChange(next)}
        className={`mt-0.5 flex h-5 w-9 shrink-0 rounded-full border border-border bg-surface-raised p-0.5 transition-colors data-checked:border-accent data-checked:bg-accent data-disabled:opacity-50 ${focusRing}`}
      >
        <BaseSwitch.Thumb className="size-3.5 rounded-full bg-muted shadow-xs transition-[translate,background-color] data-checked:translate-x-4 data-checked:bg-accent-contrast motion-reduce:transition-none" />
      </BaseSwitch.Root>
      <ChoiceLabel description={description}>{children}</ChoiceLabel>
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

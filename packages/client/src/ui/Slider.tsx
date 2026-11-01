// A labelled slider with its value read out beside the label. `onValueChange` follows the
// drag (and each key press); `onValueCommitted` fires once the pointer lets go, or after a key,
// so a caller can show a value live and save it once.
import { Slider as BaseSlider } from "@base-ui/react/slider"
import type { ReactNode } from "react"

export function Slider({
  label,
  description,
  value,
  min,
  max,
  step,
  largeStep,
  valueText,
  disabled = false,
  onValueChange,
  onValueCommitted
}: {
  label: string
  description?: ReactNode
  value: number
  min: number
  max: number
  step: number
  largeStep?: number
  /** The value as read out and shown, "1200 px". */
  valueText: (value: number) => string
  disabled?: boolean
  onValueChange: (value: number) => void
  onValueCommitted: (value: number) => void
}) {
  return (
    <BaseSlider.Root
      value={value}
      min={min}
      max={max}
      step={step}
      largeStep={largeStep ?? step * 5}
      disabled={disabled}
      thumbAlignment="edge"
      onValueChange={(next) => onValueChange(next)}
      onValueCommitted={(next) => onValueCommitted(next)}
      className="flex w-full max-w-xl flex-col gap-2 data-disabled:opacity-50"
    >
      <div className="flex items-baseline justify-between gap-3">
        <BaseSlider.Label className="text-sm font-medium text-text">{label}</BaseSlider.Label>
        <span className="text-sm text-muted tabular-nums">{valueText(value)}</span>
      </div>
      <BaseSlider.Control className="flex h-6 w-full touch-none items-center select-none">
        <BaseSlider.Track className="h-1.5 w-full rounded-full bg-surface-raised ring-1 ring-border">
          <BaseSlider.Indicator className="rounded-full bg-accent" />
          <BaseSlider.Thumb
            getAriaValueText={(_formatted, current) => valueText(current)}
            className="size-5 rounded-full border border-border bg-surface shadow-sm outline-none has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-focus"
          />
        </BaseSlider.Track>
      </BaseSlider.Control>
      {description && <p className="text-sm text-muted">{description}</p>}
    </BaseSlider.Root>
  )
}

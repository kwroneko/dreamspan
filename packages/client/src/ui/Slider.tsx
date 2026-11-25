// A labelled slider with its value read out beside the label. `onValueChange` follows the
// drag (and each key press); `onValueCommitted` fires once the pointer lets go, or after a key,
// so a caller can show a value live and save it once.
import { Slider as BaseSlider } from "@base-ui/react/slider"
import { type KeyboardEvent, useId, type ReactNode, useState } from "react"
import { AboutHint, LabelWithHelp } from "./AboutHint.tsx"
import { LOG_POSITIONS, logScale } from "./logScale.ts"
import { useRepeatsTitle } from "./titledContainer.tsx"
import { Tooltip } from "./Tooltip.tsx"

/**
 * `scale="log"`: the slider runs over positions on a log scale between `min` and `max` (see
 * logScale.ts) and speaks in values. A drag gives readable values (4,096; 16,000; 128,000), a
 * value set elsewhere sits at its exact place, the arrows move by a hundredth of the track, Page
 * Up/Down (or Shift) by a tenth, and Home and End go to `min` and `max`.
 */
export type SliderScale = "linear" | "log"

function scaledProps({
  scale,
  value,
  min,
  max,
  step,
  largeStep,
  onValueChange,
  onValueCommitted
}: {
  scale: SliderScale
  value: number
  min: number
  max: number
  step: number
  largeStep: number
  onValueChange: (value: number) => void
  onValueCommitted?: ((value: number) => void) | undefined
}) {
  if (scale === "linear")
    return {
      root: {
        value,
        min,
        max,
        step,
        largeStep,
        onValueChange: (next: number) => onValueChange(next),
        onValueCommitted: (next: number) => onValueCommitted?.(next)
      },
      toValue: (next: number) => next,
      onKeyDown: undefined
    }
  const log = logScale(min, max)
  const at = log.positionOf(value)
  // The thumb where the value put it says the exact value, not the scale's nearest step.
  const toValue = (position: number) => (position === at ? value : log.valueAt(position))
  const onKeyDown = (event: KeyboardEvent) => {
    const current = Math.min(max, Math.max(min, value))
    const large = event.shiftKey || event.key === "PageUp" || event.key === "PageDown"
    const next =
      event.key === "Home"
        ? min
        : event.key === "End"
          ? max
          : event.key === "ArrowRight" || event.key === "ArrowUp" || event.key === "PageUp"
            ? log.stepFrom(current, 1, large)
            : event.key === "ArrowLeft" || event.key === "ArrowDown" || event.key === "PageDown"
              ? log.stepFrom(current, -1, large)
              : null
    if (next === null) return
    // As Base UI does for its keys: this slider handles them, and nothing around it sees them.
    event.preventDefault()
    event.stopPropagation()
    if (next === current) return
    onValueChange(next)
    onValueCommitted?.(next)
  }
  return {
    root: {
      value: at,
      min: 0,
      max: LOG_POSITIONS,
      step: 1,
      largeStep: LOG_POSITIONS / 10,
      onValueChange: (next: number) => onValueChange(toValue(next)),
      onValueCommitted: (next: number) => onValueCommitted?.(toValue(next))
    },
    toValue,
    onKeyDown
  }
}

export function Slider({
  label,
  about,
  value,
  min,
  max,
  step,
  largeStep,
  valueText,
  disabled = false,
  scale = "linear",
  onValueChange,
  onValueCommitted
}: {
  label: string
  about?: ReactNode
  value: number
  min: number
  max: number
  step: number
  largeStep?: number
  /** The value as read out and shown, "1200 px". */
  valueText: (value: number) => string
  disabled?: boolean
  scale?: SliderScale
  onValueChange: (value: number) => void
  onValueCommitted: (value: number) => void
}) {
  const aboutId = useId()
  const repeats = useRepeatsTitle(label, false, "The slider's label")
  const scaled = scaledProps({
    scale,
    value,
    min,
    max,
    step,
    largeStep: largeStep ?? step * 5,
    onValueChange,
    onValueCommitted
  })
  return (
    <BaseSlider.Root
      {...scaled.root}
      disabled={disabled}
      thumbAlignment="edge"
      className="flex w-full max-w-xl flex-col gap-2 data-disabled:opacity-50"
    >
      <div className="flex items-baseline justify-between gap-3">
        <LabelWithHelp help={about && <AboutHint heading={label}>{about}</AboutHint>}>
          <BaseSlider.Label className={repeats ? "sr-only" : "inline text-sm font-medium text-text"}>
            {label}
          </BaseSlider.Label>
        </LabelWithHelp>
        <span className="text-sm text-muted tabular-nums">{valueText(value)}</span>
      </div>
      <BaseSlider.Control className="flex h-6 w-full touch-none items-center select-none">
        <BaseSlider.Track className="h-1.5 w-full rounded-full bg-surface-raised ring-1 ring-border">
          <BaseSlider.Indicator className="rounded-full bg-accent" />
          <BaseSlider.Thumb
            data-layout-overlay="Slider thumb rides over its track and fill"
            aria-describedby={about ? aboutId : undefined}
            getAriaValueText={(_formatted, current) => valueText(scaled.toValue(current))}
            onKeyDown={scaled.onKeyDown}
            className="size-5 rounded-full border border-border bg-surface shadow-sm outline-none has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-focus"
          />
        </BaseSlider.Track>
      </BaseSlider.Control>
      {about && (
        <span id={aboutId} hidden>
          {about}
        </span>
      )}
    </BaseSlider.Root>
  )
}

/**
 * A small slider for a toolbar: no label row (`label` is its accessible name), its hover
 * explanation `hint`, and its value shown by the caller beside it.
 */
export function ToolbarSlider({
  label,
  hint,
  value,
  min,
  max,
  step,
  valueText,
  disabled = false,
  className = "",
  onValueChange
}: {
  label: string
  hint: ReactNode
  value: number
  min: number
  max: number
  step: number
  valueText: (value: number) => string
  disabled?: boolean
  className?: string
  onValueChange: (value: number) => void
}) {
  // Base UI's edge-aligned thumb observes its control on mount. Mount the thumb only
  // after that control has registered its ref, including when the toolbar starts hidden;
  // otherwise it can miss the observer and stay invisible when the column grows.
  const [control, setControl] = useState<HTMLDivElement | null>(null)
  return (
    <BaseSlider.Root
      value={value}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      thumbAlignment="edge"
      onValueChange={(next) => onValueChange(next)}
      data-toolbar-slider
      className={`flex items-center data-disabled:opacity-50 ${className}`}
    >
      <Tooltip label={hint}>
        <BaseSlider.Control ref={setControl} className="flex h-8 w-full touch-none items-center select-none">
          <BaseSlider.Track className="h-1 w-full rounded-full bg-surface-raised ring-1 ring-border">
            <BaseSlider.Indicator className="rounded-full bg-accent" />
            {control && (
              <BaseSlider.Thumb
                data-layout-overlay="Slider thumb rides over its track and fill"
                aria-label={label}
                getAriaValueText={(_formatted, current) => valueText(current)}
                className="size-3.5 rounded-full border border-border bg-surface shadow-sm outline-none has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-focus"
              />
            )}
          </BaseSlider.Track>
        </BaseSlider.Control>
      </Tooltip>
    </BaseSlider.Root>
  )
}

/**
 * A slider beside a field of its own (a number to type): no label row, `label` its accessible
 * name. It follows the drag, as `Slider` does.
 */
export function FieldSlider({
  label,
  value,
  min,
  max,
  step,
  largeStep,
  valueText,
  disabled = false,
  scale = "linear",
  onValueChange
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  largeStep?: number
  valueText: (value: number) => string
  disabled?: boolean
  scale?: SliderScale
  onValueChange: (value: number) => void
}) {
  const scaled = scaledProps({
    scale,
    value: Math.min(max, Math.max(min, value)),
    min,
    max,
    step,
    largeStep: largeStep ?? step * 10,
    onValueChange
  })
  return (
    <BaseSlider.Root
      {...scaled.root}
      onValueCommitted={undefined}
      disabled={disabled}
      thumbAlignment="edge"
      className="flex w-full data-disabled:opacity-50"
    >
      <BaseSlider.Control className="flex h-6 w-full touch-none items-center select-none">
        <BaseSlider.Track className="h-1.5 w-full rounded-full bg-surface-raised ring-1 ring-border">
          <BaseSlider.Indicator className="rounded-full bg-accent" />
          <BaseSlider.Thumb
            data-layout-overlay="Slider thumb rides over its track and fill"
            aria-label={label}
            getAriaValueText={(_formatted, current) => valueText(scaled.toValue(current))}
            onKeyDown={scaled.onKeyDown}
            className="size-5 rounded-full border border-border bg-surface shadow-sm outline-none has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-focus"
          />
        </BaseSlider.Track>
      </BaseSlider.Control>
    </BaseSlider.Root>
  )
}

/**
 * A slider with two thumbs, a range's low and high ends, over positions `0..steps`: the caller
 * maps positions to values (a log scale, say). `valueText` says what a thumb's position stands
 * for; the label row is the caller's. `onValueChange` follows the drag, `onValueCommitted` fires
 * once the pointer lets go or after a key.
 */
export function RangeSlider({
  label,
  thumbLabels,
  value,
  steps,
  valueText,
  onValueChange,
  onValueCommitted
}: {
  label: string
  thumbLabels: readonly [string, string]
  value: readonly [number, number]
  steps: number
  valueText: (position: number, thumb: 0 | 1) => string
  onValueChange: (value: [number, number]) => void
  onValueCommitted: (value: [number, number]) => void
}) {
  const pair = (next: number | readonly number[]): [number, number] =>
    Array.isArray(next) ? [next[0] ?? 0, next[1] ?? steps] : [next as number, next as number]
  return (
    <BaseSlider.Root
      aria-label={label}
      value={[...value]}
      min={0}
      max={steps}
      step={1}
      largeStep={Math.max(1, Math.round(steps / 10))}
      thumbAlignment="edge"
      onValueChange={(next) => onValueChange(pair(next))}
      onValueCommitted={(next) => onValueCommitted(pair(next))}
      className="flex w-full flex-col"
    >
      <BaseSlider.Control className="flex h-8 w-full touch-none items-center select-none">
        <BaseSlider.Track className="h-1.5 w-full rounded-full bg-surface-raised ring-1 ring-border">
          <BaseSlider.Indicator className="rounded-full bg-accent" />
          {([0, 1] as const).map((thumb) => (
            <BaseSlider.Thumb
              key={thumb}
              index={thumb}
              data-layout-overlay="Slider thumb rides over its track and fill"
              getAriaLabel={() => thumbLabels[thumb]}
              getAriaValueText={(_formatted, current) => valueText(current, thumb)}
              className="size-5 rounded-full border border-border bg-surface shadow-sm outline-none has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-focus"
            />
          ))}
        </BaseSlider.Track>
      </BaseSlider.Control>
    </BaseSlider.Root>
  )
}

// A row of mutually exclusive choices shown all at once, for a filter or a view. Each is a
// toggle button (`aria-pressed`) in a labelled group, so the choice is read out with it. An
// option's `description` is its tooltip and its description for screen readers; on touch
// screens and narrow windows, where nothing hovers, the chosen option's shows under the row.
import { type ReactNode, useId } from "react"
import { inlineExplanationClass } from "./Explanation.tsx"
import { Tooltip } from "./Tooltip.tsx"

export function Segmented<Value extends string>({
  label,
  wrap = false,
  inlineDescription = true,
  options,
  value,
  onValueChange
}: {
  label: string
  wrap?: boolean
  /** Compact toolbars keep explanations on hover and focus, without a second line. */
  inlineDescription?: boolean
  options: ReadonlyArray<{ readonly value: Value; readonly label: ReactNode; readonly description?: string }>
  value: Value | null
  onValueChange: (value: Value) => void
}) {
  const id = useId()
  const described = options.some((option) => option.description)
  const chosen = options.find((option) => option.value === value)?.description
  const row = (
    <div
      data-layout-audit-ignore="inset: Joined segments share a single outer border"
      role="group"
      aria-label={label}
      className={`inline-flex w-fit rounded-md border border-border bg-surface p-0.5 ${wrap ? "max-w-full flex-wrap" : "shrink-0"}`}
    >
      {options.map((option, index) => {
        const button = (
          <button
            key={option.value}
            type="button"
            aria-pressed={option.value === value}
            aria-describedby={option.description ? `${id}-${index}` : undefined}
            onClick={() => onValueChange(option.value)}
            className="inline-flex h-8 items-center gap-1.5 rounded-[5px] px-2.5 text-sm whitespace-nowrap text-muted outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-focus aria-pressed:bg-surface-raised aria-pressed:font-medium aria-pressed:text-text"
          >
            {option.label}
          </button>
        )
        return option.description ? (
          <Tooltip key={option.value} label={option.description}>
            {button}
          </Tooltip>
        ) : (
          button
        )
      })}
    </div>
  )
  if (!described) return row
  return (
    <div className={`flex min-w-0 flex-col gap-1 ${wrap ? "max-w-full" : "shrink-0"}`}>
      {row}
      {options.map((option, index) =>
        option.description ? (
          <span key={option.value} id={`${id}-${index}`} hidden>
            {option.description}
          </span>
        ) : null
      )}
      {inlineDescription && chosen && (
        // It wraps at the row's width rather than widen the column past the screen (w-0 min-w-full).
        <p aria-hidden="true" className={`hidden w-0 min-w-full text-xs text-muted ${inlineExplanationClass}`}>
          {chosen}
        </p>
      )}
    </div>
  )
}

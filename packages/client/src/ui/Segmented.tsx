// A row of mutually exclusive choices shown all at once, for a filter or a view. Each is a
// toggle button (`aria-pressed`) in a labelled group, so the choice is read out with it.
// An option's `hint` is its tooltip: what the choice means, when its label alone doesn't say.
import type { ReactNode } from "react"
import { Tooltip } from "./Tooltip.tsx"

export function Segmented<Value extends string>({
  label,
  wrap = false,
  options,
  value,
  onValueChange
}: {
  label: string
  wrap?: boolean
  options: ReadonlyArray<{ readonly value: Value; readonly label: ReactNode; readonly hint?: ReactNode }>
  value: Value
  onValueChange: (value: Value) => void
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={`inline-flex w-fit rounded-md border border-border bg-surface p-0.5 ${wrap ? "max-w-full flex-wrap" : "shrink-0"}`}
    >
      {options.map((option) => {
        const button = (
          <button
            key={option.value}
            type="button"
            aria-pressed={option.value === value}
            onClick={() => onValueChange(option.value)}
            className="inline-flex h-8 items-center gap-1.5 rounded-[5px] px-2.5 text-sm whitespace-nowrap text-muted outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-focus aria-pressed:bg-surface-raised aria-pressed:font-medium aria-pressed:text-text"
          >
            {option.label}
          </button>
        )
        return option.hint === undefined ? (
          button
        ) : (
          <Tooltip key={option.value} label={option.hint}>
            {button}
          </Tooltip>
        )
      })}
    </div>
  )
}

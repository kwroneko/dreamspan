// A row of choices shown all at once; single-select by default, or multi-select for scopes. Each is a
// toggle button (`aria-pressed`) in a labelled group, so the choice is read out with it. An
// option's `description` is its tooltip and its description for screen readers; on touch
// screens and narrow windows, where nothing hovers, the chosen option's shows under the row.
import { Fragment, type ReactNode, useId } from "react"
import { inlineExplanationClass } from "./Explanation.tsx"
import { Tooltip } from "./Tooltip.tsx"

export function Segmented<Value extends string>(
  props: {
    label: string
    wrap?: boolean
    className?: string
    /** Compact toolbars keep explanations on hover and focus, without a second line. */
    inlineDescription?: boolean
    options: ReadonlyArray<{
      readonly value: Value
      readonly label: ReactNode
      readonly description?: string
      /** A divider before it: it starts a different kind of choice (a card source after the filters). */
      readonly separatorBefore?: boolean
    }>
  } & (
    | {
        multiple: true
        value: ReadonlyArray<Value>
        onValueChange: (value: ReadonlyArray<Value>) => void
      }
    | {
        multiple?: false
        value: Value | null
        onValueChange: (value: Value) => void
      }
  )
) {
  const { label, wrap = false, inlineDescription = true, className = "", options, value, multiple = false } = props
  const isChosen = (item: Value) => (Array.isArray(value) ? value.includes(item) : value === item)
  const id = useId()
  const described = options.some((option) => option.description)
  const chosen = multiple ? undefined : options.find((option) => isChosen(option.value))?.description
  const row = (
    <div
      data-layout-audit-ignore={
        options.some((option) => option.separatorBefore)
          ? "inset: Joined segments share a single outer border; gap: A divider sets apart a different kind of choice"
          : "inset: Joined segments share a single outer border"
      }
      role="group"
      aria-label={label}
      className={`inline-flex w-fit rounded-md border border-border bg-surface p-0.5 ${wrap ? "max-w-full flex-wrap" : "shrink-0"} ${className}`}
    >
      {options.map((option, index) => {
        const button = (
          <button
            key={option.value}
            type="button"
            aria-pressed={isChosen(option.value)}
            aria-describedby={option.description ? `${id}-${index}` : undefined}
            onClick={() => {
              if (props.multiple)
                props.onValueChange(
                  isChosen(option.value)
                    ? props.value.filter((item) => item !== option.value)
                    : [...props.value, option.value]
                )
              else props.onValueChange(option.value)
            }}
            className={`inline-flex h-8 items-center gap-1.5 rounded-[5px] ${multiple ? "px-1.5 text-xs font-medium" : "px-2.5 text-sm"} whitespace-nowrap text-muted outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-focus aria-pressed:bg-surface-raised aria-pressed:font-medium aria-pressed:text-text`}
          >
            {option.label}
          </button>
        )
        const tip = (
          <Tooltip key={option.value} label={option.description ?? `Selects ${option.label}.`}>
            {button}
          </Tooltip>
        )
        return option.separatorBefore ? (
          <Fragment key={option.value}>
            <span aria-hidden="true" data-segment-divider className="mx-1 my-1 w-px self-stretch bg-border" />
            {tip}
          </Fragment>
        ) : (
          tip
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

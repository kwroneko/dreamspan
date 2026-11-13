// A line across a list of rows that says what changes at that point (owner, 2026-11-02: "They
// SHOULD be distinct and obviously separated"): a rule across the rows' full width, and under
// it an icon in the rows' leading column, a short label in the rows' own size and an (i) at the
// end that explains it. It has no box, so it can't pass for a row, and a label that wraps
// never shortens the rule. `section` is a solid rule in the text's colour; `reuse` a dashed
// one in the accent colour.
import { useState } from "react"
import { Icon, type IconName } from "./Icon.tsx"
import { Popover } from "./Popover.tsx"
import { rowActionInsetClass } from "./rowSpacing.ts"
import { iconButtonClass } from "./Tooltip.tsx"

export function SectionLine({
  label,
  icon,
  tone = "section",
  title,
  explanation,
  ...data
}: {
  label: string
  icon: IconName
  tone?: "section" | "reuse" | "cache"
  /** The explanation's heading. */
  title: string
  explanation: string
} & { [key: `data-${string}`]: string | undefined }) {
  const [open, setOpen] = useState(false)
  const reuse = tone === "reuse"
  const cache = tone === "cache"
  return (
    <div
      {...data}
      data-section-line=""
      className={`my-2 flex items-center gap-2 ps-1 ${rowActionInsetClass} ${
        cache
          ? "min-h-8 border-t border-dashed border-accent/50 pt-2 text-muted"
          : reuse
            ? "min-h-10 border-t-2 border-dashed border-accent pt-2 text-accent"
            : "min-h-10 border-t-2 border-text/70 pt-2 text-text"
      }`}
    >
      <span className="flex size-8 shrink-0 items-center justify-center" aria-hidden="true">
        <Icon name={icon} />
      </span>
      <span className={`min-w-0 flex-1 text-sm ${cache ? "font-normal" : "font-semibold"}`}>{label}</span>
      <Popover
        open={open}
        onOpenChange={setOpen}
        trigger={<Icon name="info" />}
        triggerLabel={`What “${label}” means`}
        hint="What this line means"
        title={title}
        triggerClassName={iconButtonClass()}
        side="bottom"
        align="end"
      >
        <p className="text-sm">{explanation}</p>
      </Popover>
    </div>
  )
}

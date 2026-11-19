// The "Reasoning effort" picker: how much thinking a request asks for. One control wherever an
// effort is chosen: a model's own settings, and a subagent model's row and a subagent type
// (Settings → Assistant tools), so the levels read the same everywhere.
import { EFFORT_LABELS, REASONING_EFFORTS, type ReasoningEffort } from "@dreamspan/shared/modelSettings.ts"
import { Select, type SelectItem } from "../../ui/Select.tsx"

const DESCRIPTIONS: Readonly<Record<ReasoningEffort, string>> = {
  minimal: "As little thinking as the model allows.",
  low: "A little thinking: quicker and cheaper.",
  medium: "Some thinking.",
  high: "More thinking: slower and costlier.",
  xhigh: "Even more thinking, where the model has this level.",
  max: "As much thinking as the model allows."
}

/** A level as the app names it: "High", "Extra high"; another word as it is. */
export const effortLabel = (value: string) => (value in EFFORT_LABELS ? EFFORT_LABELS[value as ReasoningEffort] : value)

/** The empty choice: no level of its own. */
const NONE = ""

/**
 * `value` null is the default (`defaultLabel` says what that is). `levels` are the ones offered;
 * a stored value outside them (another provider's word, say) stays listed so it isn't lost.
 */
export function ReasoningEffortSelect({
  value,
  onValueChange,
  levels = REASONING_EFFORTS,
  defaultLabel,
  defaultDescription,
  disabled = false
}: {
  value: string | null
  onValueChange: (value: string | null) => void
  levels?: ReadonlyArray<ReasoningEffort>
  defaultLabel: string
  defaultDescription?: string
  disabled?: boolean
}) {
  const items: Array<SelectItem<string>> = [
    { value: NONE, label: defaultLabel, description: defaultDescription },
    ...levels.map((level) => ({ value: level, label: EFFORT_LABELS[level], description: DESCRIPTIONS[level] })),
    ...(value !== null && value !== NONE && !(levels as ReadonlyArray<string>).includes(value)
      ? [{ value, label: effortLabel(value) }]
      : [])
  ]
  return (
    <Select
      items={items}
      value={value ?? NONE}
      disabled={disabled}
      onValueChange={(next) => onValueChange(next === NONE ? null : next)}
    />
  )
}

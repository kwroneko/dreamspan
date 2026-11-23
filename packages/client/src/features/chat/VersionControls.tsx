import type { PathEntry, Version } from "@dreamspan/shared/chat.ts"
import { IconButton } from "../../ui/Tooltip.tsx"
import { VersionPicker } from "./VersionPicker.tsx"

/** The next version the arrows reach from `index` going `step`: hidden ones are skipped. */
export const stepFrom = (versions: ReadonlyArray<Version>, index: number, step: -1 | 1) => {
  let i = index + step
  while (versions[i]?.hidden) i += step
  return versions[i]
}

/**
 * `‹ 3/7 ›`: the versions of a message, with the version picker on the counter. A message
 * with one version keeps disabled navigation in place; › can generate another model version.
 */
export function Versions({
  entry,
  generated,
  versions,
  position,
  onStep,
  onPick,
  onFlag,
  onOpen
}: {
  entry: PathEntry
  /** A model writes this message's versions, so › past the last one generates another. */
  generated: boolean
  /** Whether this is the latest message, also exposed to replacement contributions. */
  latest?: boolean
  versions: ReadonlyArray<Version> | null
  position: number
  onStep: (step: -1 | 1) => void
  onPick: (version: Version) => void
  onFlag: (version: Version, flags: { starred?: boolean; hidden?: boolean }) => void
  onOpen: () => void
}) {
  // Until the list is read, the arrows go by the count; then they skip hidden versions.
  const listed = versions !== null && position >= 0
  const before = listed ? stepFrom(versions, position, -1) !== undefined : entry.versionCount > 1 && position !== 0
  const after = listed
    ? stepFrom(versions, position, 1) !== undefined
    : position >= 0 && position < entry.versionCount - 1
  const generates = generated && (position === -1 || !after)
  return (
    <div className="flex shrink-0 items-center" role="group" aria-label="Swipes">
      <IconButton
        label="Previous swipe"
        hint={before ? "Shows the previous swipe." : "No previous swipe."}
        icon="left"
        disabled={!before}
        focusableWhenDisabled
        onClick={() => onStep(-1)}
      />
      <VersionPicker
        entry={entry}
        versions={versions}
        position={position}
        onOpen={onOpen}
        onPick={onPick}
        onFlag={onFlag}
      />
      <IconButton
        label={generates ? "Generate another swipe" : "Next swipe"}
        hint={
          !generated && !after
            ? "No next swipe."
            : generates
              ? "Generate another swipe (ArrowRight outside inputs, on the last reply)"
              : "Next swipe (ArrowRight outside inputs, on the last reply; generates past last)"
        }
        icon="right"
        disabled={!generated && !after}
        focusableWhenDisabled
        onClick={() => onStep(1)}
      />
    </div>
  )
}

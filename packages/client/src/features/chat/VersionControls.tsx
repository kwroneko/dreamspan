import type { PathEntry, Version } from "@rp/shared/chat.ts"
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
 * with one version has no counter; on the latest reply › still generates another, and on an
 * earlier one the › that would generate shows on hover or keyboard focus (and always on a
 * touch screen), so old messages don't each carry a control nobody needs while reading.
 */
export function Versions({
  entry,
  generated,
  latest = true,
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
  /** The latest message of the chat: its › to generate shows without a hover. */
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
  const before = listed ? stepFrom(versions, position, -1) !== undefined : position !== 0
  const after = listed ? stepFrom(versions, position, 1) !== undefined : position < entry.versionCount - 1
  const several = entry.versionCount > 1
  const generates = generated && (position === -1 || !after)
  return (
    <div className="flex shrink-0 items-center" role="group" aria-label="Versions">
      {several && (
        <IconButton
          label="Previous version"
          hint="Previous version (ArrowLeft outside inputs, on the last reply)"
          icon="left"
          className="max-sm:size-7"
          disabled={!before}
          onClick={() => onStep(-1)}
        />
      )}
      {several && (
        <VersionPicker
          entry={entry}
          versions={versions}
          position={position}
          onOpen={onOpen}
          onPick={onPick}
          onFlag={onFlag}
        />
      )}
      {(several || generated) && (
        <IconButton
          label={generates ? "Generate another version" : "Next version"}
          hint={
            generates
              ? "Generate another version (ArrowRight outside inputs, on the last reply)"
              : "Next version (ArrowRight outside inputs, on the last reply; generates past last)"
          }
          icon="right"
          className={`max-sm:size-7 ${
            generates && !latest
              ? "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
              : ""
          }`}
          disabled={!generated && !after}
          onClick={() => onStep(1)}
        />
      )}
    </div>
  )
}

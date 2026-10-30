import type { PathEntry, Version } from "@rp/shared/chat.ts"
import { Select } from "../../ui/Select.tsx"
import { IconButton } from "../../ui/Tooltip.tsx"
import { parseModelValue, useModelChoices } from "./modelChoices.ts"
import { VersionPicker } from "./VersionPicker.tsx"

/** "Retry with…" another model, for a reply that was refused. */
export function RetryWith({ onPick }: { onPick: (model: ReturnType<typeof parseModelValue>) => void | Promise<void> }) {
  const models = useModelChoices(true)
  return (
    <div className="w-56">
      <Select
        items={models}
        value={null}
        placeholder="Retry with…"
        onValueChange={(value) => void onPick(parseModelValue(value))}
      />
    </div>
  )
}

/** The next version the arrows reach from `index` going `step`: hidden ones are skipped. */
export const stepFrom = (versions: ReadonlyArray<Version>, index: number, step: -1 | 1) => {
  let i = index + step
  while (versions[i]?.hidden) i += step
  return versions[i]
}

/** `‹ 3/7 ›`: the versions of a message, with the version picker on the counter. */
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
  return (
    <div className="flex shrink-0 items-center" role="group" aria-label="Versions">
      <IconButton
        label="Previous version"
        hint="Previous version (ArrowLeft outside inputs, on the last reply)"
        icon="left"
        className="max-sm:size-7"
        disabled={entry.versionCount <= 1 || !before}
        onClick={() => onStep(-1)}
      />
      {entry.versionCount > 1 ? (
        <VersionPicker
          entry={entry}
          versions={versions}
          position={position}
          onOpen={onOpen}
          onPick={onPick}
          onFlag={onFlag}
        />
      ) : (
        <span className="min-w-6 text-center text-xs text-muted tabular-nums">1/1</span>
      )}
      <IconButton
        label={generated && (position === -1 || !after) ? "Generate another version" : "Next version"}
        hint="Next version (ArrowRight outside inputs, on the last reply; generates past last)"
        icon="right"
        className="max-sm:size-7"
        disabled={!generated && (entry.versionCount <= 1 || !after)}
        onClick={() => onStep(1)}
      />
    </div>
  )
}

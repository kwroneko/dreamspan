// A reusable explanation, remembered by id in the account's display settings. Its caller
// places the standard help beside the relevant label once the standing box is dismissed.
import type { ReactNode } from "react"
import { ErrorAlert } from "../actions.tsx"
import { IconButton } from "./Tooltip.tsx"
import { useViewPrefs } from "./viewPrefs.ts"

export function DismissibleInfo({
  id,
  text,
  children
}: {
  id: string
  text: string
  children: (help: string | undefined) => ReactNode
}) {
  const viewer = useViewPrefs()
  const hidden = viewer.prefs.dismissedInfo[id] === true
  return (
    <>
      {viewer.ready && !hidden && (
        <div className="relative rounded-lg border border-border bg-surface-raised/50 p-3 pe-14 text-sm text-muted">
          <p>{text}</p>
          <IconButton
            label="Hide this explanation"
            icon="close"
            className="absolute top-2 right-2"
            disabled={viewer.pending}
            onClick={() =>
              void viewer.change(
                { dismissedInfo: { ...viewer.prefs.dismissedInfo, [id]: true } },
                { dismissedInfo: { [id]: true } }
              )
            }
          />
        </div>
      )}
      <ErrorAlert error={viewer.error} />
      {children(hidden ? text : undefined)}
    </>
  )
}

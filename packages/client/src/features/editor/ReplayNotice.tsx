// A replay displaced text saved elsewhere. Switching is an explicit, undoable restore; a field
// with no history to undo it from offers none, and its other text goes to
// the recovered texts when the edit ends, as every displaced text does (ARCHITECTURE §3.10).
import { useState } from "react"
import { Button } from "../../ui/Button.tsx"
import { Alert } from "../../ui/Surface.tsx"
import type { ReplayConflict } from "./backup.ts"

const when = (at: number) => new Date(at).toLocaleString(undefined, { dateStyle: "short", timeStyle: "medium" })

export function ReplayNotice({
  conflict,
  acknowledge,
  switchText
}: {
  conflict: ReplayConflict
  acknowledge: () => void
  switchText?: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  return (
    <Alert tone="warning" title="This browser's text replaced text saved elsewhere">
      <p>
        Unsaved text typed in this browser while offline at {when(conflict.typedAt)} went over text saved elsewhere at{" "}
        {when(conflict.at)}.{" "}
        {switchText
          ? "Both texts are kept; switching is undoable in History."
          : "Both texts are kept. Text saved elsewhere is kept in the bin, under Recovered text, once you save or cancel this browser's text."}
      </p>
      <details>
        <summary className="cursor-pointer">View the other text</summary>
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere]">{conflict.content}</pre>
      </details>
      <div className="flex flex-wrap gap-2">
        {switchText && (
          <Button
            disabled={busy}
            onClick={() => {
              setBusy(true)
              void switchText().finally(() => setBusy(false))
            }}
          >
            Use the other text
          </Button>
        )}
        <Button variant="ghost" disabled={busy} onClick={acknowledge}>
          Keep this browser's text
        </Button>
      </div>
    </Alert>
  )
}

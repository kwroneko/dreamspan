// A replay displaced text saved elsewhere. Switching is an explicit, undoable restore.
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
  switchText: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  return (
    <Alert tone="warning" title="This browser's text replaced text saved elsewhere">
      <p>
        Unsaved text typed in this browser while offline at {when(conflict.typedAt)} went over text saved elsewhere at{" "}
        {when(conflict.at)}. Both texts are kept; switching is undoable in History.
      </p>
      <details>
        <summary className="cursor-pointer">View the other text</summary>
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere]">{conflict.content}</pre>
      </details>
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={busy}
          onClick={() => {
            setBusy(true)
            void switchText().finally(() => setBusy(false))
          }}
        >
          Use the other text
        </Button>
        <Button variant="ghost" disabled={busy} onClick={acknowledge}>
          Keep this browser's text
        </Button>
      </div>
    </Alert>
  )
}

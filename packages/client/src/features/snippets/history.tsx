// A snippet's Undo and earlier texts (DESIGN §6.2): the server's text history of the snippet,
// so going back works after a reload, like the other note editors.
import type { DraftState } from "@rp/shared/drafts.ts"
import type { Snippet } from "@rp/shared/snippetsApi.ts"
import { useState } from "react"
import { Button } from "../../ui/Button.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import type { SnippetWorkspace } from "./workspace.ts"

const when = (at: number) => new Date(at).toLocaleString(undefined, { dateStyle: "short", timeStyle: "medium" })

export function SnippetHistory({ store, item }: { store: SnippetWorkspace; item: Snippet }) {
  const [open, setOpen] = useState(false)
  const [states, setStates] = useState<ReadonlyArray<DraftState> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const name = item.title || "Untitled snippet"
  const load = async () => {
    setOpen(true)
    setStates(null)
    setError(null)
    const result = await store.history(item.ref.id)
    if (result.ok) setStates(result.value)
    else setError(result.error.message)
  }
  return (
    <>
      <Button variant="ghost" aria-label={`Undo ${name}`} onClick={() => void store.undo(item.ref.id)}>
        Undo
      </Button>
      <Button variant="ghost" aria-label={`Earlier text of ${name}`} onClick={() => void load()}>
        Earlier text
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={`Earlier text of ${name}`}
        description="Restore any earlier text of this snippet. Restoring keeps the text you have now in this list."
      >
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        {states === null ? (
          <p className="text-sm text-muted">{error ? "History unavailable." : "Loading…"}</p>
        ) : states.length < 2 ? (
          <p className="text-sm text-muted">No earlier text yet.</p>
        ) : (
          <ol aria-label="Earlier texts" className="flex flex-col divide-y divide-border overflow-auto">
            {states.slice(1).map((state) => (
              <li key={state.seq} className="flex flex-col gap-1 py-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 flex-col text-sm">
                  <span className="font-medium">
                    {state.kind === "initial" ? "First text" : when(state.at)} · {state.length} characters
                  </span>
                  {state.kind !== "initial" && (
                    <span className="text-muted [overflow-wrap:anywhere]">
                      {state.kind === "restore" ? "Restored. " : ""}
                      {state.removed && <del>{state.removed}</del>} {state.inserted && <ins>{state.inserted}</ins>}
                    </span>
                  )}
                </div>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true)
                    await store.restore(item.ref.id, state.seq)
                    setBusy(false)
                    setOpen(false)
                  }}
                >
                  Restore
                </Button>
              </li>
            ))}
          </ol>
        )}
        <DialogActions>
          <Button onClick={() => setOpen(false)}>Close</Button>
        </DialogActions>
      </Dialog>
    </>
  )
}

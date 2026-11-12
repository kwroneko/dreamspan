// The regenerate warning's dialog (spec/WORKSHOP.md §3.6), shown by the host registered in
// `appTools` for a request from `askBeforeReply`. It reads the reply's changes first; with none
// still standing the new version goes ahead at once. Otherwise it lists them and offers "Undo them,
// then make a new version" (newest first, stopping at the first refused), "Keep them and make a new
// version", or Cancel.
import { useEffect, useRef, useState } from "react"
import type { AppError } from "../../errors.ts"
import { ErrorAlert } from "../../actions.tsx"
import { Button } from "../../ui/Button.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { useCaller } from "../editor/caller.ts"
import { EFFECTS_KEY, effectId, effectKey, outstanding, type RolloutEffect } from "./effects.ts"
import { useWarningRequest, type WarningRequest } from "./regenerateWarning.ts"

/** What the dialog says a new version does and doesn't do. */
const WARNING_TEXT = "A new version won’t undo them, and the assistant may make them again."

function Warning({ asked }: { asked: WarningRequest }) {
  const call = useCaller()
  const [standing, setStanding] = useState<ReadonlyArray<RolloutEffect> | null>(null)
  const [pending, setPending] = useState<"undo" | "keep" | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  const started = useRef(false)
  useEffect(() => {
    // Once per request, also where React runs effects twice.
    if (started.current) return
    started.current = true
    void (async () => {
      const read = await call((client) => client("ListVersionEffects", { versionId: asked.request.versionId }))
      // It couldn't be read: asking about nothing would only stand in the way.
      const left = read.ok ? outstanding(read.value) : []
      if (left.length === 0) return asked.settle(true)
      setStanding(left)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per request: the host keys it by id
  }, [])
  if (standing === null) return null
  const undoAll = async () => {
    setPending("undo")
    setError(null)
    for (const effect of standing) {
      if (effect.undo === null) continue
      const undone = await call(
        (client) => client("UndoRolloutEffect", effectKey(effect)),
        [EFFECTS_KEY, "library", "chats", "chat-lists", "bin"]
      )
      if (!undone.ok) {
        setPending(null)
        setError({ ...undone.error, message: `“${effect.title}” wasn’t undone: ${undone.error.message}` })
        return
      }
    }
    asked.settle(true)
  }
  const fixed = standing.filter((effect) => effect.undo === null).length
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && pending === null && asked.settle(false)}
      title="This reply changed things outside the chat"
      description={WARNING_TEXT}
    >
      <ul
        aria-label="Changes it made"
        className="flex max-h-60 list-disc flex-col gap-0.5 overflow-y-auto pl-5 text-sm"
      >
        {standing.map((effect) => (
          <li key={effectId(effect)} className="[overflow-wrap:anywhere]" data-warning-effect={effect.kind}>
            {effect.title}
            {effect.undo === null && <span className="text-muted"> (can’t be undone here)</span>}
          </li>
        ))}
      </ul>
      <ErrorAlert error={error} title="Not all undone, so no new version yet" />
      <DialogActions>
        <Button
          variant="ghost"
          disabled={pending !== null}
          hint="Closes this. Nothing is undone and no new version is made."
          onClick={() => asked.settle(false)}
        >
          Cancel
        </Button>
        <Button
          disabled={pending === "undo"}
          pending={pending === "keep"}
          hint="Leaves these changes as they are and asks for a new version."
          onClick={() => {
            setPending("keep")
            asked.settle(true)
          }}
        >
          Keep them and make a new version
        </Button>
        <Button
          variant="primary"
          disabled={pending === "keep" || fixed === standing.length}
          pending={pending === "undo"}
          hint={
            fixed > 0
              ? "Undoes the changes that can be undone, newest first, then asks for a new version."
              : "Undoes these changes, newest first, then asks for a new version."
          }
          onClick={() => void undoAll()}
        >
          Undo them, then make a new version
        </Button>
      </DialogActions>
    </Dialog>
  )
}

export default function RegenerateWarning() {
  const asked = useWarningRequest()
  return asked && <Warning key={asked.id} asked={asked} />
}

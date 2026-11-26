// The regenerate warning's dialog (spec/WORKSHOP.md §3.6), shown by the host registered in
// `appTools` for a request from `askBeforeReply`. It reads the reply's changes (its own and its
// run's later messages'), leaves out those of the calls the new version keeps, and with none still
// standing the new version goes ahead at once. Otherwise it lists them and offers "Undo them,
// then make a new version" (newest first, stopping at the first refused), "Keep them and make a new
// version", or Cancel.
import { syncClientPlugins } from "../../pluginLifecycle.ts"
import { useEffect, useRef, useState } from "react"
import type { AppError } from "../../errors.ts"
import { ErrorAlert } from "../../actions.tsx"
import { Button } from "../../ui/Button.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { useCaller } from "../editor/caller.ts"
import { EFFECTS_KEY, effectId, effectKey, outstanding, type RolloutEffect } from "./effects.ts"
import {
  subagentLine,
  warningEffects,
  warningGroups,
  useWarningRequest,
  warningText,
  type WarningRequest
} from "./regenerateWarning.ts"

function Warning({ asked }: { asked: WarningRequest }) {
  const call = useCaller()
  const [standing, setStanding] = useState<ReadonlyArray<RolloutEffect> | null>(null)
  const [pending, setPending] = useState<"undo" | "keep" | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  const [readFailed, setReadFailed] = useState(false)
  const started = useRef(false)
  useEffect(() => {
    // Once per request, also where React runs effects twice.
    if (started.current) return
    started.current = true
    void (async () => {
      const read = await call((client) => client("ListVersionEffects", { versionId: asked.request.versionId }))
      const steps =
        asked.request.fromStep && read.ok && outstanding(read.value).length > 0
          ? await call((client) => client("GetRolloutSteps", { versionId: asked.request.versionId }))
          : { ok: true as const, value: [] }
      const selected = warningEffects(asked.request, read, steps)
      if (!selected.ok) {
        setReadFailed(true)
        setError(selected.error)
        setStanding([])
        return
      }
      const left = selected.value
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
    if (standing.some((e) => e.kind.startsWith("plugin."))) await syncClientPlugins()
    asked.settle(true)
  }
  const fixed = standing.filter((effect) => effect.undo === null).length
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && pending === null && asked.settle(false)}
      title="This reply changed things outside the chat"
      description={warningText(asked.request.action)}
    >
      <div className="flex max-h-60 flex-col gap-2 overflow-y-auto text-sm">
        {warningGroups(standing).map((group) => (
          <div
            key={group.handle ?? ""}
            className="flex flex-col gap-0.5"
            data-warning-subagent={group.handle ?? undefined}
          >
            {group.handle !== null && <p className="text-muted">{subagentLine(group.handle, group.effects.length)}</p>}
            <ul
              aria-label={group.handle ? `Changes ${group.handle} made` : "Changes it made"}
              className="flex list-disc flex-col gap-0.5 pl-5"
            >
              {group.effects.map((effect) => (
                <li key={effectId(effect)} className="[overflow-wrap:anywhere]" data-warning-effect={effect.kind}>
                  {effect.title}
                  {effect.undo === null && <span className="text-muted"> (can’t be undone here)</span>}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <ErrorAlert
        error={error}
        title={
          readFailed ? "The changes couldn't be read. Close this and try again." : "Not all undone, so no new swipe yet"
        }
      />
      <DialogActions>
        <Button
          variant="ghost"
          disabled={pending !== null}
          hint="Closes this. Nothing is undone and no new swipe is made."
          onClick={() => asked.settle(false)}
        >
          Cancel
        </Button>
        <Button
          disabled={readFailed || pending === "undo"}
          pending={pending === "keep"}
          hint="Leaves these changes as they are and asks for a new swipe."
          onClick={() => {
            setPending("keep")
            asked.settle(true)
          }}
        >
          Keep them and make a new swipe
        </Button>
        <Button
          variant="primary"
          disabled={readFailed || pending === "keep" || fixed === standing.length}
          pending={pending === "undo"}
          hint={
            fixed > 0
              ? "Undoes the changes that can be undone, newest first, then asks for a new swipe."
              : "Undoes these changes, newest first, then asks for a new swipe."
          }
          onClick={() => void undoAll()}
        >
          Undo them, then make a new swipe
        </Button>
      </DialogActions>
    </Dialog>
  )
}

export default function RegenerateWarning() {
  const asked = useWarningRequest()
  return asked && <Warning key={asked.id} asked={asked} />
}

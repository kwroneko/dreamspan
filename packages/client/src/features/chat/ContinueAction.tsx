// Continue (ST's, DESIGN §7.5): on the latest message, when the version shown is finished with
// text (stopped, interrupted, cut off or complete), whoever wrote it (an edit of a reply is
// the user's), a new generated version that starts as its text and streams on from its end.
// The old version stays. It needs a model
// that takes the start of its reply (a prefill); with another, the button says why it isn't
// available, and a click (or a tap, where there's no tooltip) shows the reason in full.
import type { PathEntry } from "@rp/shared/chat.ts"
import { useCallback, useSyncExternalStore } from "react"
import { IconButton } from "../../ui/Tooltip.tsx"
import type { ChatSession, Outcome } from "./session.ts"

type NextModel = NonNullable<ReturnType<ChatSession["snapshot"]>["history"]>["model"]

/** Why Continue can't be used with the next request's model; null when it can. */
const continueBlocked = (model: NextModel): string | null => {
  if (model === undefined) return "Continue is waiting for the next model’s prefill capability."
  if (model === null) return "Continue needs a model: none is chosen for this chat. Choose one in This chat."
  const name = model.modelKey ?? "this model"
  const where = model.connectionName ? ` (${model.connectionName})` : ""
  if (model.prefill === undefined)
    return "Continue is unavailable while the next model’s prefill capability is unresolved."
  if (model.continueUnavailable) return `Continue isn't available with ${name}${where}: ${model.continueUnavailable}`
  if (model.prefill === "assistant" || model.prefill === "tool_schema") return null
  return `Continue isn't available with ${name}${where}: it isn't known to take the start of its reply (a prefill). If it does, set its Prefill capability in Settings → Connections.`
}

export function ContinueAction({
  entry,
  session,
  report
}: {
  entry: PathEntry
  session: ChatSession
  report: (outcome: Outcome<unknown>) => void
}) {
  const { version } = entry
  if (version.status === "generating" || version.content.trim() === "") return null
  return <ContinueButton entry={entry} session={session} report={report} />
}

function ContinueButton({
  entry,
  session,
  report
}: {
  entry: PathEntry
  session: ChatSession
  report: (outcome: Outcome<unknown>) => void
}) {
  // Only the latest message of the path shown continues, as in ST.
  const latest = useSyncExternalStore(
    session.subscribe,
    useCallback(() => {
      const view = session.snapshot()
      return view.newer === null && view.entries.at(-1)?.slotId === entry.slotId
    }, [session, entry.slotId])
  )
  const model = useSyncExternalStore(session.subscribe, () => session.snapshot().history?.model)
  if (!latest) return null
  const blocked = continueBlocked(model)
  if (blocked !== null) {
    return (
      <IconButton
        label={blocked}
        icon="continue"
        className="opacity-50"
        onClick={() =>
          report({ ok: false, error: { tag: "ContinueUnavailable", message: blocked, problems: [], reason: null } })
        }
      />
    )
  }
  return (
    <IconButton
      label="Continue: write on from the end of this reply"
      icon="continue"
      onClick={async () => report(await session.continueVersion(entry))}
    />
  )
}

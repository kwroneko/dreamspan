// Continue (ST's, DESIGN §7.5): on the latest message, when the version shown is finished with
// text (stopped, interrupted, cut off or complete), whoever wrote it (an edit of a reply is
// the user's), a new generated version that starts as its text and streams on from its end.
// The old version stays. It needs a model
// that takes the start of its reply (a prefill); with another, the button says why it isn't
// available, and a click (or a tap, where there's no tooltip) shows the reason in full.
import { useSyncExternalStore } from "react"
import { IconButton } from "../../ui/Tooltip.tsx"
import type { ChatSession } from "./session.ts"

import { invokeMessageAction, type MessageActionContext, type MessageActionProps } from "./messageActions.tsx"

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

/** The latest finished version with text can continue, whoever wrote it. */
export const canContinue = ({ entry, session }: MessageActionContext) => {
  if (entry.version.status === "generating" || entry.version.content.trim() === "") return false
  const view = session.snapshot()
  return !view.loading && view.newer === null && view.entries.at(-1)?.slotId === entry.slotId
}

export const runContinue = async (context: MessageActionContext, source: "button" | "keyboard") => {
  const blocked = continueBlocked(context.session.snapshot().history?.model)
  if (blocked !== null) {
    context.report({ ok: false, error: { tag: "ContinueUnavailable", message: blocked, problems: [], reason: null } })
    return
  }
  context.report(await context.session.continueVersion(context.entry, source !== "keyboard"))
}

export function ContinueAction(context: MessageActionProps) {
  const { session } = context
  const model = useSyncExternalStore(session.subscribe, () => session.snapshot().history?.model)
  const blocked = continueBlocked(model)
  return (
    <IconButton
      label={blocked ?? "Continue: write on from the end of this reply (Alt+Enter; keeps composer text)"}
      icon="continue"
      className={blocked === null ? undefined : "opacity-50"}
      onClick={() => void invokeMessageAction("message.continue", context, "button")}
    />
  )
}

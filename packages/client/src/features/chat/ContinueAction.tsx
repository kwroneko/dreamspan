// Continue (ST's, DESIGN §7.5): on the latest message, when the version shown is finished with
// text (stopped, interrupted, cut off or complete), whoever wrote it (an edit of a reply is
// the user's), a new generated version that starts as its text and streams on from its end.
// The old version stays. A model that takes the start of its reply (a prefill) gets it so; any
// other gets the reply as its own last message and is asked to write only what follows (owner,
// 2026-10-31). Before the next context arrives, the action waits for it. Without a model,
// or if its capability remains unresolved, the disabled button explains why on hover and focus.
import { originalReply } from "@dreamspan/shared/replySections.ts"
import { useSyncExternalStore } from "react"
import type { ChatSession } from "./session.ts"

import { invokeMessageAction, type MessageActionContext, type MessageActionDescribeProps } from "./messageActions.tsx"

type NextModel = NonNullable<ReturnType<ChatSession["snapshot"]>["history"]>["model"]

/** Why Continue can't be used with the next request's model; null when it can. */
const continueBlocked = (model: NextModel): string | null => {
  if (model === undefined) return "Continue is waiting for the next model’s prefill capability."
  if (model === null) return "Continue needs a model: none is chosen for this chat. Choose one in This chat."
  if (model.prefill === undefined)
    return "Continue is unavailable while the next model’s prefill capability is unresolved."
  return null
}

/** The latest finished version with text can continue, whoever wrote it. */
const canContinue = ({ entry, session }: MessageActionContext) => {
  if (
    entry.version.status === "generating" ||
    originalReply(entry.version.content, entry.version.replySections).trim() === ""
  )
    return false
  const view = session.snapshot()
  return !view.loading && view.newer === null && view.entries.at(-1)?.slotId === entry.slotId
}

/** A stable Continue control also explains why an earlier or unfinished message can't continue. */
export const continueUnavailable = (context: MessageActionContext): string | null => {
  if (context.generating) return "Wait for this reply to finish before continuing it."
  if (originalReply(context.entry.version.content, context.entry.version.replySections).trim() === "")
    return "There is no text to continue yet."
  return canContinue(context) ? null : "Only the latest message can be continued."
}

export const runContinue = async (context: MessageActionContext, source: "button" | "keyboard") => {
  const { session, entry } = context
  const before = session.snapshot()
  if (before.history?.model === undefined) {
    // A finished reply can arrive before the context read held behind it resolves.
    if (!(await session.ensureNextContext())) return
    const current = session.snapshot()
    const latest = current.entries.at(-1)
    if (
      current.forkId !== before.forkId ||
      current.leafSlotId !== before.leafSlotId ||
      latest?.version.id !== entry.version.id ||
      latest?.rowVersion !== entry.rowVersion ||
      !canContinue(context)
    )
      return
  }
  const blocked = continueBlocked(session.snapshot().history?.model)
  if (blocked !== null) {
    context.report({ ok: false, error: { tag: "ContinueUnavailable", message: blocked, problems: [], reason: null } })
    return
  }
  context.report(await context.session.continueVersion(context.entry, source !== "keyboard"))
}

/** Continue's view: why it can't be used yet follows the next request's model as it resolves. */
export function ContinueView({ show, ...context }: MessageActionDescribeProps) {
  const { session } = context
  const read = () => session.snapshot().history?.model
  const model = useSyncExternalStore(session.subscribe, read, read)
  // Missing context is a waitable request, not an unavailable action.
  const blocked = model === undefined ? null : continueBlocked(model)
  return show({
    label: "Continue",
    icon: "continue",
    hint:
      blocked ??
      "Write on from the end of this message, as a new version that starts with its text (Alt+Enter; keeps the composer's text).",
    ...(blocked === null ? {} : { disabled: blocked }),
    onSelect: () => invokeMessageAction("message.continue", context, "button")
  })
}

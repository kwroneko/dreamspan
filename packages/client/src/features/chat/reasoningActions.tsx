// The reasoning header's default actions (the `reasoningActions` slot, Reasoning.tsx): Copy
// reasoning copies the raw text, stored or streamed so far; Collapse all closes every
// reasoning block shown, the reply-section panels too, leaving the streaming preference as it
// is; a reply with both panels shows it once, on the first. A reply-section panel also offers
// Show as reply text, for a wrong parse (spec/REPLY-SECTIONS.md). Each panel's Hide from the
// model keeps that thinking out of every later request in the fork shown, on this version only,
// and leaves it on the message, marked; Show to the model again undoes it.
import { useState } from "react"
import { showToast } from "../../ui/Toast.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { type ReasoningActionProps, reasoningActions } from "./presentation.tsx"
import { copy } from "./copy.ts"

/** Collapse all: a count every mounted block watches, closing when it moves on. */
let collapses = 0
const collapseListeners = new Set<() => void>()
export const collapseCount = () => collapses
export const collapseAllReasoning = () => {
  collapses++
  for (const listener of collapseListeners) listener()
}
export const subscribeCollapses = (listener: () => void) => {
  collapseListeners.add(listener)
  return () => void collapseListeners.delete(listener)
}

const actionClass =
  "rounded-md px-1 py-0.5 text-xs text-muted outline-none hover:bg-hover hover:text-text focus-visible:ring-2 focus-visible:ring-focus"

export const registerReasoningActions = () => [
  reasoningActions.register({
    id: "reasoning.copy",
    order: 10,
    component: ({ text, kind }) => (
      <Tooltip label="Copies the displayed thinking text.">
        <button
          type="button"
          className={actionClass}
          onClick={() => void copy(text, kind === "reasoning" ? "Reasoning" : "Thinking")}
        >
          {kind === "reasoning" ? "Copy reasoning" : "Copy thinking"}
        </button>
      </Tooltip>
    )
  }),
  reasoningActions.register({
    id: "reasoning.hide",
    order: 15,
    component: HideThinking
  }),
  reasoningActions.register({
    id: "reasoning.collapse-all",
    order: 20,
    component: CollapseAll
  }),
  reasoningActions.register({
    id: "reasoning.show-as-text",
    order: 30,
    component: ShowAsReplyText
  })
]

/** Hide from the model, or show to it again: this panel's thinking, this version, the fork shown. */
function HideThinking({ version, kind, hidden, session }: ReasoningActionProps) {
  const [busy, setBusy] = useState(false)
  const run = async () => {
    const entry = session.snapshot().entries.find((e) => e.version.id === version.id)
    if (!entry || busy) return
    setBusy(true)
    const forkId = entry.shownForkId ?? session.snapshot().forkId
    const result = await session.setThinkingHidden(entry, kind, !hidden, forkId)
    setBusy(false)
    if (!result.ok)
      showToast({
        title: hidden ? "Couldn't show the thinking to the model" : "Couldn't hide the thinking",
        description: result.error.message
      })
    else
      showToast({
        title: hidden ? "Thinking allowed again" : "Thinking hidden",
        actions: [
          {
            label: "Undo",
            hint: "Restore the previous choice on this branch.",
            onClick: () => {
              void session.setThinkingHidden(entry, kind, !!hidden, forkId).then((undone) => {
                if (!undone.ok) showToast({ title: "Couldn't undo the choice", description: undone.error.message })
              })
            }
          }
        ]
      })
  }
  const hint =
    kind === "reasoning"
      ? hidden
        ? "Allow reasoning in replays. Plain chats never send it."
        : "Omit from replays after this tool turn. Plain chats never send it."
      : hidden
        ? "Allow this thinking in later replies."
        : "Omit this thinking when later replies include it."
  return (
    <Tooltip label={hint}>
      <button
        type="button"
        className={`${actionClass} aria-disabled:cursor-not-allowed aria-disabled:opacity-60`}
        aria-disabled={busy ? true : undefined}
        aria-pressed={hidden}
        onClick={() => void run()}
      >
        {hidden ? "Show to the model again" : "Hide from the model"}
      </button>
    </Tooltip>
  )
}

/** Once per reply, on its first panel. */
function CollapseAll({ first }: ReasoningActionProps) {
  if (!first) return null
  return (
    <Tooltip label="Fold every reasoning and thinking block in the chat.">
      <button type="button" className={actionClass} onClick={collapseAllReasoning}>
        Collapse all
      </button>
    </Tooltip>
  )
}

/** The reply's sections back in its text, as a new version; the parsed one stays among its versions. */
function ShowAsReplyText({ version, kind, streaming, session }: ReasoningActionProps) {
  const [busy, setBusy] = useState(false)
  if (kind !== "sections" || streaming || !version.replySections) return null
  const run = async () => {
    const entry = session.snapshot().entries.find((e) => e.version.id === version.id)
    if (!entry) return
    setBusy(true)
    const result = await session.showSectionsAsText(entry)
    setBusy(false)
    if (!result.ok) showToast({ title: "Couldn't show the thinking as reply text", description: result.error.message })
  }
  return (
    <Tooltip label="Make this thinking part of the reply's text, as a new version; this one stays.">
      <button type="button" className={actionClass} disabled={busy} onClick={() => void run()}>
        Show as reply text
      </button>
    </Tooltip>
  )
}

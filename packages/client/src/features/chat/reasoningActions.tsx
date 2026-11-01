// The reasoning header's default actions (the `reasoningActions` slot, Reasoning.tsx): Copy
// reasoning copies the raw text, stored or streamed so far; Collapse all closes every
// reasoning block shown, the reply-section panels too, leaving the streaming preference as it
// is; a reply with both panels shows it once, on the first. A reply-section panel also offers
// Show as reply text, for a wrong parse (spec/REPLY-SECTIONS.md).
import { useState } from "react"
import { showToast } from "../../ui/Toast.tsx"
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
      <button
        type="button"
        className={actionClass}
        onClick={() => void copy(text, kind === "reasoning" ? "Reasoning" : "Thinking")}
      >
        {kind === "reasoning" ? "Copy reasoning" : "Copy thinking"}
      </button>
    )
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

/** Once per reply, on its first panel. */
function CollapseAll({ first }: ReasoningActionProps) {
  if (!first) return null
  return (
    <button type="button" className={actionClass} onClick={collapseAllReasoning}>
      Collapse all
    </button>
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
    <button type="button" className={actionClass} disabled={busy} onClick={() => void run()}>
      Show as reply text
    </button>
  )
}

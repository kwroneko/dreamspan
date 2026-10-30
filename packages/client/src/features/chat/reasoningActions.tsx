// The reasoning header's default actions (the `reasoningActions` slot, Reasoning.tsx): Copy
// reasoning copies the raw text, stored or streamed so far; Collapse all closes every
// reasoning block shown, leaving the streaming preference as it is.
import { reasoningActions } from "./presentation.tsx"
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
  "rounded-md px-1 py-0.5 text-xs text-muted outline-none hover:bg-surface-raised hover:text-text focus-visible:ring-2 focus-visible:ring-focus"

export const registerReasoningActions = () => [
  reasoningActions.register({
    id: "reasoning.copy",
    order: 10,
    component: ({ text }) => (
      <button type="button" className={actionClass} onClick={() => void copy(text, "Reasoning")}>
        Copy reasoning
      </button>
    )
  }),
  reasoningActions.register({
    id: "reasoning.collapse-all",
    order: 20,
    component: () => (
      <button type="button" className={actionClass} onClick={collapseAllReasoning}>
        Collapse all
      </button>
    )
  })
]

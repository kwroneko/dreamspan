// The reasoning header's default actions (the `reasoningActions` slot, Reasoning.tsx): Copy
// reasoning copies the raw text, stored or streamed so far; Collapse all closes every
// reasoning block shown, the reply-section panels too, leaving the streaming preference as it
// is; a reply with both panels shows it once, on the first. A reply-section panel also offers
// Show as reply text, for a wrong parse (spec/REPLY-SECTIONS.md). Each panel's "Sent to the
// model" / "Not sent to the model" says whether its thinking goes to the model in later
// requests, as the next request decided it (thinkingStatus.ts), and flips the user's own
// choice for this thinking only (SetThinkingHidden, in the fork shown): a tool run's thinking
// for the rest of the run, a finished reply's where the preset sends it back.
import { useId, useState, useSyncExternalStore } from "react"
import { Icon } from "../../ui/Icon.tsx"
import { showToast } from "../../ui/Toast.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { type ReasoningActionProps, reasoningActions } from "./presentation.tsx"
import { copy } from "./copy.ts"
import { thinkingStatus } from "./thinkingStatus.ts"

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

/**
 * Sent to the model, or not: this panel's thinking in later requests. A click flips the user's
 * choice for it (this version, the fork shown); where the settings keep it out anyway, the
 * button says why and does nothing, so it never claims a state the request won't have.
 */
function HideThinking({ version, kind, hidden, streaming, session }: ReasoningActionProps) {
  const [busy, setBusy] = useState(false)
  const hintId = useId()
  const read = () => session.snapshot().history?.thinking
  const sends = useSyncExternalStore(session.subscribe, read, read)
  const status = thinkingStatus({ version, kind, hidden, streaming, sends })
  const run = async () => {
    const entry = session.snapshot().entries.find((e) => e.version.id === version.id)
    if (!entry || busy || !status.toggles) return
    setBusy(true)
    const forkId = entry.shownForkId ?? session.snapshot().forkId
    const result = await session.setThinkingHidden(entry, kind, !hidden, forkId)
    setBusy(false)
    if (!result.ok)
      showToast({
        title: hidden ? "Couldn't send the thinking again" : "Couldn't leave the thinking out",
        description: result.error.message
      })
    else
      showToast({
        title: hidden ? "Thinking sent again" : "Thinking left out",
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
  const unavailable = busy || !status.toggles
  // The hover's text is the button's description too, so it isn't only in a tooltip.
  return (
    <>
      <Tooltip label={status.hint}>
        <button
          type="button"
          data-thinking-sent={status.sent ? "" : undefined}
          data-thinking-hidden={hidden ? "" : undefined}
          aria-describedby={hintId}
          className={`flex items-center gap-1 rounded-md border px-1 py-0.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-focus aria-disabled:cursor-not-allowed ${
            status.sent
              ? "border-accent/60 bg-accent/15 text-accent hover:bg-accent/25"
              : "border-border text-muted hover:bg-hover hover:text-text aria-disabled:hover:bg-transparent aria-disabled:hover:text-muted"
          }`}
          aria-disabled={unavailable ? true : undefined}
          aria-pressed={status.sent}
          onClick={() => void run()}
        >
          {/* Left out by the user: the ghost, as on a hidden message; by the settings: eye-off. */}
          <Icon name={status.sent ? "eye" : hidden ? "ghost" : "eyeOff"} size={14} />
          {status.sent ? "Sent to the model" : "Not sent to the model"}
        </button>
      </Tooltip>
      <span id={hintId} hidden>
        {status.hint}
      </span>
    </>
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
    <Tooltip label="Make this thinking part of the reply's text, as a new swipe; this one stays.">
      <button type="button" className={actionClass} disabled={busy} onClick={() => void run()}>
        Show as reply text
      </button>
    </Tooltip>
  )
}

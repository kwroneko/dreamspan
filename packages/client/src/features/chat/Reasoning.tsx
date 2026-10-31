// A version's reasoning ("thinking", DESIGN §7.4), above its text: it streams live, open by
// default, and folds when the reply is done; one click opens it again. Folding or opening it
// while the reply is still being written becomes the user's choice for every reply after
// (`user_prefs`, so it follows them to other devices). It's never sent back to the model.
// Its header carries the `reasoningActions` slot: Copy reasoning (the raw text) and Collapse
// all (every reasoning block shown closes; the streaming preference stays as it is).
// The reply's own leading tagged sections (spec/REPLY-SECTIONS.md) show in a second panel of
// the same kind, "Notes in the reply", below the provider's. Both are entries of the
// `reasoningPanels` slot.
import { useViewPrefs } from "../../ui/viewPrefs.ts"
import { useAtomValue } from "@effect/atom-react"
import type { Version } from "@rp/shared/chat.ts"
import type { ReasoningDisplay } from "@rp/shared/chatApi.ts"
import { sectionsDisplay, sectionUnclosed } from "@rp/shared/replySections.ts"
import { useId, useState, useSyncExternalStore } from "react"
import { Icon } from "../../ui/Icon.tsx"
import { Markdown } from "../../ui/Markdown.tsx"
import { MessageBody } from "../../ui/messageCopy.tsx"
import { SlotOutlet } from "../../slots.tsx"
import { reasoningActions, reasoningPanels } from "./presentation.tsx"
import { collapseCount, subscribeCollapses } from "./reasoningActions.tsx"
import { liveReasoning, liveSections, type ChatSession } from "./session.ts"

const words = (text: string) => {
  const count = text.trim() === "" ? 0 : text.trim().split(/\s+/).length
  return count === 1 ? "1 word" : `${count.toLocaleString()} words`
}

interface PanelProps {
  readonly version: Version
  readonly session: ChatSession
}

/** The provider's reasoning field. */
export function Reasoning({ version, session }: PanelProps) {
  const live = useAtomValue(liveReasoning(version.id))
  const text = live ?? version.reasoning ?? ""
  if (text === "") return null
  return (
    <ReasoningBlock
      key={version.id}
      version={version}
      session={session}
      text={text}
      streaming={version.status === "generating"}
      kind="reasoning"
      label="Reasoning"
    />
  )
}

/** The reply's own leading tagged sections, taken out of its text. */
export function ReplySections({ version, session }: PanelProps) {
  const live = useAtomValue(liveSections(version.id))
  const text = live ?? sectionsDisplay(version.replySections)
  const streaming = version.status === "generating"
  if (text === "" && !version.replySections) return null
  return (
    <ReasoningBlock
      key={version.id}
      version={version}
      session={session}
      text={text}
      streaming={streaming}
      kind="sections"
      label="Notes in the reply"
      notice={
        !streaming && sectionUnclosed(version.replySections)
          ? "This section was never closed: the reply ended inside it."
          : null
      }
    />
  )
}

export const registerReasoningPanels = () => [
  reasoningPanels.register({ id: "reasoning.provider", order: 10, component: Reasoning }),
  reasoningPanels.register({ id: "reasoning.reply-sections", order: 20, component: ReplySections })
]

/** Every registered panel, in order. */
export function ReasoningPanels(props: PanelProps) {
  return <SlotOutlet slot={reasoningPanels} props={props} />
}

function ReasoningBlock({
  version,
  session,
  text,
  streaming,
  kind,
  label,
  notice = null
}: PanelProps & {
  text: string
  streaming: boolean
  kind: "reasoning" | "sections"
  label: string
  notice?: string | null
}) {
  const id = useId()
  const viewer = useViewPrefs()
  const preferred: ReasoningDisplay = viewer.prefs.reasoning
  // What the user chose for this block; until then, open while streaming (as they prefer),
  // folded once the reply is done.
  const [chosen, setChosen] = useState<{ open: boolean; streaming: boolean } | null>(null)
  // A Collapse all since this block was shown closes it, as a choice for this block only.
  const collapsed = useSyncExternalStore(subscribeCollapses, collapseCount)
  const [seen, setSeen] = useState(collapsed)
  if (seen !== collapsed) {
    setSeen(collapsed)
    setChosen({ open: false, streaming })
  }
  const open =
    chosen !== null && chosen.streaming === streaming ? chosen.open : streaming ? preferred === "expanded" : false

  const toggle = () => {
    setChosen({ open: !open, streaming })
    // During a run the choice sticks: later replies stream that way too (DESIGN §7.4).
    if (streaming) {
      const reasoning: ReasoningDisplay = open ? "collapsed" : "expanded"
      if (reasoning !== preferred) void viewer.change({ reasoning })
    }
  }

  return (
    <div className="flex flex-col gap-1" data-reasoning-panel={kind}>
      <div className="flex flex-wrap items-center gap-x-1">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={toggle}
          className="-ml-1 flex w-fit max-w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-xs text-muted outline-none hover:bg-surface-raised hover:text-text focus-visible:ring-2 focus-visible:ring-focus"
        >
          <Icon name={open ? "down" : "right"} size={14} />
          <Icon name={kind === "reasoning" ? "reasoning" : "note"} size={14} />
          <span className="font-medium">{streaming ? `${label}…` : label}</span>
          <span aria-hidden="true">·</span>
          <span>{words(text)}</span>
        </button>
        <SlotOutlet slot={reasoningActions} props={{ version, text, streaming, kind, session }} />
      </div>
      {notice && <p className="text-xs text-muted">{notice}</p>}
      {open && (
        <div id={id} role="region" aria-label={label} className="border-l-2 border-border pl-3 text-sm text-muted">
          <MessageBody text={text}>
            <Markdown text={text} streaming={streaming} />
          </MessageBody>
        </div>
      )}
      {viewer.error && (
        <p role="alert" className="text-xs text-danger">
          Your choice wasn’t saved: {viewer.error.message}
        </p>
      )}
    </div>
  )
}

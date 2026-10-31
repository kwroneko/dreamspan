// A version's reasoning ("thinking", DESIGN §7.4), above its text: it streams live, open by
// default, and folds when the reply is done; one click opens it again. Folding or opening it
// while the reply is still being written becomes the user's choice for every reply after
// (`user_prefs`, so it follows them to other devices). It's never sent back to the model.
// Its header carries the `reasoningActions` slot: Copy reasoning (the raw text) and Collapse
// all (every reasoning block shown closes; the streaming preference stays as it is).
// The reply's own leading tagged sections (spec/REPLY-SECTIONS.md) show in a second panel of
// the same kind, "Thinking in the reply", below the provider's. Both are entries of the
// `reasoningPanels` slot.
import { useViewPrefs } from "../../ui/viewPrefs.ts"
import { useAtomValue } from "@effect/atom-react"
import type { SlotId, Version } from "@rp/shared/chat.ts"
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
import { useDisplayed } from "./useDisplayed.ts"

const words = (text: string) => {
  const count = text.trim() === "" ? 0 : text.trim().split(/\s+/).length
  return count === 1 ? "1 word" : `${count.toLocaleString()} words`
}

interface PanelProps {
  readonly version: Version
  readonly session: ChatSession
  /** The message's place, for its display scripts (useDisplayed.ts); absent: the chat's end. */
  readonly parentSlotId?: SlotId | null | undefined
  readonly depth?: number | undefined
}

/** The provider's reasoning field. */
function Reasoning({ version, session, parentSlotId, depth }: PanelProps) {
  const live = useAtomValue(liveReasoning(version.id))
  const text = live ?? version.reasoning ?? ""
  if (text === "") return null
  return (
    <ReasoningBlock
      key={version.id}
      version={version}
      session={session}
      parentSlotId={parentSlotId}
      depth={depth}
      text={text}
      streaming={version.status === "generating"}
      kind="reasoning"
      first
      label="Reasoning"
    />
  )
}

/** The reply's own leading tagged sections, taken out of its text. */
function ReplySections({ version, session, parentSlotId, depth }: PanelProps) {
  const live = useAtomValue(liveSections(version.id))
  const reasoning = useAtomValue(liveReasoning(version.id)) ?? version.reasoning ?? ""
  const text = live ?? sectionsDisplay(version.replySections)
  const streaming = version.status === "generating"
  if (text === "" && !version.replySections) return null
  return (
    <ReasoningBlock
      key={version.id}
      version={version}
      session={session}
      parentSlotId={parentSlotId}
      depth={depth}
      text={text}
      streaming={streaming}
      kind="sections"
      first={reasoning === ""}
      label="Thinking in the reply"
      notice={
        !streaming && sectionUnclosed(version.replySections)
          ? "Never closed: the reply ended inside its thinking."
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
  parentSlotId = null,
  depth = 0,
  text,
  streaming,
  kind,
  first,
  label,
  notice = null
}: PanelProps & {
  text: string
  streaming: boolean
  kind: "reasoning" | "sections"
  first: boolean
  label: string
  notice?: string | null
}) {
  const id = useId()
  const viewer = useViewPrefs()
  // Both panels display through the reasoning placement's display scripts, as ST's do.
  const shown = useDisplayed({ version, session, parentSlotId, depth }, text, 6, streaming)
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
      {/* The actions: beside the toggle, or a row of their own under it on a phone. */}
      <div className="flex flex-wrap items-center gap-x-2">
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
        <div className="flex w-full flex-wrap items-center gap-x-1 pl-4 empty:hidden sm:w-auto sm:pl-0">
          <SlotOutlet slot={reasoningActions} props={{ version, text, streaming, kind, first, session }} />
        </div>
      </div>
      {notice && <p className="pl-4 text-xs text-muted">{notice}</p>}
      {open && (
        <div id={id} role="region" aria-label={label} className="border-l-2 border-border pl-3 text-sm text-muted">
          <MessageBody text={text}>
            <Markdown text={shown.text ?? ""} sourceText={text} streaming={streaming} />
          </MessageBody>
          {shown.issues.map((issue, i) => (
            <p key={i} role="note" className="text-xs">
              {issue}
            </p>
          ))}
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

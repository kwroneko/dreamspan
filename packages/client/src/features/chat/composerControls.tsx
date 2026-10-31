// Concrete composer contribution points. Draft/fork handling stays in the composer host.
// Where each control goes:
// - `banner` and `queue`: full-width rows above the composer, only while they have something;
// - `strip`: the next-reply strip, one row of small chips (nextReplyStrip.tsx) above the box;
// - `speaker`: left of the box;
// - `tools`: icon buttons inside the box, after the text;
// - `actions`: the box's last buttons (write, send, stop).
// A control may name its placement per context (`compact`: a phone), to move rather than vanish.
import type { EntityId, PathEntry, MessageImages } from "@rp/shared/chat.ts"
import type { ComponentProps, ComponentType, ReactNode } from "react"
import { useSyncExternalStore } from "react"
import { makeRegistry } from "../../registry.ts"
import type { ReplyChoice } from "./ReplyFrom.tsx"
import type { SpeakerSwitcher } from "./SpeakerSwitcher.tsx"
import type { ChatSession, ChatView, Outcome } from "./session.ts"

export type Placement = "banner" | "queue" | "strip" | "speaker" | "tools" | "actions"
type Invocation = "button" | "keyboard"

export interface ComposerControlContext {
  readonly compact?: boolean
  readonly recoverQueued: (text: string, images?: MessageImages) => void
  readonly session: ChatSession
  readonly view: ChatView
  /** Opens a side panel tab. */
  readonly onSettings: (tab: "model" | "preset" | "cast") => void
  readonly speaker: ComponentProps<typeof SpeakerSwitcher>
  readonly recent: ReadonlyArray<{ id: EntityId; name: string; mediaId: string | null }>
  readonly onRecent: (id: EntityId) => void
  readonly guidance: boolean
  readonly prefsReady: boolean
  readonly changeGuidance: (next: boolean) => void
  readonly hint: string
  /** Who replies next, in a group. */
  readonly reply: ReplyChoice
  readonly leaf: PathEntry | undefined
  readonly leafGenerating: boolean | undefined
  readonly busy: boolean
  readonly ready: boolean
  readonly hasText: boolean
  readonly replier: EntityId | null
  readonly generateText: string
  readonly generateHint: string
  readonly sendLabel: string
  readonly sendHint: string
  readonly generate: () => Promise<void>
  readonly send: () => Promise<void>
  readonly replyNow: () => Promise<void>
  /** Stops the reply being written at the end of the chat. */
  readonly stop: () => Promise<void>
  /** The draft's earlier text (null while a reply's guidance is edited). */
  readonly history: ReactNode
  readonly report: (outcome: Outcome<unknown>) => void
}

export interface ComposerControl {
  readonly id: string
  readonly order: number
  readonly placement: Placement | ((context: ComposerControlContext) => Placement)
  readonly available?: (context: ComposerControlContext) => boolean
  readonly component: ComponentType<ComposerControlContext & { readonly invoke: () => void }>
  readonly run?: (context: ComposerControlContext, source: Invocation) => void | Promise<void>
}

export const composerControls = makeRegistry<ComposerControl>()
export const availableComposerControls = (
  placement: Placement,
  context: ComposerControlContext,
  snapshot = composerControls.snapshot()
) =>
  [...snapshot.entries]
    .sort((a, b) => a.order - b.order)
    .filter(
      (entry) =>
        (typeof entry.placement === "function" ? entry.placement(context) : entry.placement) === placement &&
        entry.available?.(context) !== false
    )

/** Both buttons and Enter resolve the effective registration at invocation time. */
export const invokeComposerControl = (id: string, context: ComposerControlContext, source: Invocation) => {
  const entry = composerControls.get(id)
  if (entry?.available?.(context) === false) return
  return entry?.run?.(context, source)
}

export function ComposerControls({ placement, context }: { placement: Placement; context: ComposerControlContext }) {
  const snapshot = useSyncExternalStore(
    composerControls.subscribe,
    composerControls.snapshot,
    composerControls.snapshot
  )
  const controls = availableComposerControls(placement, context, snapshot)
  return controls.map((entry) => (
    <entry.component
      key={entry.id}
      {...context}
      invoke={() => {
        void invokeComposerControl(entry.id, context, "button")
      }}
    />
  ))
}

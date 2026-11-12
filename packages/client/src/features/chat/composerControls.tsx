// Concrete composer contribution points. Draft/fork handling stays in the composer host.
// Where each control goes (Composer.tsx, top to bottom; owner 2026-11-01):
// - `queue`: full-width rows directly above the box, while there's something queued;
// - `banner`: rows at the top of the box, inside its border, saying how the box stands;
// - (the text, on a row of its own, the box's whole width)
// - `speaker`: the start of the box's control row, under the text;
// - `tools`: icon buttons after the speaker;
// - `actions`: the row's last buttons, at its right end (guidance, generate, send);
// - `strip`: the next-reply strip, one row of small chips (nextReplyStrip.tsx) under the box.
// A control may name its placement per context (`compact`: a phone), to move rather than vanish.
import type { EntityId, PathEntry, MessageImages } from "@rp/shared/chat.ts"
import type { AvatarCrop } from "@rp/shared/media.ts"
import type { ComponentProps, ComponentType, ReactNode } from "react"
import { useSyncExternalStore } from "react"
import { makeRegistry } from "../../registry.ts"
import { kindHides } from "./kindLooks.ts"
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
  readonly recent: ReadonlyArray<{ id: EntityId; name: string; mediaId: string | null; crop?: AvatarCrop | undefined }>
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
  /** Who replies after `replier`, in turn, in the round a send or Reply now starts (DESIGN §2.3). */
  readonly round: ReadonlyArray<EntityId>
  /** Generate's accessible name, "Generate Sam" (or "New version" while a reply's guidance is edited). */
  readonly generateText: string
  /** What Generate's button shows, a word: "Generate", or "New version". */
  readonly generateWord: string
  readonly generateHint: string
  readonly sendLabel: string
  readonly sendHint: string
  readonly generate: () => Promise<void>
  readonly send: () => Promise<void>
  readonly replyNow: () => Promise<void>
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
        controlApplies(entry, context)
    )

/** A control is offered unless the chat's kind leaves it out (kindLooks.ts) or it says it isn't. */
const controlApplies = (entry: ComposerControl, context: ComposerControlContext) =>
  !kindHides(kindOf(context), entry.id) && entry.available?.(context) !== false

/** The chat's kind; a context a control builds for itself (a plugin's test, say) may leave the view out. */
const kindOf = (context: ComposerControlContext) => (context.view as ChatView | undefined)?.chat?.kind

/** Both buttons and Enter resolve the effective registration at invocation time. */
export const invokeComposerControl = (id: string, context: ComposerControlContext, source: Invocation) => {
  const entry = composerControls.get(id)
  if (entry === undefined || !controlApplies(entry, context)) return
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

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
import type { EntityId, PathEntry, MessageImages } from "@dreamspan/shared/chat.ts"
import type { AvatarCrop } from "@dreamspan/shared/media.ts"
import type { ComponentProps, ComponentType, ReactNode } from "react"
import { useSyncExternalStore } from "react"
import { makeRegistry } from "../../registry.ts"
import { kindHides } from "./kindLooks.ts"
import type { ReplyChoice } from "./ReplyFrom.tsx"
import type { SpeakerSwitcher } from "./SpeakerSwitcher.tsx"
import type { Draft } from "@dreamspan/shared/drafts.ts"
import type { ComposerSource } from "./composerDraft.ts"
import type { ChatSession, ChatView, Outcome } from "./session.ts"

export type Placement = "banner" | "queue" | "strip" | "speaker" | "tools" | "actions"
type Invocation = "button" | "keyboard"

export interface ComposerControlContext {
  readonly draft: import("../../../../plugin-api/src/client.ts").DraftControl
  /** The box's text once typing pauses (`restedText.ts`): what reads it this way doesn't render per keystroke. */
  readonly typed: import("./restedText.ts").RestedText
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
  /** A reply's guidance is being edited: every submit is a new version of that reply. */
  readonly editingGuidance: boolean
  readonly prefsReady: boolean
  readonly changeGuidance: (next: boolean) => void
  readonly hint: string
  /** The selected speaker's name, for the guidance toggle's explanation; null without one. */
  readonly speakerName: string | null
  /** Who replies next, in a group. */
  readonly reply: ReplyChoice
  readonly leaf: PathEntry | undefined
  readonly leafGenerating: boolean | undefined
  readonly busy: boolean
  readonly ready: boolean
  readonly hasText: boolean
  readonly replier: EntityId | null
  /** Who replies after `replier`, in turn, in the round a send (or an empty Send) starts (DESIGN §2.3). */
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
  readonly source?: string
  readonly id: string
  readonly order: number
  readonly placement: Placement | ((context: ComposerControlContext) => Placement)
  readonly available?: (context: ComposerControlContext) => boolean
  readonly component: ComponentType<ComposerControlContext & { readonly invoke: () => void }>
  readonly run?: (context: ComposerControlContext, source: Invocation) => void | Promise<void>
}

export const composerControls = makeRegistry<ComposerControl>()

/** A send as the composer planned it: the text, who it's from, and who replies (replyPolicy.ts `planReply`). */
export interface PlannedSend {
  readonly session: ChatSession
  readonly view: ChatView
  readonly text: string
  readonly speaker: EntityId | null
  readonly plan: {
    readonly replier: EntityId | null
    readonly round: ReadonlyArray<EntityId>
    readonly reply: boolean
  }
  /** The decision model may choose the reply's speaker and the round (DESIGN §2.3). */
  readonly autoPick: boolean
  /** "Who replies next" is on: Auto's picks are the decision model's to change, wherever this send goes. */
  readonly decides: boolean
  readonly composer: ComposerSource
  readonly images?: MessageImages | undefined
  readonly imageDraftIds?: ReadonlyArray<string> | undefined
}

/**
 * Another way a typed message is sent (spec/PLUGINS.md §8): the first whose `takes` is true sends
 * it in place of the plain send, and its `hint` goes after Send's explanation. `subscribe` says
 * when `takes` or `hint` may have changed. Threads register one ("To 2 threads", spec/THREADS.md §6).
 */
export interface ComposerSendRoute {
  readonly id: string
  readonly order: number
  readonly subscribe: (listener: () => void) => () => void
  readonly takes: (session: ChatSession, view: ChatView) => boolean
  readonly hint?: (session: ChatSession, view: ChatView) => string
  readonly send: (send: PlannedSend) => Promise<{
    readonly sent: boolean
    readonly outcome: Outcome<unknown>
    readonly draft: Draft | null
    readonly recovered: number
  }>
}

export const composerSendRoutes = makeRegistry<ComposerSendRoute>()

/**
 * The route that takes the composer's sends now, or null for the plain send, with what it adds
 * to Send's hint.
 */
export function useSendRoute(
  session: ChatSession,
  view: ChatView
): { readonly route: ComposerSendRoute | null; readonly hint: string } {
  const { entries } = useSyncExternalStore(
    composerSendRoutes.subscribe,
    composerSendRoutes.snapshot,
    composerSendRoutes.snapshot
  )
  // The snapshot is a string (the route's id and hint): what a route reads changes outside React,
  // and a value computed beside the store would be memoized on the arguments by the React compiler.
  const subscribe = (listener: () => void) => {
    const stops = [...entries].map((route) => route.subscribe(listener))
    return () => {
      for (const stop of stops) stop()
    }
  }
  const pick = () => {
    const route = [...entries].sort((a, b) => a.order - b.order).find((route) => route.takes(session, view))
    return route === undefined ? "" : `${route.id}\n${route.hint?.(session, view) ?? ""}`
  }
  const picked = useSyncExternalStore(subscribe, pick, pick)
  const cut = picked.indexOf("\n")
  return cut < 0
    ? { route: null, hint: "" }
    : { route: entries.find((route) => route.id === picked.slice(0, cut)) ?? null, hint: picked.slice(cut + 1) }
}

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

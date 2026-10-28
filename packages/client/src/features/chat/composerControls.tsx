// Concrete composer contribution points. Draft/fork handling stays in the composer host.
import type { EntityId, PathEntry } from "@rp/shared/chat.ts"
import type { ComponentProps, ComponentType } from "react"
import { useSyncExternalStore } from "react"
import { makeRegistry } from "../../registry.ts"
import type { ReplyFrom } from "./ReplyFrom.tsx"
import type { SpeakerSwitcher } from "./SpeakerSwitcher.tsx"
import type { ChatSession, ChatView, Outcome } from "./session.ts"

type Placement = "settings" | "speaker" | "actions" | "guidance" | "reply" | "queue"
type Invocation = "button" | "keyboard"

export interface ComposerControlContext {
  readonly recoverQueued: (text: string) => void
  readonly session: ChatSession
  readonly view: ChatView
  readonly onSettings: (tab: "model" | "preset") => void
  readonly speaker: ComponentProps<typeof SpeakerSwitcher>
  readonly recent: ReadonlyArray<{ id: EntityId; name: string; mediaId: string | null }>
  readonly onRecent: (id: EntityId) => void
  readonly guidance: boolean
  readonly prefsReady: boolean
  readonly changeGuidance: (next: boolean) => void
  readonly hint: string
  readonly reply: ComponentProps<typeof ReplyFrom>
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
  readonly report: (outcome: Outcome<unknown>) => void
}

export interface ComposerControl {
  readonly id: string
  readonly order: number
  readonly placement: Placement
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
    .filter((entry) => entry.placement === placement && entry.available?.(context) !== false)

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

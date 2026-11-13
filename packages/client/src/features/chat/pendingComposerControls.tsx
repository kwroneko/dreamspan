// A pending chat has no ChatSession yet. Its controls share a registry and the same
// speaker/guidance contract, while chat creation remains lazy in the host.
import type { ComponentProps, ComponentType } from "react"
import { useSyncExternalStore } from "react"
import { makeRegistry } from "../../registry.ts"
import type { SpeakerSwitcher } from "./SpeakerSwitcher.tsx"
import type { ChatView } from "./session.ts"
import type { DraftPreviewState } from "./draftRequest.tsx"

export interface PendingComposerContext {
  /** A phone: the speaker chip is its portrait, Generate an icon, as at the chat's composer. */
  readonly compact: boolean
  readonly speaker: ComponentProps<typeof SpeakerSwitcher>
  readonly submitHint: string
  readonly speakerName: string
  readonly guidance: boolean
  readonly prefsReady: boolean
  readonly changeGuidance: (next: boolean) => void
  readonly busy: boolean
  readonly hasText: boolean
  readonly start: (first: "send" | "generate") => Promise<void>
  /** The pending chat as the saved chat's parts read it (pendingChat.ts). */
  readonly view: ChatView
  /** Opens the side panel at a tab, as the saved composer's chips do. */
  readonly onSettings: (tab: string) => void
  /** The first request, built as the box and the choices change (draftRequest.tsx). */
  readonly draft: DraftPreviewState
  /** The cards from a card source the first turn adds (spec/CARD-SOURCES.md §4.4), by name; empty for local cards. */
  readonly adds: string
}
interface PendingControl {
  readonly id: string
  readonly order: number
  /**
   * `notes`: a row of its own above the composer, for what the user should know before sending;
   * `strip`: the next-reply strip under the box, as at the saved chat's composer.
   */
  readonly placement: "notes" | "speaker" | "actions" | "guidance" | "strip"
  readonly component: ComponentType<PendingComposerContext>
  readonly run?: (context: PendingComposerContext) => Promise<void>
}
export const pendingComposerControls = makeRegistry<PendingControl>()

export const invokePendingComposer = (context: PendingComposerContext) =>
  pendingComposerControls.get(context.guidance ? "pending.generate" : "pending.send")?.run?.(context)

export function PendingComposerControls({
  placement,
  context
}: {
  placement: PendingControl["placement"]
  context: PendingComposerContext
}) {
  const snapshot = useSyncExternalStore(pendingComposerControls.subscribe, pendingComposerControls.snapshot)
  return [...snapshot.entries]
    .sort((a, b) => a.order - b.order)
    .filter((entry) => entry.placement === placement)
    .map((entry) => <entry.component key={entry.id} {...context} />)
}

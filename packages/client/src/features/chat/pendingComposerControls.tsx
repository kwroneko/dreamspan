// A pending chat has no ChatSession yet. Its controls share a registry and the same
// speaker/guidance contract, while chat creation remains lazy in the host.
import type { ComponentProps, ComponentType } from "react"
import { useSyncExternalStore } from "react"
import { makeRegistry } from "../../registry.ts"
import type { SpeakerSwitcher } from "./SpeakerSwitcher.tsx"

export interface PendingComposerContext {
  readonly speaker: ComponentProps<typeof SpeakerSwitcher>
  readonly submitHint: string
  readonly speakerName: string
  readonly guidance: boolean
  readonly prefsReady: boolean
  readonly changeGuidance: (next: boolean) => void
  readonly busy: boolean
  readonly hasText: boolean
  readonly start: (first: "send" | "generate") => Promise<void>
}
interface PendingControl {
  readonly id: string
  readonly order: number
  readonly placement: "speaker" | "actions" | "guidance"
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

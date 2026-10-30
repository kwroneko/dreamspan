// Fine-grained chat surfaces. Defaults and plugins use the same reversible registries.
import { useSyncExternalStore, type ComponentProps, type ComponentType, type ReactNode } from "react"
import type { PathEntry } from "@rp/shared/chat.ts"
import type { ChatNote } from "@rp/shared/chatSetupApi.ts"
import { makeRegistry } from "../../registry.ts"
import { defineSlot, SlotOutlet } from "../../slots.tsx"
import type { ChatCardActionProps } from "./CardForkDialogs.tsx"
import type { RetryWith, Versions } from "./VersionControls.tsx"
import type { LcmBoundary } from "./LcmBoundary.tsx"
import type { TimelineSummary } from "./TimelineSummary.tsx"
import type { CoverageRail } from "./CoverageRail.tsx"
import type { LcmFields } from "./LcmFields.tsx"
import type { ChatSession, ChatView } from "./session.ts"

export const chatCardActions = defineSlot<ChatCardActionProps>("chat.card-actions")
export function ChatCardActions(props: ChatCardActionProps) {
  return <SlotOutlet slot={chatCardActions} props={props} />
}
export const chatSettingSections = defineSlot<{ session: ChatSession }>("chat.setting-sections")
/** Actions in an opened chat note's row, above its editor; `onChanged` reads the notes again. */
export const chatNoteActions = defineSlot<{ note: ChatNote; session: ChatSession; onChanged: () => void }>(
  "chat.note-actions"
)
export const summarySettingFields = defineSlot<ComponentProps<typeof LcmFields>>("chat.summary-setting-fields")
export const timelineBoundaries = defineSlot<ComponentProps<typeof LcmBoundary>>("chat.timeline-boundaries")
export const timelineSummaries = defineSlot<ComponentProps<typeof TimelineSummary>>("chat.timeline-summaries")
export const timelineRails = defineSlot<ComponentProps<typeof CoverageRail>>("chat.timeline-rails")
export const messageRetries = defineSlot<ComponentProps<typeof RetryWith>>("message.retry")
/** Under a reply: the guidance it was written with (guidanceEdit.tsx). */
export const messageDirections = defineSlot<{ entry: PathEntry; session: ChatSession }>("message.direction")
interface VersionNavigationContext {
  readonly entry: PathEntry
  readonly session: ChatSession
  readonly defaultStep: (step: -1 | 1) => Promise<void>
}
export const messageVersions = {
  id: "message.versions",
  ...makeRegistry<{
    readonly id: string
    readonly order: number
    readonly component: ComponentType<ComponentProps<typeof Versions>>
    /** Both arrow buttons and touch swipes dispatch here. Omit to decline gestures. */
    readonly step?: (context: VersionNavigationContext, direction: -1 | 1) => void | Promise<void>
  }>()
}
export const useVersionNavigation = () => {
  const snapshot = useSyncExternalStore(messageVersions.subscribe, messageVersions.snapshot, messageVersions.snapshot)
  return [...snapshot.entries].sort((a, b) => a.order - b.order).find((entry) => entry.step)
}
export interface ChatSurfaceProps {
  readonly session: ChatSession
  readonly view: ChatView
  readonly cast: import("./cast.ts").CastView
  readonly onOpenPanel: (tab: string | null, focus?: string) => void
  readonly wide: boolean
  readonly children: ReactNode
}
export const chatSurfaceProviders = makeRegistry<{
  readonly id: string
  readonly order: number
  readonly component: ComponentType<ChatSurfaceProps>
}>()
export function ChatSurfaceProviders(props: ChatSurfaceProps) {
  const snapshot = useSyncExternalStore(
    chatSurfaceProviders.subscribe,
    chatSurfaceProviders.snapshot,
    chatSurfaceProviders.snapshot
  )
  return [...snapshot.entries]
    .sort((a, b) => b.order - a.order)
    .reduce<ReactNode>(
      (children, entry) => (
        <entry.component key={entry.id} {...props}>
          {children}
        </entry.component>
      ),
      props.children
    )
}
export const chatOverlays = defineSlot<{ session: ChatSession; view: ChatView }>("chat.overlays")
/** Notes about the next request just above the composer, such as its images' token estimate. */
export const chatComposerNotes = defineSlot<{ view: ChatView }>("chat.composer-notes")

export const accountSettingSections = defineSlot<import("./ChatDefaults.tsx").SummaryDefaultsProps>(
  "chat.account-setting-sections"
)
export const chatComposer = defineSlot<ComponentProps<typeof import("./Composer.tsx").Composer>>("chat.composer")

export const chatBranchControls =
  defineSlot<ComponentProps<typeof import("./ChatHeader.tsx").BranchMenu>>("chat.branch-controls")
export const messagePreviews = defineSlot<{ entry: PathEntry; session: ChatSession }>("message.previews")
export const summaryPreviews = defineSlot<{ summary: import("@rp/shared/lcm.ts").LcmSummary; session: ChatSession }>(
  "summary.previews"
)

export const queuedPreviews = defineSlot<{ queued: import("@rp/shared/chat.ts").QueuedMessage }>("chat.queued-previews")

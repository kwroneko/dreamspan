// Fine-grained chat surfaces. Defaults and plugins use the same reversible registries.
import { useSyncExternalStore, type ComponentProps, type ComponentType, type ReactNode } from "react"
import type { PathEntry } from "@rp/shared/chat.ts"
import type { ChatNote } from "@rp/shared/chatSetupApi.ts"
import { makeRegistry } from "../../registry.ts"
import { defineSlot, SlotOutlet } from "../../slots.tsx"
import type { ChatCardActionProps } from "./CardForkDialogs.tsx"
import type { Versions } from "./VersionControls.tsx"
import type { LcmBoundary } from "./LcmBoundary.tsx"
import type { TimelineSummary } from "./TimelineSummary.tsx"
import type { CoverageRail } from "./CoverageRail.tsx"
import type { LcmFields } from "./LcmFields.tsx"
import type { ChatSession, ChatView } from "./session.ts"

export const chatCardActions = defineSlot<ChatCardActionProps>("chat.card-actions")
/** Navigation immediately after Write as in a cast member's menu. */
export const castMemberNavigation = defineSlot<{ session: ChatSession; card: import("@rp/shared/chat.ts").CastCard }>(
  "chat.cast-member-navigation"
)
export function ChatCardActions(props: ChatCardActionProps) {
  return <SlotOutlet slot={chatCardActions} props={props} />
}
export const chatSettingSections = defineSlot<{ session: ChatSession }>("chat.setting-sections")
/**
 * Sections of the request inspector after the context and what it left out (ContextPage.tsx): an
 * agent reply's tools and steps (agent/RunSteps.tsx), the run behind the request.
 */
export const runInspectorSections = defineSlot<{ readonly run: import("@rp/shared/inspectorApi.ts").RunContext }>(
  "inspector.run-sections"
)
/** Sections of the Cast tab under the cast itself: Add characters (CastAdd.tsx). */
export const castSections = defineSlot<{ session: ChatSession }>("chat.cast-sections")
/** The same sections in a chat not made yet: who answers first, Add characters. */
export const pendingCastSections = defineSlot<{ pending: import("./pendingChat.ts").PendingChat }>(
  "chat.pending-cast-sections"
)
/** Actions in an opened chat note's row, above its editor; `onChanged` reads the notes again. */
export const chatNoteActions = defineSlot<{ note: ChatNote; session: ChatSession; onChanged: () => void }>(
  "chat.note-actions"
)
/** Sections of the Summaries tab after the summaries themselves: their settings, say. */
export const summaryPanelSections = defineSlot<{ session: ChatSession }>("chat.summary-panel-sections")
export const summarySettingFields = defineSlot<ComponentProps<typeof LcmFields>>("chat.summary-setting-fields")
export const timelineBoundaries = defineSlot<ComponentProps<typeof LcmBoundary>>("chat.timeline-boundaries")
export const timelineSummaries = defineSlot<ComponentProps<typeof TimelineSummary>>("chat.timeline-summaries")
export const timelineRails = defineSlot<ComponentProps<typeof CoverageRail>>("chat.timeline-rails")
/**
 * In a message's header, after its name and its message details (messageDetails.tsx: time,
 * model): badges such as the rewrite mark. A detail the user can hide is a message detail instead.
 */
export const messageHeaderDetails = defineSlot<{ entry: PathEntry; session: ChatSession; generating: boolean }>(
  "message.header-details"
)
/** In a reply's reasoning header, beside its toggle: Copy reasoning, Collapse all (Reasoning.tsx). */
export interface ReasoningActionProps {
  readonly version: import("@rp/shared/chat.ts").Version
  /** The reasoning as stored, or as streamed so far: never the rendered Markdown. */
  readonly text: string
  readonly streaming: boolean
  /** Which panel: the provider's reasoning, or the reply's own tagged sections (spec/REPLY-SECTIONS.md). */
  readonly kind: "reasoning" | "sections"
  /** The user hid it from the model on this version, in the fork shown (SetThinkingHidden). */
  readonly hidden: boolean
  /** Whether it's the reply's first panel shown (Collapse all shows once, there). */
  readonly first: boolean
  readonly session: ChatSession
}
export const reasoningActions = defineSlot<ReasoningActionProps>("message.reasoning-actions")
/**
 * The collapsible panels above a reply's text: the provider's Reasoning, then the reply's
 * own tagged sections ("Thinking in the reply", spec/REPLY-SECTIONS.md), each an entry here.
 */
export const reasoningPanels = defineSlot<{
  readonly version: import("@rp/shared/chat.ts").Version
  readonly session: ChatSession
}>("message.reasoning-panels")
/**
 * The message stream around a message: `below` it (each message), and `above` it (the first
 * message of the path). The insertion editor opens here (insertMessage/).
 */
export const messageStream = defineSlot<{ entry: PathEntry; session: ChatSession; place: "above" | "below" }>(
  "chat.message-stream"
)
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
  readonly onOpenPanel: (tab: string | null) => void
  readonly wide: boolean
  readonly children: ReactNode
  /**
   * Providers left out: a chat shown inside another's panel (the workshop beside a story) skips
   * those that belong to the page, such as the portrait column and the editor tabs' workspace.
   */
  readonly except?: ReadonlySet<string>
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
    .filter((entry) => !props.except?.has(entry.id))
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
/** Columns left of the messages, beside them on a wide screen: the portrait (`chat.portrait-column`). */
export const chatColumns = defineSlot<{ wide: boolean }>("chat.columns")
export const chatOverlays = defineSlot<{ session: ChatSession; view: ChatView }>("chat.overlays")
/** Actions beside a failed version's error, such as saving a context size its error states. */
export const versionFailureActions = defineSlot<{ version: import("@rp/shared/chat.ts").Version }>(
  "message.failure-actions"
)
/** Notes about the next request just above the composer, such as its images' token estimate. */
export const chatComposerNotes = defineSlot<{ view: ChatView }>("chat.composer-notes")

export const accountSettingSections = defineSlot<import("./ChatDefaults.tsx").SummaryDefaultsProps>(
  "chat.account-setting-sections"
)
export const chatComposer = defineSlot<ComponentProps<typeof import("./Composer.tsx").Composer>>("chat.composer")

/** The header's branch control (`chat.branches`: BranchControl.tsx). */
export const chatBranchControls = defineSlot<import("./BranchControl.tsx").BranchControlProps>("chat.branch-controls")
/** The header's buttons at the end of its row, after the branch control: the pin, the panel, ⋯. */
export const chatHeaderActions = defineSlot<import("./ChatHeader.tsx").ChatHeaderActionProps>("chat.header-actions")
/** The same buttons in a chat not made yet (before the first send): the panel. */
export const pendingChatHeaderActions =
  defineSlot<import("./ChatHeader.tsx").PendingHeaderActionProps>("chat.pending-header-actions")
export const messagePreviews = defineSlot<{ entry: PathEntry; session: ChatSession }>("message.previews")
export const summaryPreviews = defineSlot<{ summary: import("@rp/shared/lcm.ts").LcmSummary; session: ChatSession }>(
  "summary.previews"
)

export const queuedPreviews = defineSlot<{ queued: import("@rp/shared/chat.ts").QueuedMessage }>("chat.queued-previews")

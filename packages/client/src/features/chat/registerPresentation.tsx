import { PresetWorkspace } from "../editor/PresetWorkspace.tsx"
import { ChatExternalMedia } from "./externalMedia.tsx"
import { SplitChatDivider } from "./SplitChatDivider.tsx"
import { AwayRows } from "./AwayRows.tsx"
import { StateRows } from "./StateRows.tsx"
import { registerStateMarkerKinds } from "./stateMarkers.ts"
import { ContextViewSection } from "./ContextViewSection.tsx"
import { messageStream, runInspectorSections } from "./presentation.tsx"
import { MacroBindings } from "./MacroBindings.tsx"
import { registerImages } from "./images.tsx"
import { registerTimelineTransforms } from "./timelineContributions.tsx"
import { NextImagesNote } from "./imageTokens.tsx"
import { ReplyChoicesSetting } from "./ReplyChoicesSetting.tsx"
import { ContextSetting } from "./ContextSetting.tsx"
import { lazy, Suspense, type ComponentType, type ReactNode } from "react"
import { Loading } from "../../ui/Spinner.tsx"
import {
  accountSettingSections,
  chatComposer,
  chatComposerNotes,
  chatCardActions,
  castSections,
  pendingCastSections,
  chatBranchControls,
  messagePreviews,
  summaryPreviews,
  chatColumns,
  chatSettingSections,
  chatSurfaceProviders,
  messageVersions,
  summarySettingFields,
  summaryPanelSections,
  timelineBoundaries,
  timelineRails,
  timelineSummaries,
  versionFailureActions
} from "./presentation.tsx"
import { LcmBoundary } from "./LcmBoundary.tsx"
import { CoverageRail } from "./CoverageRail.tsx"
import { HistoryMessagePreview, HistorySummaryPreview, HistoryPreviewProvider } from "./historyPreview.tsx"
import { ChatPortraitProvider } from "./ChatPortraitProvider.tsx"
import { BoundPortraits } from "./BoundPortraits.tsx"
import { boundEditorSurroundings } from "../editor/workspaceViews.ts"
import { PortraitColumn } from "./PortraitColumn.tsx"
import { AssemblyRefusal } from "./AssemblyRefusal.tsx"
import { LearnContextLimit } from "./LearnContextLimit.tsx"
/** A part whose code loads on first use; `fallback` shows meanwhile (nothing by default). */
function deferred<P extends object>(load: () => Promise<{ default: ComponentType<P> }>, fallback: ReactNode = null) {
  const Component = lazy(load)
  return (props: P) => (
    <Suspense fallback={fallback}>
      <Component {...props} />
    </Suspense>
  )
}
const SummaryDefaults = deferred<Parameters<typeof import("./ChatDefaults.tsx").SummaryDefaults>[0]>(() =>
  import("./ChatDefaults.tsx").then((m) => ({ default: m.SummaryDefaults }))
)
const EditChatCard = deferred<Parameters<typeof import("./CardForkDialogs.tsx").EditChatCard>[0]>(() =>
  import("./CardForkDialogs.tsx").then((m) => ({ default: m.EditChatCard }))
)
const ForkChatCard = deferred<Parameters<typeof import("./CardForkDialogs.tsx").ForkChatCard>[0]>(() =>
  import("./CardForkDialogs.tsx").then((m) => ({ default: m.ForkChatCard }))
)
const ChooseChatCard = deferred<Parameters<typeof import("./CardForkDialogs.tsx").ChooseChatCard>[0]>(() =>
  import("./CardForkDialogs.tsx").then((m) => ({ default: m.ChooseChatCard }))
)
const CastAddSection = deferred<Parameters<typeof import("./CastAdd.tsx").CastAddSection>[0]>(() =>
  import("./CastAdd.tsx").then((m) => ({ default: m.CastAddSection }))
)
const PendingCastAddSection = deferred<Parameters<typeof import("./CastAdd.tsx").PendingCastAddSection>[0]>(() =>
  import("./CastAdd.tsx").then((m) => ({ default: m.PendingCastAddSection }))
)
const PendingReplyFrom = deferred<Parameters<typeof import("./ReplyOrder.tsx").PendingReplyFrom>[0]>(() =>
  import("./ReplyOrder.tsx").then((m) => ({ default: m.PendingReplyFrom }))
)
const ReplyOrderSection = deferred<Parameters<typeof import("./ReplyOrder.tsx").ReplyOrderSection>[0]>(() =>
  import("./ReplyOrder.tsx").then((m) => ({ default: m.ReplyOrderSection }))
)
const CardLayoutSetting = deferred<Parameters<typeof import("./CardLayoutSetting.tsx").CardLayoutSetting>[0]>(() =>
  import("./CardLayoutSetting.tsx").then((m) => ({ default: m.CardLayoutSetting }))
)
const HtmlDepthSetting = deferred<Parameters<typeof import("./HtmlDepthSetting.tsx").HtmlDepthSetting>[0]>(() =>
  import("./HtmlDepthSetting.tsx").then((m) => ({ default: m.HtmlDepthSetting }))
)
const OneReplySection = deferred<Parameters<typeof import("./ReplyOrder.tsx").OneReplySection>[0]>(() =>
  import("./ReplyOrder.tsx").then((m) => ({ default: m.OneReplySection }))
)
const Versions = deferred<Parameters<typeof import("./VersionControls.tsx").Versions>[0]>(() =>
  import("./VersionControls.tsx").then((m) => ({ default: m.Versions }))
)
// The summary settings' fields: their section already shows the summary model above them, so
// while their code loads it says so instead of looking complete.
const LcmFields = deferred<Parameters<typeof import("./LcmFields.tsx").LcmFields>[0]>(
  () => import("./LcmFields.tsx").then((m) => ({ default: m.LcmFields })),
  <Loading />
)
const BranchControl = deferred<Parameters<typeof import("./BranchControl.tsx").BranchControl>[0]>(() =>
  import("./BranchControl.tsx").then((m) => ({ default: m.BranchControl }))
)
const Composer = lazy(() => import("./Composer.tsx").then((m) => ({ default: m.Composer })))
const Summary = lazy(() => import("./TimelineSummary.tsx").then((m) => ({ default: m.TimelineSummary })))
const ChatIdentity = deferred<Parameters<typeof import("./ThisChatTab.tsx").ChatIdentity>[0]>(() =>
  import("./ThisChatTab.tsx").then((m) => ({ default: m.ChatIdentity }))
)
const SummariesSwitch = deferred<Parameters<typeof import("./ThisChatTab.tsx").SummariesSwitch>[0]>(() =>
  import("./ThisChatTab.tsx").then((m) => ({ default: m.SummariesSwitch }))
)
const SummarySettings = deferred<Parameters<typeof import("./ThisChatTab.tsx").SummarySettings>[0]>(() =>
  import("./ThisChatTab.tsx").then((m) => ({ default: m.SummarySettings }))
)
const MergeLayoutSetting = deferred<Parameters<typeof import("./ThisChatTab.tsx").MergeLayoutSetting>[0]>(() =>
  import("./ThisChatTab.tsx").then((m) => ({ default: m.MergeLayoutSetting }))
)
const RolesSetting = deferred<Parameters<typeof import("./ThisChatTab.tsx").RolesSetting>[0]>(() =>
  import("./ThisChatTab.tsx").then((m) => ({ default: m.RolesSetting }))
)

export const registerPresentation = () => [
  messageStream.register({ id: "chat.split-divider", order: 30, component: SplitChatDivider }),
  // Where a character left the scene or came back, with Undo for the scene check's (CU3).
  messageStream.register({ id: "chat.away-rows", order: 20, component: AwayRows }),
  // Where who's in the chat, a note, the chat's model or preset, or a setting changed (stateMarkers.ts).
  messageStream.register({ id: "chat.state-markers", source: import.meta.url, order: 25, component: StateRows }),
  ...registerStateMarkerKinds(),
  // In the request inspector: whose view a separate context was written from, and what it left out (CU5).
  runInspectorSections.register({ id: "inspector.context-view", order: 5, component: ContextViewSection }),
  ...registerTimelineTransforms(),
  chatBranchControls.register({ id: "chat.branches", order: 10, component: BranchControl }),
  messagePreviews.register({ id: "history.message-preview", order: 10, component: HistoryMessagePreview }),
  summaryPreviews.register({ id: "history.summary-preview", order: 10, component: HistorySummaryPreview }),
  accountSettingSections.register({ id: "settings.summary-defaults", order: 10, component: SummaryDefaults }),
  chatComposerNotes.register({
    id: "composer.assembly-error",
    order: 5,
    component: ({ view }) => (view.history?.assemblyError ? <AssemblyRefusal history={view.history} /> : null)
  }),
  versionFailureActions.register({ id: "version.learn-context", order: 10, component: LearnContextLimit }),
  chatComposerNotes.register({
    id: "composer.image-tokens",
    order: 10,
    component: ({ view }) => (view.history?.imageTokens ? <NextImagesNote images={view.history.imageTokens} /> : null)
  }),
  chatComposer.register({
    id: "chat.composer",
    order: 10,
    component: (props) => (
      <Suspense fallback={null}>
        <Composer {...props} />
      </Suspense>
    )
  }),
  chatCardActions.register({ id: "card.edit", order: 10, component: EditChatCard }),
  chatCardActions.register({ id: "card.fork-for-chat", order: 20, component: ForkChatCard }),
  chatCardActions.register({ id: "card.choose-version", order: 30, component: ChooseChatCard }),
  castSections.register({ id: "cast.reply-order", order: 5, component: ReplyOrderSection }),
  castSections.register({ id: "cast.one-reply", order: 6, component: OneReplySection }),
  castSections.register({ id: "cast.add-characters", order: 10, component: CastAddSection }),
  // The same sections in a chat not made yet: who answers the first message, Add characters.
  pendingCastSections.register({ id: "cast.reply-order", order: 5, component: PendingReplyFrom }),
  pendingCastSections.register({ id: "cast.add-characters", order: 10, component: PendingCastAddSection }),
  // This chat leads with what a person touches; what few need comes after, collapsed.
  chatSettingSections.register({ id: "settings.chat", order: 1, component: ChatIdentity }),
  chatSettingSections.register({ id: "settings.summaries", order: 10, component: SummariesSwitch }),
  chatSettingSections.register({ id: "settings.context", order: 15, component: ContextSetting }),
  chatSettingSections.register({ id: "settings.external-media", order: 17, component: ChatExternalMedia }),
  chatSettingSections.register({ id: "settings.html-depth", order: 16, component: HtmlDepthSetting }),
  chatSettingSections.register({ id: "settings.card-layout", order: 30, component: CardLayoutSetting }),
  chatSettingSections.register({ id: "settings.who-replies", order: 40, component: ReplyChoicesSetting }),
  chatSettingSections.register({ id: "settings.macro-bindings", order: 80, component: MacroBindings }),
  chatSettingSections.register({ id: "settings.merge-layout", order: 85, component: MergeLayoutSetting }),
  chatSettingSections.register({ id: "settings.roles", order: 90, component: RolesSetting }),
  summaryPanelSections.register({ id: "summaries.settings", order: 100, component: SummarySettings }),
  summarySettingFields.register({ id: "settings.summary-fields", order: 10, component: LcmFields }),
  timelineBoundaries.register({ id: "timeline.lcm-boundary", order: 10, component: LcmBoundary }),
  timelineSummaries.register({
    id: "timeline.summary",
    order: 10,
    component: (props) => (
      <Suspense fallback={null}>
        <Summary {...props} />
      </Suspense>
    )
  }),
  timelineRails.register({ id: "timeline.coverage", order: 10, component: CoverageRail }),
  messageVersions.register({
    id: "message.versions",
    order: 10,
    component: Versions,
    step: ({ defaultStep }, step) => defaultStep(step)
  }),
  chatSurfaceProviders.register({
    id: "chat.history-preview",
    order: 10,
    component: ({ children }) => <HistoryPreviewProvider>{children}</HistoryPreviewProvider>
  }),
  chatSurfaceProviders.register({
    id: "chat.preset-workspace",
    order: 20,
    component: ({ children, session, view, cast, wide, onOpenPanel }) => (
      <PresetWorkspace
        compact={!wide}
        context={view.history?.presetContext ?? null}
        chat={{ chatId: session.id, forkId: view.forkId }}
        live={{ session, cast }}
        onOpen={() => {
          if (!wide) onOpenPanel(null)
        }}
      >
        {children}
      </PresetWorkspace>
    )
  }),
  chatSurfaceProviders.register({
    id: "chat.portraits",
    order: 30,
    component: ({ wide, cast, view, children }) => (
      <ChatPortraitProvider wide={wide} cast={cast} ready={view.cast !== null}>
        {children}
      </ChatPortraitProvider>
    )
  }),
  chatColumns.register({ id: "chat.portrait-column", order: 10, component: PortraitColumn }),
  // An editor opened from the chat, in its own tab, opens pictures in the same column beside it.
  boundEditorSurroundings.register({ id: "chat.portraits", order: 10, component: BoundPortraits }),
  ...registerImages()
]

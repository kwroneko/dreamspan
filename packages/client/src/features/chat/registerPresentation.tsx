import { MacroBindings } from "./MacroBindings.tsx"
import { registerImages } from "./images.tsx"
import { registerTimelineTransforms } from "./timelineContributions.tsx"
import { NextImagesNote } from "./imageTokens.tsx"
import { lazy, Suspense, type ComponentType } from "react"
import {
  accountSettingSections,
  chatComposer,
  chatComposerNotes,
  chatCardActions,
  chatBranchControls,
  messagePreviews,
  summaryPreviews,
  chatColumns,
  chatOverlays,
  chatSettingSections,
  chatSurfaceProviders,
  messageRetries,
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
import { PortraitProvider } from "../../ui/Portrait.tsx"
import { PortraitColumn } from "./PortraitColumn.tsx"
import { AssemblyRefusal } from "./AssemblyRefusal.tsx"
import { LearnContextLimit } from "./LearnContextLimit.tsx"
function deferred<P extends object>(load: () => Promise<{ default: ComponentType<P> }>) {
  const Component = lazy(load)
  return (props: P) => (
    <Suspense fallback={null}>
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
const RetryWith = deferred<Parameters<typeof import("./VersionControls.tsx").RetryWith>[0]>(() =>
  import("./VersionControls.tsx").then((m) => ({ default: m.RetryWith }))
)
const Versions = deferred<Parameters<typeof import("./VersionControls.tsx").Versions>[0]>(() =>
  import("./VersionControls.tsx").then((m) => ({ default: m.Versions }))
)
const LcmFields = deferred<Parameters<typeof import("./LcmFields.tsx").LcmFields>[0]>(() =>
  import("./LcmFields.tsx").then((m) => ({ default: m.LcmFields }))
)
const PresetWorkspace = deferred<Parameters<typeof import("../editor/PresetWorkspace.tsx").PresetWorkspace>[0]>(() =>
  import("../editor/PresetWorkspace.tsx").then((m) => ({ default: m.PresetWorkspace }))
)
const PresetOverlayHost = deferred<Parameters<typeof import("../editor/PresetWorkspace.tsx").PresetOverlayHost>[0]>(
  () => import("../editor/PresetWorkspace.tsx").then((m) => ({ default: m.PresetOverlayHost }))
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
const RolesSetting = deferred<Parameters<typeof import("./ThisChatTab.tsx").RolesSetting>[0]>(() =>
  import("./ThisChatTab.tsx").then((m) => ({ default: m.RolesSetting }))
)
const AccountSettingsNote = deferred<{ session: import("./session.ts").ChatSession }>(() =>
  import("./ThisChatTab.tsx").then((m) => ({ default: m.AccountSettingsNote }))
)

export const registerPresentation = () => [
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
  // This chat leads with what a person touches; what few need comes after, collapsed.
  chatSettingSections.register({ id: "settings.chat", order: 1, component: ChatIdentity }),
  chatSettingSections.register({ id: "settings.summaries", order: 10, component: SummariesSwitch }),
  chatSettingSections.register({ id: "settings.macro-bindings", order: 80, component: MacroBindings }),
  chatSettingSections.register({ id: "settings.roles", order: 90, component: RolesSetting }),
  chatSettingSections.register({ id: "settings.account", order: 100, component: AccountSettingsNote }),
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
  messageRetries.register({ id: "message.retry-with", order: 10, component: RetryWith }),
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
    component: ({ children, session, view, wide, onOpenPanel }) => (
      <PresetWorkspace
        context={view.history?.presetContext ?? null}
        chat={{ chatId: session.id, forkId: view.forkId }}
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
    component: ({ wide, children }) => <PortraitProvider inline={wide}>{children}</PortraitProvider>
  }),
  chatColumns.register({ id: "chat.portrait-column", order: 10, component: PortraitColumn }),
  chatOverlays.register({ id: "chat.preset-overlay", order: 10, component: () => <PresetOverlayHost /> }),
  ...registerImages()
]

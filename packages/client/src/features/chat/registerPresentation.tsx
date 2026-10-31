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
  chatNoteActions,
  chatBranchControls,
  messagePreviews,
  summaryPreviews,
  chatOverlays,
  chatSettingSections,
  chatSurfaceProviders,
  messageRetries,
  messageVersions,
  summarySettingFields,
  timelineBoundaries,
  timelineRails,
  timelineSummaries
} from "./presentation.tsx"
import { LcmBoundary } from "./LcmBoundary.tsx"
import { AuthorNoteAction } from "./AuthorNoteAction.tsx"
import { CoverageRail } from "./CoverageRail.tsx"
import { HistoryMessagePreview, HistorySummaryPreview, HistoryPreviewProvider } from "./historyPreview.tsx"
import { PortraitProvider } from "../../ui/Portrait.tsx"
import { Alert } from "../../ui/Surface.tsx"
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
const BranchMenu = deferred<Parameters<typeof import("./ChatHeader.tsx").BranchMenu>[0]>(() =>
  import("./ChatHeader.tsx").then((m) => ({ default: m.BranchMenu }))
)
const Composer = lazy(() => import("./Composer.tsx").then((m) => ({ default: m.Composer })))
const Summary = lazy(() => import("./TimelineSummary.tsx").then((m) => ({ default: m.TimelineSummary })))
const RolesSetting = lazy(() => import("./ThisChatTab.tsx").then((m) => ({ default: m.RolesSetting })))
const SummariesSetting = lazy(() => import("./ThisChatTab.tsx").then((m) => ({ default: m.SummariesSetting })))

export const registerPresentation = () => [
  ...registerTimelineTransforms(),
  chatBranchControls.register({ id: "chat.branches", order: 10, component: BranchMenu }),
  messagePreviews.register({ id: "history.message-preview", order: 10, component: HistoryMessagePreview }),
  summaryPreviews.register({ id: "history.summary-preview", order: 10, component: HistorySummaryPreview }),
  accountSettingSections.register({ id: "settings.summary-defaults", order: 10, component: SummaryDefaults }),
  chatComposerNotes.register({
    id: "composer.assembly-error",
    order: 5,
    component: ({ view }) =>
      view.history?.assemblyError ? (
        <Alert tone="danger" title="Can't prepare the next reply">
          {view.history.assemblyError}
        </Alert>
      ) : null
  }),
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
  chatNoteActions.register({ id: "note.author-note", order: 10, component: AuthorNoteAction }),
  chatCardActions.register({ id: "card.fork-for-chat", order: 20, component: ForkChatCard }),
  chatCardActions.register({ id: "card.choose-version", order: 30, component: ChooseChatCard }),
  chatSettingSections.register({
    id: "settings.summaries",
    order: 10,
    component: (props) => (
      <Suspense fallback={null}>
        <SummariesSetting {...props} />
      </Suspense>
    )
  }),
  chatSettingSections.register({ id: "settings.macro-bindings", order: 5, component: MacroBindings }),
  chatSettingSections.register({
    id: "settings.roles",
    order: 20,
    component: (props) => (
      <Suspense fallback={null}>
        <RolesSetting {...props} />
      </Suspense>
    )
  }),
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
    component: ({ children, cast, onOpenPanel }) => (
      <PortraitProvider
        onOpen={(id) => onOpenPanel("portrait", id)}
        faces={[...cast.cards.values()].map((card) => ({
          id: card.entityId,
          name: card.name,
          mediaId: card.avatarMediaId
        }))}
      >
        {children}
      </PortraitProvider>
    )
  }),
  chatOverlays.register({ id: "chat.preset-overlay", order: 10, component: () => <PresetOverlayHost /> }),
  ...registerImages()
]

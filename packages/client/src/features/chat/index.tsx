import { SINGLE_PORTRAIT_PARAM } from "../../ui/Portrait.tsx"
import { CAST_BROWSE_PARAMS } from "../characters/cardBrowse.tsx"
import { tabKinds } from "../workbench/kinds.ts"
import { registerChatHeader } from "./headerContributions.tsx"
import { registerSummaryDetails } from "./SummaryDetails.tsx"
import { registerEditorHistory } from "./editorHistory.tsx"
import { registerDisplay } from "./registerDisplay.tsx"
import { registerPresentation } from "./registerPresentation.tsx"
import { registerComposerControls } from "./registerComposerControls.tsx"
import { registerMessageActions } from "./registerMessageActions.tsx"
import { registerMessageSelection } from "./selection/register.tsx"
import { registerCompositionActions } from "./compositionActions.tsx"
import { registerRewrites } from "./rewrites.tsx"
import { registerGuidanceEdit } from "./guidanceEdit.tsx"
import { registerReasoningActions } from "./reasoningActions.tsx"
import { registerEditThinking } from "./editThinking.tsx"
import { registerReasoningPanels } from "./Reasoning.tsx"
import { registerAgent } from "./agent/register.tsx"
import { registerVersionMetrics } from "./versionMetrics.tsx"
import { registerMessageDetails } from "./messageDetails.tsx"
import { registerModelMarks } from "./modelMarks.tsx"
import { registerReplyCommands } from "./replyCommands.ts"
import { registerHistoryCommands } from "./historyContributions.ts"
import { registerPanels } from "./registerPanels.tsx"
import { createElement, lazy, Suspense, useState } from "react"
import { loadChatPage, loadedChatPage } from "./chatPageLoader.ts"
import { FIRST_REQUEST_PATH, firstRequestKey } from "./firstRequest.ts"
import { routes } from "../../routes.tsx"
import { Loading, reloadPage } from "../../ui/Spinner.tsx"
import { ChatDefaultsPage } from "./ChatDefaults.tsx"
import { chatStartSections, ChatsPage, EmptyChatCard } from "./ChatsPage.tsx"
import { ChatSkeleton } from "./SkeletonMessages.tsx"
import { PICTURE_PATH, PicturePage } from "./PicturePage.tsx"
import { sidebarSearch } from "../characters/sidebarSearch.ts"
import { layoutParams, viewParams } from "../../tabLayoutParams.ts"
import { CAST_ADD_PARAM } from "./castAddState.ts"
import { CHAT_VIEW_PARAMS } from "./chatViewParams.ts"

// The chat view carries the Markdown renderer, most of the bundle: it loads with the first chat opened.
const ChatPage = lazy(loadChatPage)
const StartChatPage = lazy(() => import("./StartChatPage.tsx").then((module) => ({ default: module.StartChatPage })))
const RemoteStartChatPage = lazy(() =>
  import("./StartChatPage.tsx").then((module) => ({ default: module.RemoteStartChatPage }))
)
const StartEmptyChatPage = lazy(() =>
  import("./StartChatPage.tsx").then((module) => ({ default: module.StartEmptyChatPage }))
)
const StartGroupChatPage = lazy(() =>
  import("./StartChatPage.tsx").then((module) => ({ default: module.StartGroupChatPage }))
)
const ContextPage = lazy(() => import("./ContextPage.tsx").then((module) => ({ default: module.ContextPage })))

function LazyChatPage() {
  // Loaded ahead (a pending chat does, chatPageLoader.ts): no fallback to show.
  const [Page] = useState(() => loadedChatPage() ?? ChatPage)
  return <Suspense fallback={<ChatSkeleton onRetry={reloadPage} />}>{createElement(Page)}</Suspense>
}

const FirstRequestPage = lazy(() =>
  import("./FirstRequestPage.tsx").then((module) => ({ default: module.FirstRequestPage }))
)

function LazyFirstRequestPage() {
  return (
    <Suspense fallback={<Loading label="Loading the request…" onRetry={reloadPage} />}>
      <FirstRequestPage />
    </Suspense>
  )
}

const SummaryTextPage = lazy(() => import("./textTabs.tsx").then((module) => ({ default: module.SummaryTextPage })))
const InstructionTabPage = lazy(() =>
  import("./textTabs.tsx").then((module) => ({ default: module.InstructionTabPage }))
)

function LazySummaryTextPage() {
  return (
    <Suspense fallback={<Loading label="Opening the summary…" onRetry={reloadPage} />}>
      <SummaryTextPage />
    </Suspense>
  )
}

function LazyInstructionTabPage() {
  return (
    <Suspense fallback={<Loading label="Opening the instruction…" onRetry={reloadPage} />}>
      <InstructionTabPage />
    </Suspense>
  )
}

function LazyContextPage() {
  return (
    <Suspense fallback={<Loading label="Loading the context…" onRetry={reloadPage} />}>
      <ContextPage />
    </Suspense>
  )
}

function LazyStartGroupChatPage() {
  return (
    <Suspense fallback={<Loading label="Loading the group…" onRetry={reloadPage} />}>
      <StartGroupChatPage />
    </Suspense>
  )
}

function LazyStartEmptyChatPage() {
  return (
    <Suspense fallback={<Loading label="Loading…" onRetry={reloadPage} />}>
      <StartEmptyChatPage />
    </Suspense>
  )
}

function LazyStartChatPage() {
  return (
    <Suspense fallback={<Loading label="Loading the card…" onRetry={reloadPage} />}>
      <StartChatPage />
    </Suspense>
  )
}

function LazyRemoteStartChatPage() {
  return (
    <Suspense fallback={<Loading label="Loading the card…" onRetry={reloadPage} />}>
      <RemoteStartChatPage />
    </Suspense>
  )
}

export const register = () => {
  registerSummaryDetails()
  registerEditorHistory()
  registerDisplay()
  registerPresentation()
  registerComposerControls()
  registerMessageActions()
  registerMessageSelection()
  registerCompositionActions()
  registerRewrites()
  registerGuidanceEdit()
  registerReasoningActions()
  registerEditThinking()
  registerReasoningPanels()
  registerAgent()
  registerMessageDetails()
  registerModelMarks()
  registerVersionMetrics()
  registerPanels()
  registerHistoryCommands()
  registerChatHeader()
  registerReplyCommands()
  // The Chats page's first start card; the workshop adds the second (features/workshop).
  // The Cast tab's Add characters section, open or not: the browser tab's layout.
  layoutParams.register({ id: "chats.cast-add", keys: [CAST_ADD_PARAM] })
  layoutParams.register({ id: "chats.single-portrait", keys: [SINGLE_PORTRAIT_PARAM] })
  layoutParams.register({ id: "chats.cast-browse", keys: Object.values(CAST_BROWSE_PARAMS) })
  // A pane's Messages or Summaries and its coverage rail: written as a chat opens, never a move.
  viewParams.register({ id: "chats.view", keys: CHAT_VIEW_PARAMS })
  chatStartSections.register({ id: "chats.start-empty", order: 10, component: EmptyChatCard })
  // One tab per chat (features/workbench): its branches and messages are places within it.
  tabKinds.register({
    id: "chat",
    order: 100,
    match: (url) => /^\/chats\/([^/]+)$/.exec(url.pathname)?.[1] ?? null,
    title: () => "Chat",
    icon: "chat",
    document: true
  })
  // The request inspector: a reply's, or the first of a chat not sent yet (`/request/first`, one
  // per pending chat's tab). It opens where an inspector is showing (owner, 2026-11-23), so the
  // chat keeps its frame while the requests take turns beside it.
  tabKinds.register({
    id: "chat.context",
    order: 100,
    match: (url) =>
      /^\/chats\/([^/]+\/context\/[^/]+)$/.exec(url.pathname)?.[1] ??
      (url.pathname === FIRST_REQUEST_PATH ? firstRequestKey(url) : null),
    title: () => "Request",
    icon: "search",
    opensWhereShown: true
  })
  tabKinds.register({
    id: "chat.start",
    order: 100,
    match: (url) =>
      /^\/(?:cards\/[^/]+\/chat|groups\/[^/]+\/new|sources\/[^/]+\/cards\/[^/]+\/chat|new\/chat)$/.exec(
        url.pathname
      )?.[0] ?? null,
    title: () => "New chat",
    icon: "chat",
    document: true
  })
  // A picture opened as a tab (dragged from the portrait column): one tab per image and cutout.
  tabKinds.register({
    id: "picture",
    order: 100,
    match: (url) =>
      url.pathname === PICTURE_PATH
        ? `${url.searchParams.get("media") ?? ""}:${url.searchParams.get("crop") ?? ""}`
        : null,
    title: (url) => url.searchParams.get("name") || "Picture",
    icon: "image"
  })
  routes.register({ id: "picture", parent: "app", path: PICTURE_PATH, component: PicturePage, fill: true })
  routes.register({
    id: "chats",
    parent: "app",
    path: "/chats",
    component: ChatsPage,
    nav: { label: "Chats", order: 5 }
  })
  // The left panel's place stays while moving around a chat (characters/sidebarSearch.ts).
  routes.register({
    id: "chat",
    parent: "app",
    path: "/chats/$chatId",
    component: LazyChatPage,
    fill: true,
    retainSearch: sidebarSearch
  })
  // The request inspector: the context a reply was generated from (DESIGN §7.4).
  routes.register({
    id: "chat.context",
    parent: "app",
    path: "/chats/$chatId/context/$versionId",
    component: LazyContextPage,
    retainSearch: sidebarSearch
  })
  // A chat's own texts in tabs of their own (editor/fieldTab.ts; the kind is the field tabs'): a
  // summary's text and the chat's summarization instruction, each box filling its tab.
  routes.register({
    id: "chat.summary-text",
    parent: "app",
    path: "/chats/$chatId/summaries/$summaryId/text",
    component: LazySummaryTextPage,
    fillBelowHeader: true
  })
  routes.register({
    id: "chat.instruction",
    parent: "app",
    path: "/chats/$chatId/instruction",
    component: LazyInstructionTabPage,
    fillBelowHeader: true
  })
  // The first request of a chat not sent yet (DESIGN §2.1), as its pending chat's view builds it.
  routes.register({
    id: "chat.first-request",
    parent: "app",
    path: FIRST_REQUEST_PATH,
    component: LazyFirstRequestPage,
    retainSearch: sidebarSearch
  })
  // What applies to all of the user's chats.
  routes.register({
    id: "settings.chats",
    parent: "settings",
    path: "chats",
    component: ChatDefaultsPage,
    nav: {
      label: "Chats",
      order: 15,
      description: "What every chat starts from: the model, the preset, the refusal judge and summaries."
    }
  })
  // A chat with a card, before it exists (DESIGN §2.1).
  routes.register({
    id: "chat.start",
    parent: "app",
    path: "/cards/$entityId/chat",
    component: LazyStartChatPage,
    fill: true,
    retainSearch: sidebarSearch
  })
  // A card on a card source, the same way (spec/CARD-SOURCES.md §4.2): adding it is the first send's.
  routes.register({
    id: "chat.startRemote",
    parent: "app",
    path: "/sources/$sourceId/cards/$remoteId/chat",
    component: LazyRemoteStartChatPage,
    fill: true,
    retainSearch: sidebarSearch
  })
  // A chat with nobody in it yet (the Chats page's New chat), the same way: made by its first send.
  routes.register({
    id: "chat.startEmpty",
    parent: "app",
    path: "/new/chat",
    component: LazyStartEmptyChatPage,
    fill: true,
    retainSearch: sidebarSearch
  })
  routes.register({
    id: "chat.startGroup",
    parent: "app",
    path: "/groups/$chatId/new",
    component: LazyStartGroupChatPage,
    fill: true,
    retainSearch: sidebarSearch
  })
}

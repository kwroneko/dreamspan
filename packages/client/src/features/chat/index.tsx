import { tabKinds } from "../workbench/kinds.ts"
import { registerChatHeader } from "./headerContributions.tsx"
import { registerSummaryDetails } from "./SummaryDetails.tsx"
import { registerEditorHistory } from "./editorHistory.tsx"
import { registerDisplay } from "./registerDisplay.tsx"
import { registerPresentation } from "./registerPresentation.tsx"
import { registerComposerControls } from "./registerComposerControls.tsx"
import { registerMessageActions } from "./registerMessageActions.tsx"
import { registerCompositionActions } from "./compositionActions.tsx"
import { registerRewrites } from "./rewrites.tsx"
import { registerGuidanceEdit } from "./guidanceEdit.tsx"
import { registerReasoningActions } from "./reasoningActions.tsx"
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
import { routes } from "../../routes.tsx"
import { Loading, reloadPage } from "../../ui/Spinner.tsx"
import { ChatDefaultsPage } from "./ChatDefaults.tsx"
import { ChatsPage } from "./ChatsPage.tsx"
import { ChatSkeleton } from "./SkeletonMessages.tsx"
import { sidebarSearch } from "../characters/sidebarSearch.ts"

// The chat view carries the Markdown renderer, most of the bundle: it loads with the first chat opened.
const ChatPage = lazy(loadChatPage)
const StartChatPage = lazy(() => import("./StartChatPage.tsx").then((module) => ({ default: module.StartChatPage })))
const StartGroupChatPage = lazy(() =>
  import("./StartChatPage.tsx").then((module) => ({ default: module.StartGroupChatPage }))
)
const ContextPage = lazy(() => import("./ContextPage.tsx").then((module) => ({ default: module.ContextPage })))

function LazyChatPage() {
  // Loaded ahead (a pending chat does, chatPageLoader.ts): no fallback to show.
  const [Page] = useState(() => loadedChatPage() ?? ChatPage)
  return <Suspense fallback={<ChatSkeleton onRetry={reloadPage} />}>{createElement(Page)}</Suspense>
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

function LazyStartChatPage() {
  return (
    <Suspense fallback={<Loading label="Loading the card…" onRetry={reloadPage} />}>
      <StartChatPage />
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
  registerCompositionActions()
  registerRewrites()
  registerGuidanceEdit()
  registerReasoningActions()
  registerReasoningPanels()
  registerAgent()
  registerMessageDetails()
  registerModelMarks()
  registerVersionMetrics()
  registerPanels()
  registerHistoryCommands()
  registerChatHeader()
  registerReplyCommands()
  // One tab per chat (features/workbench): its branches and messages are places within it.
  tabKinds.register({
    id: "chat",
    order: 100,
    match: (url) => /^\/chats\/([^/]+)$/.exec(url.pathname)?.[1] ?? null,
    title: () => "Chat",
    icon: "chat",
    document: true
  })
  tabKinds.register({
    id: "chat.context",
    order: 100,
    match: (url) => /^\/chats\/([^/]+\/context\/[^/]+)$/.exec(url.pathname)?.[1] ?? null,
    title: () => "Request",
    icon: "search"
  })
  tabKinds.register({
    id: "chat.start",
    order: 100,
    match: (url) => /^\/(?:cards\/[^/]+\/chat|groups\/[^/]+\/new)$/.exec(url.pathname)?.[0] ?? null,
    title: () => "New chat",
    icon: "chat",
    document: true
  })
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
    retainSearch: sidebarSearch
  })
  routes.register({
    id: "chat.startGroup",
    parent: "app",
    path: "/groups/$chatId/new",
    component: LazyStartGroupChatPage,
    retainSearch: sidebarSearch
  })
}

import { lazy, Suspense } from "react"
import { routes } from "../../routes.tsx"
import { Loading } from "../../ui/Spinner.tsx"
import { ChatsPage } from "./ChatsPage.tsx"

// The chat view carries the Markdown renderer, most of the bundle: it loads with the first chat opened.
const ChatPage = lazy(() => import("./ChatPage.tsx").then((module) => ({ default: module.ChatPage })))
const StartChatPage = lazy(() => import("./StartChatPage.tsx").then((module) => ({ default: module.StartChatPage })))
const ContextPage = lazy(() => import("./ContextPage.tsx").then((module) => ({ default: module.ContextPage })))

function LazyChatPage() {
  return (
    <Suspense fallback={<Loading label="Loading the chat…" />}>
      <ChatPage />
    </Suspense>
  )
}

function LazyContextPage() {
  return (
    <Suspense fallback={<Loading label="Loading the context…" />}>
      <ContextPage />
    </Suspense>
  )
}

function LazyStartChatPage() {
  return (
    <Suspense fallback={<Loading label="Loading the card…" />}>
      <StartChatPage />
    </Suspense>
  )
}

export const register = () => {
  routes.register({
    id: "chats",
    parent: "app",
    path: "/chats",
    component: ChatsPage,
    nav: { label: "Chats", order: 5 }
  })
  routes.register({ id: "chat", parent: "app", path: "/chats/$chatId", component: LazyChatPage })
  // The request inspector: the context a reply was generated from (DESIGN §7.4).
  routes.register({
    id: "chat.context",
    parent: "app",
    path: "/chats/$chatId/context/$versionId",
    component: LazyContextPage
  })
  // A chat with a card, before it exists (DESIGN §2.1).
  routes.register({ id: "chat.start", parent: "app", path: "/cards/$entityId/chat", component: LazyStartChatPage })
}

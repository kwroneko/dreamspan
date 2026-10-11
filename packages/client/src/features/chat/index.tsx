import { lazy, Suspense } from "react"
import { routes } from "../../routes.tsx"
import { Loading } from "../../ui/Spinner.tsx"
import { ChatsPage } from "./ChatsPage.tsx"

// The chat view carries the Markdown renderer, most of the bundle: it loads with the first chat opened.
const ChatPage = lazy(() => import("./ChatPage.tsx").then((module) => ({ default: module.ChatPage })))

function LazyChatPage() {
  return (
    <Suspense fallback={<Loading label="Loading the chat…" />}>
      <ChatPage />
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
}

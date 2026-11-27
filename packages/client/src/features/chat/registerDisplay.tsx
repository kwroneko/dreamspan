import { userNoticeReceivers } from "../noticeContributions.tsx"
import { displayNoticeReceiver } from "../../ui/viewPrefs.ts"
import { ExternalMediaProvider } from "./externalMedia.tsx"
import { Navigate } from "@tanstack/react-router"
import { routes } from "../../routes.tsx"
import { lazy } from "react"
import { messageRenderers } from "../../ui/Markdown.tsx"
import { registerEditCaret } from "../../ui/editCaret.ts"
import { registerMessageCopy } from "../../ui/messageCopy.tsx"
import { CardHeader } from "../../ui/Surface.tsx"
import { appTools, useTitle } from "../shell.tsx"
import { ChatWidthPreference } from "./ChatWidth.tsx"
import { MessageColorPreferences } from "./MessageColors.tsx"
import { MessageToolbarPreferences } from "./MessageToolbarPreferences.tsx"
const StMarkdown = lazy(() => import("../../ui/StMarkdown.tsx").then((module) => ({ default: module.StMarkdown })))
import { displayTransforms, macroDisplay } from "./displayPipeline.ts"
import { macroDisplayPart, regexDisplayPart } from "./displayParts.ts"
import { regexDisplay } from "./displayWorker.ts"
import { builtinDisplayScriptLists, displayScriptLists } from "./displayScripts.ts"
import { chatPanels } from "./panels.tsx"
import { chatSurfaceProviders } from "./presentation.tsx"
import { DisplayProvider, DisplaySettings } from "./DisplaySettings.tsx"
import { HtmlProvider } from "./htmlDisplay.tsx"
import { registerHtmlParts } from "../../ui/html/register.ts"

/** The settings page: the panel's settings under the page's title (the chat panel has its own). */
function InterfacePage() {
  useTitle("Interface")
  return (
    <>
      <CardHeader center title="Interface" />
      <DisplaySettings />
    </>
  )
}

export const registerDisplay = () => [
  registerMessageCopy(),
  userNoticeReceivers.register(displayNoticeReceiver),
  // Where a double-click opens the message's edit (ui/editCaret.ts).
  ...registerEditCaret(),
  routes.register({
    id: "settings.display",
    parent: "settings",
    path: "interface",
    component: InterfacePage,
    nav: {
      label: "Interface",
      order: 20,
      description: "How chats look and send: their width, what Enter does, and how messages show."
    }
  }),
  routes.register({
    id: "settings.display-legacy",
    parent: "settings",
    path: "display",
    component: () => <Navigate to="/settings/interface" search={(prev: Record<string, unknown>) => prev} replace />
  }),
  messageRenderers.register({ id: "markdown", order: 0, component: StMarkdown }),
  // HTML in messages (ui/html/parts.ts): the inline schema and the document-block classifier.
  ...registerHtmlParts(),
  appTools.register({ id: "display.message-colors", order: 0, component: MessageColorPreferences }),
  appTools.register({ id: "display.chat-width", order: 0, component: ChatWidthPreference }),
  // Which message actions show as buttons, from the account (messageActions.tsx).
  appTools.register({ id: "display.message-toolbar", order: 0, component: MessageToolbarPreferences }),
  displayTransforms.register({ ...macroDisplayPart, transform: macroDisplay }),
  displayTransforms.register({ ...regexDisplayPart, transform: regexDisplay }),
  ...builtinDisplayScriptLists.map((list) => displayScriptLists.register(list)),
  chatSurfaceProviders.register({ id: "display.context", order: 15, component: DisplayProvider }),
  chatSurfaceProviders.register({ id: "display.external-media", order: 17, component: ExternalMediaProvider }),
  chatSurfaceProviders.register({ id: "display.html", order: 16, component: HtmlProvider }),
  chatPanels.register({
    id: "interface",
    matches: (value) => value === "interface" || value === "display",
    label: "Display",
    description: "Change how chats look and send, including colours and what Enter does.",
    order: 85,
    icon: "type",
    component: ({ view }) => (
      <DisplaySettings
        chatId={view.chat?.status === "pending" ? undefined : view.chat?.id}
        scene={view.cast?.background}
      />
    ),
    pending: () => <DisplaySettings />
  })
]

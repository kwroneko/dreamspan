import { Navigate } from "@tanstack/react-router"
import { routes } from "../../routes.tsx"
import { lazy } from "react"
import { messageRenderers } from "../../ui/Markdown.tsx"
import { registerMessageCopy } from "../../ui/messageCopy.tsx"
import { appTools } from "../shell.tsx"
import { ChatWidthPreference } from "./ChatWidth.tsx"
import { MessageColorPreferences } from "./MessageColors.tsx"
import { MessageToolbarPreferences } from "./MessageToolbarPreferences.tsx"
const StMarkdown = lazy(() => import("../../ui/StMarkdown.tsx").then((module) => ({ default: module.StMarkdown })))
import { displayTransforms, macroDisplay } from "./displayPipeline.ts"
import { regexDisplay } from "./displayWorker.ts"
import { builtinDisplayScriptLists, displayScriptLists } from "./displayScripts.ts"
import { chatPanels } from "./panels.tsx"
import { chatSurfaceProviders } from "./presentation.tsx"
import { DisplayProvider, DisplaySettings } from "./DisplaySettings.tsx"

export const registerDisplay = () => [
  registerMessageCopy(),
  routes.register({
    id: "settings.display",
    parent: "settings",
    path: "interface",
    component: DisplaySettings,
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
  appTools.register({ id: "display.message-colors", order: 0, component: MessageColorPreferences }),
  appTools.register({ id: "display.chat-width", order: 0, component: ChatWidthPreference }),
  // Which message actions show as buttons, from the account (messageActions.tsx).
  appTools.register({ id: "display.message-toolbar", order: 0, component: MessageToolbarPreferences }),
  displayTransforms.register({ id: "display.macros", order: 10, transform: macroDisplay }),
  displayTransforms.register({ id: "display.regex", order: 20, transform: regexDisplay }),
  ...builtinDisplayScriptLists.map((list) => displayScriptLists.register(list)),
  chatSurfaceProviders.register({ id: "display.context", order: 15, component: DisplayProvider }),
  chatPanels.register({
    id: "interface",
    matches: (value) => value === "interface" || value === "display",
    label: "Interface",
    description: "Change how chats look and send, including colours and what Enter does.",
    order: 85,
    icon: "type",
    component: DisplaySettings,
    // The account's, so the same before the first send.
    pending: DisplaySettings
  })
]

import { routes } from "../../routes.tsx"
import { lazy } from "react"
import { messageRenderers } from "../../ui/Markdown.tsx"
import { registerMessageCopy } from "../../ui/messageCopy.tsx"
import { appTools } from "../shell.tsx"
import { MessageColorPreferences } from "./MessageColors.tsx"
const StMarkdown = lazy(() => import("../../ui/StMarkdown.tsx").then((module) => ({ default: module.StMarkdown })))
import { displayTransforms, macroDisplay } from "./displayPipeline.ts"
import { regexDisplay } from "./displayWorker.ts"
import { chatPanels } from "./panels.tsx"
import { chatSurfaceProviders } from "./presentation.tsx"
import { DisplayProvider, DisplaySettings } from "./DisplaySettings.tsx"

export const registerDisplay = () => [
  registerMessageCopy(),
  routes.register({
    id: "settings.display",
    parent: "settings",
    path: "display",
    component: DisplaySettings,
    nav: { label: "Display", order: 20 }
  }),
  messageRenderers.register({ id: "markdown", order: 0, component: StMarkdown }),
  appTools.register({ id: "display.message-colors", order: 0, component: MessageColorPreferences }),
  displayTransforms.register({ id: "display.macros", order: 10, transform: macroDisplay }),
  displayTransforms.register({ id: "display.regex", order: 20, transform: regexDisplay }),
  chatSurfaceProviders.register({ id: "display.context", order: 15, component: DisplayProvider }),
  chatPanels.register({ id: "display", label: "Display", order: 85, icon: "sliders", component: DisplaySettings })
]

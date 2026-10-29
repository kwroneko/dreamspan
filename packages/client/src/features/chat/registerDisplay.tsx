import { displayTransforms, macroDisplay } from "./displayPipeline.ts"
import { regexDisplay } from "./displayWorker.ts"
import { chatPanels } from "./panels.tsx"
import { chatSurfaceProviders } from "./presentation.tsx"
import { DisplayProvider, DisplaySettings } from "./DisplaySettings.tsx"

export const registerDisplay = () => [
  displayTransforms.register({ id: "display.macros", order: 10, transform: macroDisplay }),
  displayTransforms.register({ id: "display.preset-regex", order: 20, transform: regexDisplay }),
  chatSurfaceProviders.register({ id: "display.context", order: 15, component: DisplayProvider }),
  chatPanels.register({ id: "display", label: "Display", order: 85, icon: "sliders", component: DisplaySettings })
]

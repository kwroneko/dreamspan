import "./styles.css"
import { React } from "./pluginHost.ts"
import { startClientPlugins } from "./plugins.tsx"
import { RegistryProvider } from "@effect/atom-react"
import { RouterProvider } from "@tanstack/react-router"
import { createRoot } from "react-dom/client"
import { registerFeatures } from "./features/index.ts"
import { buildRouter } from "./routes.tsx"
import { CspProvider } from "./ui/CspProvider.tsx"

import { applyImagePrefs } from "./ui/imagePrefs.ts"

applyImagePrefs()
registerFeatures()
await startClientPlugins()
const router = buildRouter()

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <CspProvider>
      <RegistryProvider>
        <RouterProvider router={router} />
      </RegistryProvider>
    </CspProvider>
  </React.StrictMode>
)

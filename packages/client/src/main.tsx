import "./styles.css"
import { RegistryProvider } from "@effect/atom-react"
import { RouterProvider } from "@tanstack/react-router"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { registerFeatures } from "./features/index.ts"
import { buildRouter } from "./routes.tsx"
import { CspProvider } from "./ui/CspProvider.tsx"

import { applyImagePrefs } from "./ui/imagePrefs.ts"

applyImagePrefs()
registerFeatures()
const router = buildRouter()

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <CspProvider>
      <RegistryProvider>
        <RouterProvider router={router} />
      </RegistryProvider>
    </CspProvider>
  </StrictMode>
)

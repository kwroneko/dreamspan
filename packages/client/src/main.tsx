import "./styles.css"
import { RegistryProvider } from "@effect/atom-react"
import { RouterProvider } from "@tanstack/react-router"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { registerFeatures } from "./features/index.ts"
import { buildRouter } from "./routes.tsx"

registerFeatures()
const router = buildRouter()

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RegistryProvider>
      <RouterProvider router={router} />
    </RegistryProvider>
  </StrictMode>
)

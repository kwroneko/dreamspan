import "./perf.ts"
import "./styles.css"
import { RegistryProvider } from "@effect/atom-react"
import { createRoot } from "react-dom/client"
import { App } from "./App.tsx"

const mode = new URLSearchParams(location.search).get("store") === "plain" ? "plain" : "atom"

createRoot(document.getElementById("root")!).render(
  <RegistryProvider>
    <App mode={mode} />
  </RegistryProvider>
)

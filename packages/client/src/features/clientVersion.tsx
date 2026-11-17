import { useEffect } from "react"
import { checkBuild, installStaleBuildWatch, ReloadButton, useStaleBuild } from "../staleBuild.tsx"
import { appBanners } from "./shell.tsx"

/**
 * The app-wide notice that the server now serves a newer build (staleBuild.tsx). Checked on
 * start, every 30 s, when the tab regains focus, comes online or the socket reconnects, and
 * whenever a lazy chunk fails to load.
 */
function ClientVersion() {
  const stale = useStaleBuild()
  useEffect(() => {
    if (import.meta.env.VITE_BUILD_ID === "development") return
    const check = () => void checkBuild()
    check()
    const timer = setInterval(check, 30_000)
    const visible = () => {
      if (document.visibilityState === "visible") check()
    }
    window.addEventListener("rp:connected", check)
    window.addEventListener("online", check)
    window.addEventListener("focus", check)
    document.addEventListener("visibilitychange", visible)
    return () => {
      clearInterval(timer)
      window.removeEventListener("rp:connected", check)
      window.removeEventListener("online", check)
      window.removeEventListener("focus", check)
      document.removeEventListener("visibilitychange", visible)
    }
  }, [])
  if (!stale) return null
  return (
    <div
      id="client-version-notice"
      role="status"
      aria-label="App updated"
      className="flex flex-wrap items-center gap-3 border-b border-border bg-surface-raised px-4 py-2 text-sm"
    >
      <span>The app was updated. Reload to continue.</span>
      <ReloadButton />
    </div>
  )
}

export const register = () => {
  installStaleBuildWatch()
  appBanners.register({ id: "client.version", order: 10, component: ClientVersion })
}

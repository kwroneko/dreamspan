import { useEffect, useState } from "react"
import { Button } from "../ui/Button.tsx"
import { flushOpenEditors } from "./editor/openEditors.ts"
import { appBanners } from "./shell.tsx"

function ClientVersion() {
  const [available, setAvailable] = useState(false)
  const [reloading, setReloading] = useState(false)
  useEffect(() => {
    if (import.meta.env.VITE_BUILD_ID === "development") return
    let active = true
    let pending = false
    const check = async () => {
      if (pending) return
      pending = true
      try {
        const response = await fetch("/healthz", { cache: "no-store", signal: AbortSignal.timeout(5000) })
        const build = response.headers.get("x-client-build")
        if (active && response.ok && build && build !== import.meta.env.VITE_BUILD_ID) setAvailable(true)
      } catch {
        /* A disconnected server keeps the existing notice and draft. */
      } finally {
        pending = false
      }
    }
    void check()
    const timer = setInterval(check, 30_000)
    window.addEventListener("rp:connected", check)
    window.addEventListener("online", check)
    window.addEventListener("focus", check)
    return () => {
      active = false
      clearInterval(timer)
      window.removeEventListener("rp:connected", check)
      window.removeEventListener("online", check)
      window.removeEventListener("focus", check)
    }
  }, [])
  if (!available) return null
  return (
    <div
      id="client-version-notice"
      role="status"
      aria-label="New version"
      className="flex flex-wrap items-center gap-3 border-b border-border bg-surface-raised px-4 py-2 text-sm"
    >
      <span>A new version is available.</span>
      <Button
        hint="Reloads the app to use the new version."
        pending={reloading}
        onClick={async () => {
          setReloading(true)
          // Every keystroke already has a browser backup. Flush server drafts before navigating too.
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            await Promise.race([
              flushOpenEditors(),
              new Promise<void>((done) => {
                timer = setTimeout(done, 1500)
              })
            ])
          } catch {
            // The synchronous browser copy remains available when a server write fails.
          } finally {
            clearTimeout(timer)
            setReloading(false)
            window.location.reload()
          }
        }}
      >
        Reload
      </Button>
    </div>
  )
}

export const register = () => appBanners.register({ id: "client.version", order: 10, component: ClientVersion })

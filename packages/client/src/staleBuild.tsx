// A tab left open across a rebuild (dev redeploys on every merge, prod on each release) still
// runs the old build, whose lazy chunks the server no longer has. Every lazy chunk load goes
// through Vite's preload helper (`vite:preloadError`), and our boundaries report the import
// rejections they catch too. A failure is confirmed against the server's build id
// (`/healthz` x-client-build) so a real network outage still reads as one.
//
// Once confirmed: one app-wide notice (clientVersion.tsx) and "This part needs a reload" in
// each failed part. The tab reloads by itself once per server build, only when nothing typed
// is unsaved: editors report unsaved changes (openEditors.ts) and any non-empty text box
// counts too. Composer and editor text also has a per-keystroke browser backup, but a reload
// the user didn't ask for while they type is still not wanted.
import { useSyncExternalStore } from "react"
import { Button } from "./ui/Button.tsx"
import { flushOpenEditors, unsavedEditorRefs } from "./features/editor/openEditors.ts"

const OWN_BUILD: string = import.meta.env.VITE_BUILD_ID
const RELOADED_KEY = "rp:stale-build-reloaded"

let stale = false
const listeners = new Set<() => void>()
const markStale = () => {
  if (stale) return
  stale = true
  for (const listener of listeners) listener()
}

/** True once the server is known to serve a different build than this tab runs. */
export const isStaleBuild = () => stale
export const useStaleBuild = () =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => stale
  )

/** The messages browsers give for a dynamic import or preload that failed to load. */
export const isChunkLoadError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  return /dynamically imported module|Importing a module script failed|Unable to preload CSS|Failed to load module script|error loading dynamically imported module/i.test(
    message
  )
}

let checking: Promise<string | null> | null = null
/** The server's current build id, or null when it can't be asked (offline, dev). */
const serverBuild = () =>
  (checking ??= (async () => {
    try {
      const response = await fetch("/healthz", { cache: "no-store", signal: AbortSignal.timeout(5000) })
      return response.ok ? response.headers.get("x-client-build") : null
    } catch {
      return null
    } finally {
      checking = null
    }
  })())

/** Compares build ids; marks the tab stale when they differ. Returns the server's build. */
export const checkBuild = async () => {
  if (OWN_BUILD === "development") return null
  const build = await serverBuild()
  if (build && build !== OWN_BUILD) markStale()
  return build
}

const hasUnsavedText = () => {
  if (unsavedEditorRefs().length > 0) return true
  for (const element of document.querySelectorAll<HTMLElement>("textarea, [contenteditable='true'], input")) {
    if (element instanceof HTMLTextAreaElement && element.value.trim() !== "") return true
    if (
      element instanceof HTMLInputElement &&
      (element.type === "text" || element.type === "search" || element.type === "") &&
      element.value !== element.defaultValue
    )
      return true
    if (element.isContentEditable && (element.textContent ?? "").trim() !== "") return true
  }
  return false
}

const storage = () => {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

/** Reloads, after a short flush of open editors' server drafts. */
export const reloadApp = async () => {
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
    window.location.reload()
  }
}

/** A chunk failed to load: confirm a rebuild, then reload once if nothing is unsaved. */
export const reportChunkFailure = async (error?: unknown) => {
  if (error !== undefined && !isChunkLoadError(error)) return
  const build = await checkBuild()
  if (!stale || build === null || hasUnsavedText()) return
  const store = storage()
  try {
    if (store?.getItem(RELOADED_KEY) === build) return
    store?.setItem(RELOADED_KEY, build)
  } catch {
    return
  }
  window.location.reload()
}

let installed = false
/** Listens for Vite's preload failures; the error still reaches the part's boundary. */
export const installStaleBuildWatch = () => {
  if (installed) return
  installed = true
  window.addEventListener("vite:preloadError", (event) => {
    void reportChunkFailure(
      (event as Event & { payload?: unknown }).payload ?? new Error("dynamically imported module")
    )
  })
}

export function ReloadButton() {
  return (
    <Button
      hint="The app was updated while this tab was open. Reloading loads the new version; typed text is kept."
      onClick={() => void reloadApp()}
    >
      Reload
    </Button>
  )
}

/** Shown in place of a part whose code couldn't load because the app was rebuilt. */
export function StalePart() {
  return (
    <div className="flex flex-col items-start gap-2" data-stale-part>
      <p role="alert" className="text-sm">
        This part needs a reload.
      </p>
      <ReloadButton />
    </div>
  )
}

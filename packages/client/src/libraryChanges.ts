// Same-origin tabs carry invalidation signals only, never library content.
const channel =
  typeof window === "undefined" || typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("rp.library")
export const notifyLibraryChange = (keys: ReadonlyArray<string>) => {
  if (keys.includes("library")) channel?.postMessage("changed")
}
export const onLibraryChange = (refresh: () => void) => {
  channel?.addEventListener("message", refresh)
  window.addEventListener("focus", refresh)
  return () => {
    channel?.removeEventListener("message", refresh)
    window.removeEventListener("focus", refresh)
  }
}

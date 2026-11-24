// Same-origin tabs carry invalidation signals only, never library content.
const channel =
  typeof window === "undefined" || typeof BroadcastChannel === "undefined"
    ? null
    : new BroadcastChannel("dreamspan.library")
/** A change to drafts only (a discard, a revert): other tabs' editors read again, their lists needn't. */
const DRAFTS_ONLY = "entries"

/**
 * Told of every write this tab made (any reactivity keys), every change the server announced,
 * another tab's library or draft change and the window regaining focus: what may have deleted,
 * restored, saved or discarded an entry some editor here holds changes for (features/editor/store.ts).
 */
const anyChange = new Set<() => void>()
export const notifyEntriesChanged = () => {
  for (const listener of [...anyChange]) listener()
}
export const onEntriesChanged = (listener: () => void) => {
  anyChange.add(listener)
  if (typeof window === "undefined") return () => void anyChange.delete(listener)
  channel?.addEventListener("message", listener)
  window.addEventListener("focus", listener)
  return () => {
    anyChange.delete(listener)
    channel?.removeEventListener("message", listener)
    window.removeEventListener("focus", listener)
  }
}

/** `drafts`: the write changed drafts only, which other tabs hear of without reading their lists again. */
export const notifyLibraryChange = (keys: ReadonlyArray<string>) => {
  if (keys.includes("library") || keys.includes("globalRegex")) channel?.postMessage("changed")
  else if (keys.includes("drafts")) channel?.postMessage(DRAFTS_ONLY)
  if (keys.length > 0) notifyEntriesChanged()
}
export const onLibraryChange = (refresh: () => void) => {
  const message = (event: MessageEvent) => {
    if (event.data !== DRAFTS_ONLY) refresh()
  }
  channel?.addEventListener("message", message)
  window.addEventListener("focus", refresh)
  return () => {
    channel?.removeEventListener("message", message)
    window.removeEventListener("focus", refresh)
  }
}

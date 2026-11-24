// Same-origin tabs carry invalidation signals only, never library content.
const channel =
  typeof window === "undefined" || typeof BroadcastChannel === "undefined"
    ? null
    : new BroadcastChannel("dreamspan.library")

/**
 * Told of every write this tab made (any reactivity keys), every change the server announced,
 * another tab's library change and the window regaining focus: what may have deleted, restored,
 * saved or discarded an entry some editor here holds changes for (features/editor/store.ts).
 */
const anyChange = new Set<() => void>()
export const notifyEntriesChanged = () => {
  for (const listener of [...anyChange]) listener()
}
export const onEntriesChanged = (listener: () => void) => {
  anyChange.add(listener)
  const stop = typeof window === "undefined" ? () => {} : onLibraryChange(listener)
  return () => {
    anyChange.delete(listener)
    stop()
  }
}

export const notifyLibraryChange = (keys: ReadonlyArray<string>) => {
  if (keys.includes("library") || keys.includes("globalRegex")) channel?.postMessage("changed")
  if (keys.length > 0) notifyEntriesChanged()
}
export const onLibraryChange = (refresh: () => void) => {
  channel?.addEventListener("message", refresh)
  window.addEventListener("focus", refresh)
  return () => {
    channel?.removeEventListener("message", refresh)
    window.removeEventListener("focus", refresh)
  }
}

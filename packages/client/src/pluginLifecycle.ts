/** P3 applies successful local changes here; the host installs its tab's synchronizer. */
let apply: () => Promise<void> = async () => undefined
export const installPluginSync = (sync: () => Promise<void>) => {
  apply = sync
}
let changes: BroadcastChannel | undefined
/** Server notices cover devices; this also covers a local change before another tab subscribes. */
export const listenForPluginChanges = (check: () => void) => {
  changes?.close()
  changes = new BroadcastChannel("rp.plugins.changed")
  changes.onmessage = check
}
/** @public Applies a local plugin management result; consumed by external host users. */
export const syncClientPlugins = async () => {
  await apply()
  changes?.postMessage(null)
}

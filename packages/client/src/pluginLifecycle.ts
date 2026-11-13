/** P3 applies successful local changes here; the host installs its tab's synchronizer. */
let apply: () => Promise<void> = async () => undefined
export const installPluginSync = (sync: () => Promise<void>) => {
  apply = sync
}
/** @public Applies a local plugin management result; consumed by external host users. */
export const syncClientPlugins = () => apply()

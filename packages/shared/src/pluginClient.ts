/** API v1 surfaces with typed browser adapters; other client registries are not public yet. */
export const CLIENT_PLUGIN_SURFACES: ReadonlyArray<string> = ["composerControls", "chatPanels", "routes", "appBanners"]
export interface ClientPlugin {
  readonly scope: "instance" | "user"
  readonly id: string
  readonly commit: string
  readonly manifest: import("./plugins.ts").PluginManifest
}

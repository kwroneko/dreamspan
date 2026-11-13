// Shared with the future authoring consent workflow. Descriptions are information, not confinement.
import type { PluginManifest } from "./plugins.ts"

const surfaces: Readonly<Record<string, string>> = {
  "client:composerControls": "Adds controls beside your message.",
  "client:chatPanels": "Adds panels beside your chats.",
  "client:routes": "Adds pages to the app. Reload to use changed pages.",
  "client:appBanners": "Adds notices across the app.",
  "server:rolloutTools": "Adds or changes tools the assistant can use.",
  "server:operationTools": "Changes which app actions the assistant can use.",
  "server:workshopCapabilities": "Changes the kinds of work available in workshops.",
  "server:orchestrationModes": "Changes how replies are planned.",
  "server:replyStrategies": "Changes how replies are written.",
  "server:replyParsers": "Changes how model replies are read.",
  "server:liveRewrites": "Changes replies as they arrive.",
  "server:chatKinds": "Adds or changes kinds of chat.",
  "server:commands": "Adds or changes app actions.",
  "server:providerKinds": "Changes how the app connects to model providers.",
  "server:requestTransforms": "Changes requests sent to model providers.",
  "server:responseObservers": "Reads responses from model providers.",
  "server:costFormulas": "Changes how model costs are calculated.",
  "server:decisionPoints": "Changes when the assistant asks for a decision.",
  "server:storage": "Stores its own data on the server.",
  "worker:storage": "Stores its own data on the server.",
  "worker:stateKeys": "Adds saved settings to chats.",
  "worker:storageKinds": "Adds kinds of saved app data.",
  "worker:settingsRegistry": "Adds app settings.",
  "worker:stages": "Changes how context is prepared for the model.",
  "worker:macros": "Adds values that prompts can include.",
  "worker:projections": "Changes the roles of messages sent to the model.",
  "worker:transforms": "Changes context before it is sent.",
  "worker:leafPlanners": "Changes how older messages are selected for summaries.",
  "worker:maintenancePlanners": "Changes how summaries are maintained."
}
export const hasServerCode = (manifest: PluginManifest) =>
  Boolean(manifest.server || manifest.worker || manifest.overrides.length)
export const pluginSurfaces = (manifest: PluginManifest) => [
  ...new Set(manifest.surfaces.map((surface) => surfaces[surface] ?? "Changes an additional part of the app."))
]
export const pluginConsent = (manifest: PluginManifest, scope: "instance" | "user") => [
  hasServerCode(manifest)
    ? "Runs on the server with full access, including stored keys and every user's chats."
    : "Runs only in your browser. It can do anything you can do in the app.",
  ...pluginSurfaces(manifest),
  ...(manifest.replaces.length ? ["Replaces existing parts of the app."] : []),
  ...(hasServerCode(manifest) ? ["Can send data to other sites."] : []),
  ...(scope === "instance" ? ["Applies to every user of this app."] : [])
]

/** A previously enabled version still asks again when it would add declared access. */
export const pluginAccessGrows = (before: PluginManifest | null | undefined, after: PluginManifest) =>
  !before ||
  (hasServerCode(after) && !hasServerCode(before)) ||
  (after.network && !before.network) ||
  after.surfaces.some((value) => !before.surfaces.includes(value)) ||
  after.overrides.some((value) => !before.overrides.includes(value)) ||
  after.replaces.some((value) => !before.replaces.includes(value))

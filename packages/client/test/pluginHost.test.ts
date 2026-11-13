import { afterEach, expect, it, vi } from "vitest"
import type { ClientPlugin } from "@rp/shared/pluginClient.ts"
import { clientPluginHost, loadClientPlugin, pluginsOff, CLIENT_PLUGIN_TIMEOUT_MS } from "../src/plugins.tsx"
import { composerControls } from "../src/features/chat/composerControls.tsx"
import { chatPanels } from "../src/features/chat/panels.tsx"
import { routes } from "../src/routes.tsx"
import { appBanners } from "../src/features/shell.tsx"
const fixture = (id: string, surfaces = ["composerControls", "chatPanels", "routes", "appBanners"]): ClientPlugin => ({
  scope: "user",
  id,
  commit: "a".repeat(40),
  manifest: {
    id,
    name: id,
    api: 1,
    client: "client.tsx",
    server: null,
    worker: null,
    network: false,
    surfaces: surfaces.map((s) => `client:${s}`),
    overrides: [],
    replaces: [],
    base: null
  }
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
const dom = () => vi.stubGlobal("document", { activeElement: null, body: {}, querySelector: () => null })
it("maps only declared typed surfaces to the app's single registry instances and revokes them", () => {
  dom()
  const scope = clientPluginHost(fixture("adapter"))
  const reg = scope.host.registries
  reg.composerControls!.register({ id: "test.control", order: 4, placement: "tools", component: () => null })
  reg.chatPanels!.register({
    id: "test.panel",
    label: "Panel",
    description: "Synthetic panel",
    order: 3,
    component: () => null
  })
  reg.routes!.register({ id: "test.route", path: "/extensions/test", component: () => null })
  reg.appBanners!.register({ id: "test.banner", order: 2, component: () => null })
  expect(composerControls.get("test.control")?.placement).toBe("tools")
  expect(chatPanels.get("test.panel")).toMatchObject({ savedOnly: true, label: "Panel" })
  expect(routes.get("test.route")).toMatchObject({ parent: "app", path: "/extensions/test" })
  expect(appBanners.get("test.banner")).toBeDefined()
  scope.close()
  for (const [registry, id] of [
    [composerControls, "test.control"],
    [chatPanels, "test.panel"],
    [routes, "test.route"],
    [appBanners, "test.banner"]
  ] as const)
    expect(registry.get(id)).toBeUndefined()
  expect(() => reg.appBanners!.register({ id: "late", order: 1, component: () => null })).toThrow("off")
})
it("refuses undeclared, unsupported, cross-plugin and undeclared built-in replacement handles", () => {
  dom()
  const a = clientPluginHost(fixture("first", ["appBanners"]))
  const other = fixture("second", ["appBanners"])
  const b = clientPluginHost({ ...other, manifest: { ...other.manifest, replaces: ["appBanners:shared"] } })
  expect(a.host.registries.composerControls).toBeUndefined()
  a.host.registries.appBanners!.register({ id: "shared", order: 0, component: () => null })
  expect(a.host.registries.appBanners!.list().find((entry) => entry.id === "shared")).toEqual({ id: "shared" })
  expect("get" in a.host.registries.appBanners!).toBe(false)
  expect(() => b.host.registries.appBanners!.register({ id: "shared", order: 0, component: () => null })).toThrow(
    "owned"
  )
  expect(() => b.host.registries.appBanners!.disable("shared")).toThrow()
  expect(() => clientPluginHost(fixture("unsupported", ["messageActions"]))).toThrow("Unsupported")
  a.close()
  b.close()
})
it("disposes partial registration on activate throw and revokes never-resolving late activation after three seconds", async () => {
  dom()
  const p = fixture("broken", ["appBanners"])
  await loadClientPlugin(p, async () => ({
    activate: (host) => {
      host.registries.appBanners!.register({ id: "partial", order: 0, component: () => null })
      throw new Error("synthetic")
    }
  }))
  expect(appBanners.get("partial")).toBeUndefined()
  vi.useFakeTimers()
  let late: (() => void) | undefined
  const loading = loadClientPlugin(fixture("late", ["appBanners"]), async () => ({
    activate: (host) =>
      new Promise<void>(() => {
        late = () => {
          host.registries.appBanners!.register({ id: "too-late", order: 0, component: () => null })
        }
      })
  }))
  await vi.advanceTimersByTimeAsync(CLIENT_PLUGIN_TIMEOUT_MS)
  await loading
  expect(late).toBeDefined()
  expect(late).toThrow("off")
  expect(appBanners.get("too-late")).toBeUndefined()
})
it("takes recovery mode from the complete URL, including deep links", () => {
  expect(pluginsOff("/chats/synthetic?panel=model&plugins=off")).toBe(true)
  expect(pluginsOff("/chats/synthetic?panel=model")).toBe(false)
})

it("keeps host recovery registrations outside plugin replacements", () => {
  dom()
  const plugin = fixture("host-replacement", ["appBanners", "routes"])
  const scope = clientPluginHost({
    ...plugin,
    manifest: { ...plugin.manifest, replaces: ["appBanners:plugins.host", "routes:settings.plugins"] }
  })
  expect(() => scope.host.registries.appBanners!.disable("plugins.host")).toThrow("cannot be replaced")
  expect(() =>
    scope.host.registries.appBanners!.register({ id: "plugins.host", order: 0, component: () => null })
  ).toThrow("cannot be replaced")
  expect(() =>
    scope.host.registries.routes!.register({
      id: "settings.plugins",
      path: "/extensions/replacement",
      component: () => null
    })
  ).toThrow("cannot be replaced")
  scope.close()
})

it("captures registration ids so a caller's later edits cannot leave another entry claimed", () => {
  dom()
  const first = clientPluginHost(fixture("mutable-first", ["appBanners"]))
  const second = clientPluginHost(fixture("mutable-second", ["appBanners"]))
  const entry = { id: "original.entry", order: 0, component: () => null }
  const stop = first.host.registries.appBanners!.register(entry)
  entry.id = "edited.entry"
  stop()
  try {
    expect(() => second.host.registries.appBanners!.register({ ...entry, id: "original.entry" })).not.toThrow()
  } finally {
    first.close()
    second.close()
  }
})

it("rejects route URL collisions across different registration names", () => {
  dom()
  const a = clientPluginHost(fixture("url-first", ["routes"]))
  const b = clientPluginHost(fixture("url-second", ["routes"]))
  try {
    a.host.registries.routes!.register({ id: "url.first", path: "/extensions/same", component: () => null })
    expect(() =>
      b.host.registries.routes!.register({ id: "url.second", path: "/extensions/same", component: () => null })
    ).toThrow("already")
    for (const path of ["/extensions/same/", "/extensions//same", "/extensions/same//child"])
      expect(() => b.host.registries.routes!.register({ id: "url.noncanonical", path, component: () => null })).toThrow(
        "path"
      )
  } finally {
    a.close()
    b.close()
  }
})

it("refuses layout replacement through the extension-page adapter", () => {
  dom()
  const stop = routes.register({ id: "layout.fixture", parent: "root", component: () => null })
  const p = fixture("layout-replacement", ["routes"])
  const scope = clientPluginHost({ ...p, manifest: { ...p.manifest, replaces: ["routes:layout.fixture"] } })
  try {
    expect(() =>
      scope.host.registries.routes!.register({
        id: "layout.fixture",
        path: "/extensions/layout",
        component: () => null
      })
    ).toThrow("layout")
  } finally {
    scope.close()
    stop()
  }
})

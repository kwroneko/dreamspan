import { describe, expect, it } from "vitest"
import { PluginManifest } from "../src/plugins.ts"
import { pluginAccessGrows, pluginConsent, pluginSurfaces } from "../src/pluginConsent.ts"
import { Schema } from "effect"
const manifest = Schema.decodeUnknownSync(PluginManifest)({
  id: "synthetic",
  name: "Synthetic",
  api: 1,
  client: "client.tsx",
  server: null,
  worker: null,
  surfaces: ["client:composerControls", "client:chatPanels", "client:routes", "client:appBanners"],
  overrides: [],
  replaces: [],
  network: false,
  base: null
})
describe("plugin consent", () => {
  it("describes every supported client surface and its page authority", () => {
    expect(pluginSurfaces(manifest)).toEqual([
      "Adds controls beside your message.",
      "Adds panels beside your chats.",
      "Adds pages to the app. Reload to use changed pages.",
      "Adds notices across the app."
    ])
    expect(pluginConsent(manifest, "user")).toContain(
      "Runs only in your browser. It can do anything you can do in the app."
    )
    expect(pluginConsent(manifest, "user").join(" ")).not.toContain("every user")
  })
  for (const entry of ["server", "worker"] as const)
    it(`warns of full access and off-site data for ${entry}, even without the network handle`, () => {
      const text = pluginConsent({ ...manifest, [entry]: "server.ts" }, "instance")
      expect(text).toContain("Runs on the server with full access, including stored keys and every user's chats.")
      expect(text).toContain("Can send data to other sites.")
      expect(text).toContain("Applies to every user of this app.")
      expect(text.join(" ")).not.toContain("Runs only in your browser")
    })
  it("describes replacements and unknown surfaces without promising isolation", () => {
    expect(pluginConsent({ ...manifest, surfaces: ["future:part"], replaces: ["client:original"] }, "user")).toContain(
      "Replaces existing parts of the app."
    )
    expect(pluginSurfaces({ ...manifest, surfaces: ["future:part"] })).toEqual([
      "Changes an additional part of the app."
    ])
  })
})

it("asks again when an earlier enabled version adds access, but not when it removes it", () => {
  const server = { ...manifest, server: "server.ts" }
  expect(pluginAccessGrows(manifest, server)).toBe(true)
  expect(pluginAccessGrows(server, manifest)).toBe(false)
  expect(pluginAccessGrows(manifest, { ...manifest, surfaces: [...manifest.surfaces, "server:storage"] })).toBe(true)
  expect(pluginAccessGrows(null, manifest)).toBe(true)
})

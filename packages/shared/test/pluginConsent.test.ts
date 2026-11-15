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
      "Replaces an unsupported part of the app."
    )
    expect(pluginSurfaces({ ...manifest, surfaces: ["future:part"] })).toEqual([
      "Changes an additional part of the app."
    ])
  })
  it("names each replaced built-in and warns when the model's input can change", () => {
    for (const [part, words] of [
      ["noticeChannels:notifications.completion-sound", "Replaces Completion sound."],
      ["rolloutTools:set_presence", "Replaces Who's present (set_presence)."],
      ["macros:reverse", "Replaces Reverse text macro (reverse)."]
    ]) {
      const text = pluginConsent({ ...manifest, replaces: [part!] }, "user")
      expect(text).toContain(words)
      if (!part!.startsWith("noticeChannels:")) expect(text).toContain("Changes what the model sees.")
    }
  })
})

it("asks again when an earlier enabled version adds access, but not when it removes it", () => {
  const server = { ...manifest, server: "server.ts" }
  expect(pluginAccessGrows(manifest, server)).toBe(true)
  expect(pluginAccessGrows(server, manifest)).toBe(false)
  expect(pluginAccessGrows(manifest, { ...manifest, surfaces: [...manifest.surfaces, "server:storage"] })).toBe(true)
  expect(pluginAccessGrows(null, manifest)).toBe(true)
})

it("a display copy's consent names the part, the browser and that the model's input stays as written", () => {
  for (const [surface, part, words] of [
    ["client:displayTransforms", "displayTransforms:display.regex", "Replaces Display regex."],
    ["client:displayScriptLists", "displayScriptLists:display-regex.character", "Replaces Character display scripts."],
    ["client:timelineTransforms", "timelineTransforms:timeline.lcm", "Replaces Summary rows and divider."]
  ] as const) {
    const text = pluginConsent({ ...manifest, surfaces: [surface], replaces: [part] }, "user")
    expect(text[0]).toBe("Runs only in your browser. It can do anything you can do in the app.")
    expect(text).toContain(words)
    expect(text.join(" ")).toContain("odel requests stay as written.")
    expect(text).not.toContain("Changes what the model sees.")
    expect(text).not.toContain("Can send data to other sites.")
  }
})

// The panel bridge's allowlist (spec/HTML-MESSAGES.md §3.4, §3.7 check 3) and whose approval a
// panel's scripts follow (§3.4 "Approval").
import type { RegexScript } from "@rp/shared/docs/regexScript.ts"
import type { RefId } from "@rp/shared/library.ts"
import { describe, expect, it, vi } from "vitest"
import { panelPermit, writesScripts } from "../src/features/chat/panelPermits.ts"
import { bridgeLink, MAX_BRIDGE_COPY, parseBridgeMessage } from "../src/ui/html/bridge.ts"
import { panelHasScripts } from "../src/ui/html/messageHtml.ts"

describe("the bridge", () => {
  it("takes its four message types, each by its schema", () => {
    expect(parseBridgeMessage({ type: "rp:ready" })).toEqual({ type: "rp:ready" })
    expect(parseBridgeMessage({ type: "rp:height", height: 120 })).toEqual({ type: "rp:height", height: 120 })
    expect(parseBridgeMessage({ type: "rp:open", url: "https://example.com/" })).toEqual({
      type: "rp:open",
      url: "https://example.com/"
    })
    expect(parseBridgeMessage({ type: "rp:copy", text: "HP 12/20" })).toEqual({ type: "rp:copy", text: "HP 12/20" })
  })

  it("drops unknown types, wrong shapes and oversized ones", () => {
    for (const data of [
      null,
      "rp:ready",
      42,
      { type: "rp:render", html: "<b>x</b>" },
      { type: "rp:rpc", method: "DeleteChat" },
      { type: "getChatMessages" },
      { type: "rp:height", height: "120" },
      { type: "rp:height", height: Number.POSITIVE_INFINITY },
      { type: "rp:open" },
      { type: "rp:open", url: 1 },
      { type: "rp:copy", text: "x".repeat(MAX_BRIDGE_COPY + 1) },
      { type: "rp:copy", text: { toString: () => "x" } }
    ])
      expect(parseBridgeMessage(data), JSON.stringify(data)).toBe(null)
  })

  it("keeps nothing but the fields of the type", () => {
    expect(parseBridgeMessage({ type: "rp:ready", token: "secret" })).toEqual({ type: "rp:ready" })
  })

  it("opens http(s) links only", () => {
    expect(bridgeLink("https://example.com/a?b=1")).toBe("https://example.com/a?b=1")
    expect(bridgeLink("http://example.com")).toBe("http://example.com/")
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,<b>x</b>",
      "/rpc",
      "blob:https://x/1",
      "file:///etc/passwd"
    ])
      expect(bridgeLink(url), url).toBe(null)
  })
})

describe("whose approval a panel's scripts follow", () => {
  const card = { refId: "card" as RefId, name: "Lantern Inn", scripts: false, network: false }
  const preset = { refId: "preset" as RefId, name: "House style", scripts: true, network: false }
  const allow = vi.fn(async (_: RefId) => true)

  it("asks the first source still to allow them, and allowing calls it", async () => {
    const permit = panelPermit([card, preset], allow)
    expect(permit).toMatchObject({ scripts: false, network: false, ask: { name: "Lantern Inn" } })
    await permit.ask!.allow()
    expect(allow).toHaveBeenCalledWith("card")
    expect(
      panelPermit(
        [
          { ...card, scripts: true },
          { ...preset, scripts: false }
        ],
        allow
      ).ask?.name
    ).toBe("House style")
  })

  it("runs scripts once all allowed them, and the internet once all allowed that", () => {
    expect(panelPermit([{ ...card, scripts: true }], allow)).toEqual({ scripts: true, network: false, ask: null })
    expect(panelPermit([{ ...card, scripts: true, network: true }], allow).network).toBe(true)
    expect(panelPermit([{ ...card, scripts: true, network: true }, preset], allow).network).toBe(false)
  })

  it("runs nothing and asks nothing for no source, or one not read yet", () => {
    expect(panelPermit([], allow)).toEqual({ scripts: false, network: false, ask: null })
    expect(panelPermit([null], allow)).toEqual({ scripts: false, network: false, ask: null })
    expect(panelPermit([{ ...card, scripts: true }, null], allow).scripts).toBe(false)
  })

  it("counts the preset's display scripts only when what they write has scripts", () => {
    const script = (replace: string, change: Partial<RegexScript> = {}): RegexScript =>
      ({
        id: "s",
        name: "s",
        find_regex: "/x/",
        replace_string: replace,
        trim_strings: [],
        placement: [2],
        disabled: false,
        markdown_only: true,
        prompt_only: false,
        run_on_edit: false,
        substitute_regex: "none",
        min_depth: null,
        max_depth: null,
        ...change
      }) as RegexScript
    expect(writesScripts([script('<div class="hp">$1</div>')], 2)).toBe(false)
    expect(writesScripts([script("<script>go()</script>")], 2)).toBe(true)
    expect(writesScripts([script('<button onclick="go()">$1</button>')], 2)).toBe(true)
    expect(writesScripts([script("<script>go()</script>", { disabled: true })], 2)).toBe(false)
    expect(writesScripts([script("<script>go()</script>", { markdown_only: false })], 2)).toBe(false)
    expect(writesScripts([script("<script>go()</script>")], 1)).toBe(false)
  })

  it("finds a block's own scripts: script elements and handler attributes", () => {
    expect(panelHasScripts("<html><body><script>x()</script></body></html>")).toBe(true)
    expect(panelHasScripts('<html><body><img src="x" onerror="x()"></body></html>')).toBe(true)
    expect(panelHasScripts("<html><body><p>Not once = twice</p></body></html>")).toBe(false)
  })
})

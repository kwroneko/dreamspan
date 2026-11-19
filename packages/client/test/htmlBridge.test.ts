// The panel bridge's allowlist (spec/HTML-MESSAGES.md §3.4, §3.7 check 3) and whose approval a
// panel's scripts follow (§3.4 "Approval").
import type { RegexScript } from "@dreamspan/shared/docs/regexScript.ts"
import type { RefId } from "@dreamspan/shared/library.ts"
import { describe, expect, it, vi } from "vitest"
import { panelPermit, writesScripts } from "../src/features/chat/panelPermits.ts"
import { bridgeLink, MAX_BRIDGE_COPY, parseBridgeMessage } from "../src/ui/html/bridge.ts"
import { panelHasScripts } from "../src/ui/html/messageHtml.ts"

const token = "a".repeat(32)

describe("the bridge", () => {
  it("takes its five message types, each by its schema", () => {
    expect(parseBridgeMessage({ type: "dreamspan:ready", token })).toEqual({ type: "dreamspan:ready", token })
    expect(parseBridgeMessage({ type: "dreamspan:height", height: 120 })).toEqual({
      type: "dreamspan:height",
      height: 120
    })
    expect(parseBridgeMessage({ type: "dreamspan:open", token, url: "https://example.com/" })).toEqual({
      type: "dreamspan:open",
      token,
      url: "https://example.com/"
    })
    expect(parseBridgeMessage({ type: "dreamspan:focus", token })).toEqual({ type: "dreamspan:focus", token })
    expect(parseBridgeMessage({ type: "dreamspan:copy", token, text: "HP 12/20" })).toEqual({
      type: "dreamspan:copy",
      token,
      text: "HP 12/20"
    })
  })

  it("drops unknown types, wrong shapes and oversized ones", () => {
    for (const data of [
      null,
      { type: "dreamspan:ready" },
      { type: "dreamspan:ready", token: 1 },
      { type: "dreamspan:ready", token: "short" },
      { type: "dreamspan:copy", text: "Missing token" },
      { type: "dreamspan:focus" },
      { type: "dreamspan:focus", token: "short" },
      { type: "dreamspan:open", url: "https://example.com/" },
      "dreamspan:ready",
      42,
      { type: "dreamspan:render", html: "<b>x</b>" },
      { type: "rp:rpc", method: "DeleteChat" },
      { type: "getChatMessages" },
      { type: "dreamspan:height", height: "120" },
      { type: "dreamspan:height", height: Number.POSITIVE_INFINITY },
      { type: "dreamspan:open", token },
      { type: "dreamspan:open", token, url: 1 },
      { type: "dreamspan:copy", token, text: "x".repeat(MAX_BRIDGE_COPY + 1) },
      { type: "dreamspan:copy", token, text: { toString: () => "x" } }
    ])
      expect(parseBridgeMessage(data), JSON.stringify(data)).toBe(null)
  })

  it("keeps nothing but the fields of the type", () => {
    expect(parseBridgeMessage({ type: "dreamspan:ready", token, extra: "secret" })).toEqual({
      type: "dreamspan:ready",
      token
    })
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

  it("counts every applicable preset transform as a possible source of scripts", () => {
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
    expect(writesScripts([script('<div class="hp">$1</div>')], 2)).toBe(true)
    // Replacement captures, macros and earlier transforms can supply executable markup.
    expect(writesScripts([script("$1")], 2)).toBe(true)
    expect(writesScripts([script("<scr$1>go()</scr$1>")], 2)).toBe(true)
    expect(writesScripts([script('<img/onerror="go()">')], 2)).toBe(true)
    expect(writesScripts([script("<script>go()</script>")], 2)).toBe(true)
    expect(writesScripts([script('<button onclick="go()">$1</button>')], 2)).toBe(true)
    expect(writesScripts([script("<script>go()</script>", { disabled: true })], 2)).toBe(false)
    expect(writesScripts([script("<script>go()</script>", { markdown_only: false })], 2)).toBe(false)
    expect(writesScripts([script("<script>go()</script>")], 1)).toBe(false)
    expect(writesScripts([script("$1", { find_regex: "" })], 2)).toBe(false)
  })

  it("finds a block's own scripts: script elements and handler attributes", () => {
    expect(panelHasScripts("<html><body><script>x()</script></body></html>")).toBe(true)
    expect(panelHasScripts('<html><body><img src="x" onerror="x()"></body></html>')).toBe(true)
    expect(panelHasScripts("<html><body><p>Not once = twice</p></body></html>")).toBe(false)
  })
})

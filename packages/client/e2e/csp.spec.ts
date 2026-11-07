// The built app under its Content-Security-Policy (server.ts): the header is on the page,
// and every screen, a streamed reply with Markdown, code, a table, raw HTML with a style and
// an image among it, runs without a single violation.
import { expect, type Page, test } from "@playwright/test"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { cardFieldsTab } from "./support/cardEditor.ts"

/** A 1×1 PNG. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "400", FAKE_GENERATOR_TOKENS: "120" })

/** Violations, from the moment the page loads: the event, and the console's report of it. */
const watchViolations = async (page: Page) => {
  const violations: Array<string> = []
  await page.exposeFunction("__cspViolation", (text: string) => violations.push(text))
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) =>
      (window as unknown as { __cspViolation: (text: string) => void }).__cspViolation(
        `${event.violatedDirective} ${event.blockedURI}`
      )
    )
  })
  page.on("console", (message) => {
    if (message.text().includes("Content Security Policy")) violations.push(message.text())
  })
  return violations
}

test("every screen runs under the Content-Security-Policy", async ({ page }) => {
  const violations = await watchViolations(page)
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const response = await page.goto(`${server().url}/chats`)
  const csp = response!.headers()["content-security-policy"]!
  expect(csp).toContain("script-src 'self'")
  expect(csp).toContain(`connect-src 'self' ws://127.0.0.1:${server().port}`)

  await page.getByLabel("Title of the new chat").fill("Lighthouse")
  await page.getByRole("button", { name: "New chat" }).click()
  await expect(page.getByRole("heading", { level: 1, name: "Lighthouse" })).toBeVisible()
  const message = [
    "The keeper's *log*, with a [chart][c]:",
    "",
    "| Night | Ships |",
    "| --- | --- |",
    "| 1 | 3 |",
    "",
    "```js",
    "const lamp = 'lit'",
    "```",
    "",
    '<div style="color: red" onclick="alert(1)">raw <b>HTML</b></div><script>alert(1)</script>',
    "",
    '<style>.lamp { color: rgb(1, 2, 3) }</style><span class="lamp">lamp</span>',
    "",
    // Known sanitizer bypass strings (spec/HTML-MESSAGES.md §3.7): nothing runs, nothing is refused.
    '<svg></p><style><a id="</style><img src=1 onerror=alert(1)>">',
    '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
    "<form><math><mtext></form><form><mglyph><style></math><img src onerror=alert(1)>",
    "",
    "![a gull](https://example.com/gull.png)",
    "",
    "[c]: https://example.com/chart"
  ].join("\n")
  await page.getByLabel("Message", { exact: true }).fill(message)
  await page.getByRole("button", { name: "Send" }).click()
  await expect(page.getByRole("article", { name: "Your message" }).locator("table")).toBeVisible()
  await expect(page.getByRole("link", { name: "chart" })).toHaveAttribute("href", "https://example.com/chart")
  // The message's style applies under style-src 'self': through the constructed stylesheet.
  await expect(page.locator(".custom-lamp")).toHaveCSS("color", "rgb(1, 2, 3)")
  await expect(page.getByText("generating", { exact: true })).toHaveCount(0, { timeout: 20_000 })
  await expect(page.getByRole("article", { name: "Reply" })).toHaveCount(1)

  // A select's list: Base UI would add an inline <style> for its scrollbar.
  await page.goto(`${server().url}/settings/users`)
  await page.getByRole("button", { name: "New user" }).click()
  await page.getByLabel("Role").click()
  await expect(page.getByRole("option").first()).toBeVisible()
  await page.keyboard.press("Escape")

  for (const [path, heading] of [
    ["/", "Characters"],
    ["/chats", "Chats"],
    ["/library", "Library"],
    ["/import", "Import"],
    ["/import/st", "Import ST data"],
    ["/settings", "Connections"],
    ["/settings/account", "Account"],
    ["/settings/users", "Users"],
    ["/settings/notifications", "Notifications"],
    ["/settings/status", "Server"],
    ["/bin", "Bin"]
  ] as const) {
    await page.goto(`${server().url}${path}`)
    await expect(page.getByRole("main")).toBeVisible()
    // The route's content proves it mounted under the policy. RPC connections and
    // background health checks make network idleness unrelated to screen readiness.
    const contentHeading = page
      .getByRole("main")
      .getByRole("heading", { name: heading, exact: true })
      .and(page.locator(":not(nav *)"))
    await expect(contentHeading).toBeVisible()
  }
  // The card editor, with its avatar from /library/media and its search in a worker.
  await page.goto(`${server().url}/library`)
  await page.getByRole("button", { name: "New card" }).click()
  await page.getByRole("textbox", { name: "Display name", exact: true }).fill("Wren")
  await page.getByRole("button", { name: "Create" }).click()
  await cardFieldsTab(page, "Metadata")
  await page.getByLabel("Choose an avatar, or drop it here").setInputFiles({
    name: "wren.png",
    mimeType: "image/png",
    buffer: Buffer.from(PNG, "base64")
  })
  // A new picture goes through the cutout chooser (§14.5c); its default cutout is saved.
  await page
    .getByRole("dialog", { name: /new picture$/ })
    .getByRole("button", { name: "Save picture" })
    .click()
  await expect(page.getByRole("img", { name: "The card's avatar" })).toBeVisible()
  await page.getByRole("button", { name: "Search and replace", exact: true }).click()
  await page.getByRole("textbox", { name: "Find", exact: true }).fill("Wren")
  await page.getByRole("region", { name: "Search and replace" }).getByRole("button", { name: "Find" }).click()
  await expect(page.getByRole("region", { name: "Search and replace" }).getByRole("status")).toHaveText("1 match.")
  // The character grid and the card's page, with its avatar and its definition.
  await page.goto(`${server().url}/`)
  await page.getByRole("main").getByRole("link", { name: "Open Wren", exact: true }).click()
  // Its new chat, the card in the side panel's character tab, as in any chat.
  await expect(page.getByRole("link", { name: "Open Wren in the full editor", exact: true })).toBeVisible()
  expect(violations).toEqual([])
})

test("a message's panel runs in a frame with an opaque origin, under its own policy", async ({ page }) => {
  const violations = await watchViolations(page)
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  // The frame page's own policy: only the bootstrap runs, nothing connects, only the app frames it.
  const frame = await page.request.get(`${server().url}/frame/panel`)
  const policy = frame.headers()["content-security-policy"]!
  expect(policy).toContain("default-src 'none'")
  // The bootstrap by the page's nonce: no other script of the app's can run there.
  const nonce = /script-src 'nonce-([^']+)';/.exec(policy)?.[1]
  expect(nonce).toBeDefined()
  expect(await frame.text()).toContain(`<script nonce="${nonce}" src="/frame/bootstrap.js">`)
  expect(policy).toContain("connect-src 'none'")
  expect(policy).toContain("frame-ancestors 'self'")
  // A request from a frame carries Origin: null, which no route takes.
  for (const path of ["/rpc", "/library/import?name=x.json", "/frame/panel"]) {
    const refused = await page.request.get(`${server().url}${path}`, { headers: { origin: "null" } })
    expect(refused.status(), path).toBe(403)
  }

  await page.goto(`${server().url}/chats`)
  await page.getByLabel("Title of the new chat").fill("Panel")
  await page.getByRole("button", { name: "New chat" }).click()
  await expect(page.getByRole("heading", { level: 1, name: "Panel" })).toBeVisible()
  const block = [
    "```html",
    "<!doctype html><html><head><style>p { color: rgb(1, 2, 3) }</style></head>",
    '<body><p id="lamp">lit</p><img src="https://example.com/a.png" alt=""><script>document.title = "ran"</script></body></html>',
    "```"
  ].join("\n")
  await page.getByLabel("Message", { exact: true }).fill(block)
  await page.getByRole("button", { name: "Send" }).click()
  const panel = page.getByRole("article", { name: "Your message" }).frameLocator('iframe[title="Panel"]')
  await expect(panel.locator("#lamp")).toHaveCSS("color", "rgb(1, 2, 3)")
  const content = page.frames().find((candidate) => candidate.url().endsWith("/frame/panel"))!
  expect(await content.evaluate(() => origin)).toBe("null")
  expect(await content.evaluate(() => document.title)).toBe("")
  // The frame can't read the app.
  expect(
    await content.evaluate(() => {
      try {
        return String(parent.document)
      } catch {
        return "blocked"
      }
    })
  ).toBe("blocked")
  await expect(page.getByText("generating", { exact: true })).toHaveCount(0, { timeout: 20_000 })
  // The app's pages report nothing; the frame's refusals (its script, the remote image) are its own.
  expect(violations.filter((text) => !text.includes("/frame/") && !text.includes("example.com"))).toEqual([])
})

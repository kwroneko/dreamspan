// Panel scripts (spec/HTML-MESSAGES.md §3.4, step 3), in the built app: a synthetic card's
// greeting panel has scripts, which don't run until "Run scripts from <card>"; then they run
// with the vendored libraries in the opaque-origin frame and can reach nothing (§3.7 check 2:
// the RPC route, the socket, the parent's document, the top page and pop-ups all fail, and so
// does another site), while the bridge opens a clicked link in a new tab and copies on a click.
// The card editor's Panels switches show the same approval; with the internet allowed the panel
// reaches other sites. At 1440 and 390, light and dark, with the layout audit.
import { expect, test } from "@playwright/test"
import type { EntityId } from "@rp/shared/chat.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)

const greeting = [
  "The notice board of the inn.",
  "",
  "```html",
  "<!doctype html>",
  "<html><head><style>",
  "body { margin: 0; color: var(--rp-text) } .box { padding: 8px; border: 2px solid var(--rp-accent) }",
  "</style></head><body>",
  '<div class="box" id="panel">Board</div>',
  '<a id="out" href="https://example.com/out">Notice</a>',
  '<button id="copy" onclick="rp.copy(\'HP 12/20\')">Copy</button>',
  '<pre id="results"></pre>',
  "<script>",
  "(async () => {",
  "  const r = {}",
  "  r.libraries = typeof $ === 'function' && typeof $.ui === 'object' && typeof _ === 'function' && typeof Vue === 'object' && typeof VueRouter === 'object' ? 'yes' : 'no'",
  "  try { await fetch('/rpc'); r.rpc = 'reached' } catch { r.rpc = 'blocked' }",
  "  try { await fetch('https://example.com/beacon?' + Date.now()); r.beacon = 'reached' } catch { r.beacon = 'blocked' }",
  "  r.socket = await new Promise((resolve) => {",
  "    try { const s = new WebSocket('ws://' + location.host + '/rpc'); s.onopen = () => resolve('open'); s.onerror = () => resolve('blocked') }",
  "    catch { resolve('blocked') }",
  "  })",
  "  try { r.parent = parent.document ? 'read' : 'blocked' } catch { r.parent = 'blocked' }",
  "  try { top.location.href = 'https://example.com/away'; r.top = 'tried' } catch { r.top = 'blocked' }",
  "  try { r.popup = window.open('https://example.com/popup') ? 'opened' : 'blocked' } catch { r.popup = 'blocked' }",
  "  document.getElementById('results').textContent = JSON.stringify(r)",
  "  document.body.dataset.ran = 'yes'",
  "})()",
  "</script></body></html>",
  "```"
].join("\n")

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`a panel's scripts run once its card allows them, walled off, at ${width} (${theme})`, async ({
      page
    }, info) => {
      test.setTimeout(180_000)
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
      const violations: string[] = []
      page.on("console", (message) => {
        // A panel's own refusals are the point; only the app's page counts.
        if (message.text().includes("Content Security Policy") && !message.location().url.includes("/frame/"))
          violations.push(message.text())
      })
      const elsewhere: string[] = []
      page.on("request", (request) => {
        if (request.url().includes("example.com")) elsewhere.push(new URL(request.url()).pathname)
      })
      await page
        .context()
        .route("https://example.com/**", (route) =>
          route.fulfill({ status: 200, body: "ok", headers: { "access-control-allow-origin": "*" } })
        )
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: server().url })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const name = `Lantern Inn ${width} ${theme}`
      const imported = await page.request.post(`${server().url}/library/import?name=fixture.json`, {
        data: Buffer.from(
          JSON.stringify({ spec: "chara_card_v3", spec_version: "3.0", data: { name, first_mes: greeting } })
        ),
        headers: { origin: server().url, "content-type": "application/octet-stream" }
      })
      expect(imported.status()).toBe(200)
      const { ref } = ((await imported.json()) as { library: { ref: { id: string; entityId: string } } }).library
      const started = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        api.StartChat({
          cards: [ref.entityId as EntityId],
          persona: null,
          greeting: 0,
          first: { _tag: "Send", content: "Evening.", speakerEntityId: null }
        })
      )
      await page.goto(`${server().url}/chats/${started.chat.id}`)
      const article = page.locator("article", { hasText: "The notice board of the inn." })
      const frame = article.locator('iframe[title="Panel"]')
      const inside = article.frameLocator('iframe[title="Panel"]')
      await expect(inside.locator("#panel")).toHaveText("Board")
      await expect(frame).toHaveAttribute("src", "/frame/panel")
      // Off until allowed: the static panel shows, its script doesn't run, and the strip says so.
      await expect(article.getByText("This panel has scripts.")).toBeVisible()
      const run = article.getByRole("button", { name: `Run scripts from ${name}`, exact: true })
      await expect(run).toBeVisible()
      await expect(inside.locator("#results")).toHaveText("")
      await expectLayout(page, info, `html-scripts-off-${width}-${theme}`, { scope: "[data-testid=messages]" })

      await run.click()
      await expect(article.getByText("This panel has scripts.")).toHaveCount(0)
      await expect(frame).toHaveAttribute("src", "/frame/panel?scripts=1")
      await expect(inside.locator("body")).toHaveAttribute("data-ran", "yes", { timeout: 30_000 })
      const results = JSON.parse((await inside.locator("#results").textContent()) ?? "{}") as Record<string, string>
      expect(results).toEqual({
        libraries: "yes",
        rpc: "blocked",
        beacon: "blocked",
        socket: "blocked",
        parent: "blocked",
        top: expect.stringMatching(/^(blocked|tried)$/) as unknown as string,
        popup: "blocked"
      })
      expect(new URL(page.url()).pathname).toBe(`/chats/${started.chat.id}`)
      expect(elsewhere).toEqual([])

      // The bridge: a clicked link opens in a new tab; a click copies.
      const opened = page.context().waitForEvent("page")
      await inside.locator("#out").click()
      const tab = await opened
      await tab.waitForURL("https://example.com/out")
      await tab.close()
      await inside.locator("#copy").click()
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("HP 12/20")
      await expectLayout(page, info, `html-scripts-on-${width}-${theme}`, { scope: "[data-testid=messages]" })

      // The card editor shows the approval; the internet is a second switch.
      await page.goto(`${server().url}/library/${ref.id}`)
      await page.getByRole("tab", { name: "Extra", exact: true }).click()
      const scripts = page.getByRole("switch", { name: "Run panel scripts", exact: true })
      const internet = page.getByRole("switch", { name: "Let panels use the internet", exact: true })
      await expect(scripts).toBeChecked()
      await expect(internet).not.toBeChecked()
      await internet.click()
      await expect(internet).toBeChecked()
      await expectLayout(page, info, `html-scripts-editor-${width}-${theme}`)

      await page.goto(`${server().url}/chats/${started.chat.id}`)
      await expect(frame).toHaveAttribute("src", "/frame/panel?scripts=1&network=1")
      await expect(inside.locator("body")).toHaveAttribute("data-ran", "yes", { timeout: 30_000 })
      const online = JSON.parse((await inside.locator("#results").textContent()) ?? "{}") as Record<string, string>
      expect(online.beacon).toBe("reached")
      // Our own server still refuses the frame: over http the policy blocks it, and the server refuses Origin null.
      expect(online.rpc).toBe("blocked")
      expect(online.parent).toBe("blocked")
      // The frames' refusals are theirs; the app reports nothing.
      expect(violations).toEqual([])
    })

// With scripts on, a panel's attempts to leave its document (§3.7 with the review's navigation
// cases): a location change to another site, to a frame page with more permissions and to the
// app; a form submitted by script and one never in the document; an SVG link, by primary and
// middle click. None loads anything, none gets the block again, and the app's page stays put.
const panel = (marker: string, body: string) =>
  ["```html", "<!doctype html>", `<html><body><p id="marker">${marker}</p>`, body, "</body></html>", "```"].join("\n")
const leaving = [
  "The inn's back rooms.",
  "",
  panel("Away", "<script>setTimeout(() => { location.href = 'https://example.com/away' }, 50)</script>"),
  "",
  panel("Upgrade", "<script>setTimeout(() => { location.href = '/frame/panel?scripts=1&network=1' }, 50)</script>"),
  "",
  panel("App", "<script>setTimeout(() => { location.replace('/') }, 50)</script>"),
  "",
  panel(
    "Forms",
    [
      '<form id="kept" action="https://example.com/kept" method="post"><input name="a" value="1"></form>',
      // In a function: the libraries' globals take some short names.
      "<script>(() => {",
      "const r = {}",
      "try { document.getElementById('kept').requestSubmit(); r.kept = 'tried' } catch { r.kept = 'blocked' }",
      "const loose = document.createElement('form'); loose.action = 'https://example.com/loose'; loose.method = 'get'",
      "try { loose.submit(); r.loose = 'tried' } catch { r.loose = 'blocked' }",
      "document.body.dataset.forms = JSON.stringify(r)",
      "})()</script>"
    ].join("\n")
  ),
  "",
  panel(
    "Drawing",
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="240" height="40">' +
      '<a id="svgout" xlink:href="https://example.com/svg"><text x="4" y="24">Map link</text></a></svg>' +
      '<svg width="240" height="40"><a id="svgself" href="/frame/panel?scripts=1&amp;network=1"><text x="4" y="24">Here</text></a></svg>'
  )
].join("\n")

test("a panel with scripts can't navigate away from its document or get it again", async ({ page }) => {
  test.setTimeout(180_000)
  await page.setViewportSize({ width: 1440, height: 1400 })
  const elsewhere: string[] = []
  page.context().on("request", (request) => {
    if (request.url().includes("example.com")) elsewhere.push(new URL(request.url()).pathname)
  })
  await page
    .context()
    .route("https://example.com/**", (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: "<p>elsewhere</p>" })
    )
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const name = "Back Room"
  const imported = await page.request.post(`${server().url}/library/import?name=fixture.json`, {
    data: Buffer.from(
      JSON.stringify({ spec: "chara_card_v3", spec_version: "3.0", data: { name, first_mes: leaving } })
    ),
    headers: { origin: server().url, "content-type": "application/octet-stream" }
  })
  expect(imported.status()).toBe(200)
  const { ref } = ((await imported.json()) as { library: { ref: { id: string; entityId: string } } }).library
  const started = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.StartChat({
      cards: [ref.entityId as EntityId],
      persona: null,
      greeting: 0,
      first: { _tag: "Send", content: "Evening.", speakerEntityId: null }
    })
  )
  await page.goto(`${server().url}/chats/${started.chat.id}`)
  const article = page.locator("article", { hasText: "The inn's back rooms." })
  const frames = article.locator('iframe[title="Panel"]')
  await expect(frames).toHaveCount(5)
  await article
    .getByRole("button", { name: `Run scripts from ${name}`, exact: true })
    .first()
    .click()
  await expect(article.getByText("This panel has scripts.")).toHaveCount(0)
  for (let index = 0; index < 5; index++)
    await expect(frames.nth(index)).toHaveAttribute("src", "/frame/panel?scripts=1")

  const inside = (index: number) => article.frameLocator('iframe[title="Panel"]').nth(index)
  // Forms: sandboxed without allow-forms, neither submits.
  await expect(inside(3).locator("body")).toHaveAttribute("data-forms", /kept/)
  // The SVG link opens in a new tab through the bridge; a middle click and a link to a frame page do nothing.
  const opened = page.context().waitForEvent("page")
  await inside(4).locator("#svgout text").click()
  const tab = await opened
  await tab.waitForURL("https://example.com/svg")
  await tab.close()
  await inside(4).locator("#svgout text").click({ button: "middle" })
  await inside(4).locator("#svgself text").click()
  await page.waitForTimeout(1500)
  await expect(inside(4).locator("#marker")).toHaveText("Drawing")
  await expect(inside(3).locator("#marker")).toHaveText("Forms")

  // The location changes: another site and the app are refused by the page's policies, so
  // those frames show the browser's error page; the frame page with more permissions loads but
  // never gets the block, as its window was already given it once.
  const urls = page.frames().map((frame) => frame.url())
  expect(urls.filter((url) => url.startsWith("https://example.com"))).toEqual([])
  expect(urls.filter((url) => url === `${server().url}/`)).toEqual([])
  const upgraded = page.frames().filter((frame) => frame.url().endsWith("/frame/panel?scripts=1&network=1"))
  expect(upgraded).toHaveLength(1)
  expect(await upgraded[0]!.evaluate(() => document.body?.textContent ?? "")).toBe("")
  expect(await upgraded[0]!.evaluate(() => document.querySelector("#marker"))).toBeNull()
  expect(new URL(page.url()).pathname).toBe(`/chats/${started.chat.id}`)
  // Only the bridge's tab reached the other site.
  expect(elsewhere).toEqual(["/svg"])
})

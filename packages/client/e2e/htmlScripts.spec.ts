// Panel scripts (spec/HTML-MESSAGES.md §3.4, step 3), in the built app: a synthetic card's
// greeting panel has scripts, which don't run until "Run scripts from <card>"; then they run
// with the vendored libraries in the opaque-origin frame and can reach nothing (§3.7 check 2:
// the RPC route, the socket, the parent's document, the top page and pop-ups all fail, and so
// does another site), while the bridge opens a clicked link in a new tab and copies on a click.
// The card editor's Panels switches show the same approval; with the internet allowed the panel
// reaches other sites. At 1440 and 390, light and dark, with the layout audit.
import { expect, test } from "@playwright/test"
import type { EntityId } from "@dreamspan/shared/chat.ts"
import type { RefId } from "@dreamspan/shared/library.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { expectTextBox } from "./support/textbox.ts"
import { urlOpenedInNewTab } from "./support/browserTab.ts"

const server = serverPerFile(withAdmin)

test("a scripted panel preserves native HTML sanitizer options", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "The native Sanitizer API is exercised in Chromium.")
  await page.goto(`${server().url}/frame/panel?scripts=1`)
  const result = await page.evaluate(() => {
    type Options = { sanitizer: { removeElements: string[] } }
    type Target = { setHTML(markup: string, options: Options): void; innerHTML: string }
    const target = document.createElement("div")
    const shadow = target.attachShadow({ mode: "open" })
    const options = { sanitizer: { removeElements: ["b"] } }
    const markup = '<b>bold</b><i>italics</i><link rel="preconnect">'
    const parsed = (Document as unknown as { parseHTML(markup: string, options: Options): Document }).parseHTML(
      markup,
      options
    )
    const set = (into: Element | ShadowRoot) => {
      const html = into as unknown as Target
      html.setHTML(markup, options)
      return html.innerHTML
    }
    return [set(target), set(shadow), parsed.body.innerHTML, parsed.querySelectorAll("link").length]
  })
  expect(result).toEqual(["<i>italics</i>", "<i>italics</i>", "<i>italics</i>", 0])
})

const greeting = [
  "The notice board of the inn.",
  "",
  "```html",
  "<!doctype html>",
  "<html><head><style>",
  "body { margin: 0; color: var(--dreamspan-text) } .box { padding: 8px; border: 2px solid var(--dreamspan-accent) }",
  "</style></head><body>",
  '<div class="box" id="panel">Board</div>',
  '<a id="out" href="https://example.com/out">Notice</a>',
  '<button id="copy" onclick="dreamspan.copy(\'HP 12/20\')">Copy</button>',
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
  "  try { r.storage = localStorage.length >= 0 ? 'read' : 'blocked' } catch { r.storage = 'blocked' }",
  "  try { r.sessionStorage = sessionStorage.length >= 0 ? 'read' : 'blocked' } catch { r.sessionStorage = 'blocked' }",
  "  try { r.cookie = typeof document.cookie === 'string' ? 'read' : 'blocked' } catch { r.cookie = 'blocked' }",
  "  try { top.location.href = 'https://example.com/away'; r.top = 'tried' } catch { r.top = 'blocked' }",
  "  try { r.popup = window.open('https://example.com/popup') ? 'opened' : 'blocked' } catch { r.popup = 'blocked' }",
  "  r.star = ['a', '*'][1] + \"\\\"\".length", // odd '*' and '"' on one line: display fixes must not touch panel code
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
      await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
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

      // The strip only asks: the dialog, outside the message, allows them.
      await run.click()
      const confirm = page.getByRole("alertdialog")
      await expect(confirm).toContainText(`Run scripts from ${name}?`)
      await expect(frame).toHaveAttribute("src", "/frame/panel")
      await confirm.getByRole("button", { name: "Run scripts", exact: true }).click()
      await expect(confirm).toHaveCount(0)
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
        storage: "blocked",
        sessionStorage: "blocked",
        cookie: "blocked",
        top: expect.stringMatching(/^(blocked|tried)$/) as unknown as string,
        popup: "blocked",
        star: "*1"
      })
      expect(new URL(page.url()).pathname).toBe(`/chats/${started.chat.id}`)
      expect(elsewhere).toEqual([])

      // The bridge: a clicked link opens in a new tab; a click copies.
      expect(await urlOpenedInNewTab(page, () => inside.locator("#out").click())).toBe("https://example.com/out")
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
  await page.getByRole("alertdialog").getByRole("button", { name: "Run scripts", exact: true }).click()
  await expect(article.getByText("This panel has scripts.")).toHaveCount(0)
  for (let index = 0; index < 5; index++)
    await expect(frames.nth(index)).toHaveAttribute("src", "/frame/panel?scripts=1")

  const inside = (index: number) => article.frameLocator('iframe[title="Panel"]').nth(index)
  // Forms: sandboxed without allow-forms, neither submits.
  await expect(inside(3).locator("body")).toHaveAttribute("data-forms", /kept/)
  // The SVG link opens in a new tab through the bridge; a middle click and a link to a frame page do nothing.
  expect(await urlOpenedInNewTab(page, () => inside(4).locator("#svgout text").click())).toBe("https://example.com/svg")
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

// Transient activation is shared with ancestors. A click in the app must not give a
// script-running panel permission to open a tab or replace the user's clipboard.
test("the bridge cannot borrow a click from outside its frame", async ({ page }) => {
  test.setTimeout(180_000)
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: server().url })
  const imported = await page.request.post(`${server().url}/library/import?name=activation.json`, {
    data: Buffer.from(
      JSON.stringify({
        spec: "chara_card_v3",
        spec_version: "3.0",
        data: {
          name: "Bridge activation",
          first_mes: panel(
            "Activation",
            [
              "<button>Panel button</button>",
              "<script>addEventListener('message', (event) => {",
              "if (event.data !== 'review:activation') return",
              "parent.postMessage({ type: 'review:state', active: navigator.userActivation.isActive }, new URL(location.href).origin)",
              "try { Object.defineProperty(Object.getPrototypeOf(navigator.userActivation), 'isActive', { get: () => true }) } catch {}",
              "dreamspan.copy('Panel text')",
              "parent.postMessage({ type: 'dreamspan:copy', text: 'Forged text', token: '0'.repeat(32) }, new URL(location.href).origin)",
              "parent.postMessage({ type: 'dreamspan:open', url: 'https://example.com/borrowed', token: '0'.repeat(32) }, new URL(location.href).origin)",
              "parent.postMessage({ type: 'review:complete' }, new URL(location.href).origin)",
              "}); document.body.dataset.activationReady='yes'</script>"
            ].join("\n")
          )
        }
      })
    ),
    headers: { origin: server().url, "content-type": "application/octet-stream" }
  })
  expect(imported.status()).toBe(200)
  const { ref } = ((await imported.json()) as { library: { ref: { id: string; entityId: string } } }).library
  await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.SetHtmlApproval({ refId: ref.id as RefId, scripts: true, network: false })
  )
  const started = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.StartChat({
      cards: [ref.entityId as EntityId],
      persona: null,
      greeting: 0,
      first: { _tag: "Send", content: "Evening.", speakerEntityId: null }
    })
  )
  await page.goto(`${server().url}/chats/${started.chat.id}`)
  await expect(page.frameLocator('iframe[title="Panel"]').locator("#marker")).toHaveText("Activation")
  await expect(page.frameLocator('iframe[title="Panel"]').locator("body")).toHaveAttribute(
    "data-activation-ready",
    "yes"
  )
  await page.evaluate(async () => {
    await navigator.clipboard.writeText("Unchanged")
    const write = navigator.clipboard.writeText.bind(navigator.clipboard)
    navigator.clipboard.writeText = (text) => {
      document.documentElement.dataset.reviewBridgeCopy = text
      return write(text)
    }
    window.open = () => {
      document.documentElement.dataset.reviewBridgeOpen = "yes"
      return null
    }
    addEventListener("message", (event) => {
      if (event.data?.type === "review:state")
        document.documentElement.dataset.reviewFrameActive = String(event.data.active)
      if (event.data?.type === "review:complete") document.documentElement.dataset.reviewBridgeDone = "yes"
    })
  })
  // Real input in the parent only, with no automation gesture of the page's own: an
  // evaluate in the page (or the frame) would itself give the frame activation. The key press
  // makes the parent post to the panel, which then tries every way to act on it.
  await page.evaluate(() => {
    addEventListener(
      "keydown",
      () =>
        document
          .querySelector<HTMLIFrameElement>('iframe[title="Panel"]')!
          .contentWindow!.postMessage("review:activation", "*"),
      { once: true }
    )
  })
  await page.waitForTimeout(6000) // the setup's own activation has expired
  await page.getByTestId("composer").click()
  await page.keyboard.press("a")
  await expect(page.locator("html")).toHaveAttribute("data-review-bridge-done", "yes")
  // The key press in the app gave the frame no activation of its own.
  await expect(page.locator("html")).toHaveAttribute("data-review-frame-active", "false")
  await expect(page.locator("html")).not.toHaveAttribute("data-review-bridge-copy")
  await expect(page.locator("html")).not.toHaveAttribute("data-review-bridge-open")
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("Unchanged")
})

// A replacement can assemble executable markup without containing a literal script tag.
// Regex approval is separate from approval to execute the resulting panel's scripts.
test("a preset cannot assemble panel scripts under the card's approval", async ({ page }) => {
  test.setTimeout(180_000)
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const imported = await page.request.post(`${server().url}/library/import?name=source.json`, {
    data: Buffer.from(
      JSON.stringify({
        spec: "chara_card_v3",
        spec_version: "3.0",
        data: { name: "Source card", first_mes: panel("Preset", "<span>TOKENipt</span>") }
      })
    ),
    headers: { origin: server().url, "content-type": "application/octet-stream" }
  })
  expect(imported.status()).toBe(200)
  const { ref: card } = ((await imported.json()) as { library: { ref: { id: RefId; entityId: EntityId } } }).library
  const importedPreset = await page.request.post(`${server().url}/library/import?name=Source-preset.json`, {
    data: Buffer.from(
      JSON.stringify({
        openai_max_context: 8192,
        extensions: {
          regex_scripts: [
            {
              id: "assemble",
              scriptName: "Assemble a panel",
              findRegex: "/TOKEN(ipt)/g",
              replaceString: "<scr$1>document.body.dataset.presetRan='yes'</scr$1>",
              placement: [2],
              markdownOnly: true
            }
          ]
        }
      })
    ),
    headers: { origin: server().url, "content-type": "application/octet-stream" }
  })
  expect(importedPreset.status()).toBe(200)
  const { ref: preset } = ((await importedPreset.json()) as { library: { ref: { id: RefId } } }).library
  await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.SetHtmlApproval({ refId: card.id, scripts: true, network: true })
  )
  const opened = await asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.OpenEditor({ refId: preset.id }))
  await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.SetRegexApproval({
      refId: preset.id,
      approved: true,
      expectedRowVersion: opened.ref.rowVersion
    })
  )
  await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.ChangeGenerationDefaults({ change: { preset: preset.id } })
  )
  const started = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.StartChat({
      cards: [card.entityId],
      persona: null,
      greeting: 0,
      first: { _tag: "Send", content: "Evening.", speakerEntityId: null }
    })
  )
  await page.goto(`${server().url}/chats/${started.chat.id}`)
  const frame = page.locator('iframe[title="Panel"]')
  const inside = page.frameLocator('iframe[title="Panel"]')
  await expect(inside.locator("#marker")).toHaveText("Preset")
  await expect(frame).toHaveAttribute("src", "/frame/panel")
  await expect(inside.locator("body")).not.toHaveAttribute("data-preset-ran", "yes")
  await page.getByRole("button", { name: "Run scripts from Source-preset", exact: true }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Run scripts", exact: true }).click()
  await expect(frame).toHaveAttribute("src", "/frame/panel?scripts=1")
  await expect(inside.locator("body")).toHaveAttribute("data-preset-ran", "yes")
  // The card's network approval cannot confer the preset's network permission either.
  await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.SetHtmlApproval({
      refId: preset.id,
      scripts: true,
      network: true
    })
  )
  await expect(frame).toHaveAttribute("src", "/frame/panel?scripts=1&network=1")
})

// Hold the new preset's worker reply so its permission cannot race ahead of its text.
test("new preset approval cannot execute a previous preset's pending display text", async ({ page }) => {
  test.setTimeout(180_000)
  await page.addInitScript(() => {
    const schedule = window.setTimeout.bind(window)
    let deadline: number | undefined
    Object.defineProperty(window, "setTimeout", {
      value: (callback: TimerHandler, delay?: number, ...args: unknown[]) => {
        const timer = schedule(callback, delay, ...args)
        if (delay === 500) deadline = timer
        return timer
      }
    })
    let holding = true
    const post = Worker.prototype.postMessage
    Worker.prototype.postMessage = function (message, options) {
      const job = message as { scripts?: { id: string }[] }
      if (holding && job?.scripts?.some((script) => script.id === "held-preset")) {
        // Pause this job's deadline as well as its reply; host load cannot end the hold.
        clearTimeout(deadline)
        ;(window as unknown as { releaseDisplay: () => void }).releaseDisplay = () => {
          holding = false
          Reflect.apply(post, this, [message, options])
        }
        document.documentElement.dataset.displayHeld = "yes"
        return
      }
      Reflect.apply(post, this, [message, options])
    }
    addEventListener("message", (event) => {
      if (event.data?.type === "review:stale") document.documentElement.dataset.stalePanelRan = "yes"
    })
  })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const upload = async (name: string, body: unknown) => {
    const response = await page.request.post(`${server().url}/library/import?name=${name}.json`, {
      data: Buffer.from(JSON.stringify(body)),
      headers: { origin: server().url, "content-type": "application/octet-stream" }
    })
    expect(response.status()).toBe(200)
    return ((await response.json()) as { library: { ref: { id: RefId; entityId: EntityId } } }).library.ref
  }
  const card = await upload("Pending card", {
    spec: "chara_card_v3",
    spec_version: "3.0",
    data: { name: "Pending card", first_mes: panel("Delayed", "TOKEN") }
  })
  const preset = (id: string, replacement: string) => ({
    openai_max_context: 8192,
    extensions: {
      regex_scripts: [
        {
          id,
          scriptName: id,
          findRegex: "/TOKEN/g",
          replaceString: replacement,
          placement: [2],
          markdownOnly: true
        }
      ]
    }
  })
  const before = await upload(
    "Earlier preset",
    preset("earlier-preset", "<script>parent.postMessage({type:'review:stale'},'*')</script>")
  )
  const after = await upload("Next preset", preset("held-preset", "<b>Next</b>"))
  for (const ref of [before, after]) {
    const snapshot = await asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.OpenEditor({ refId: ref.id }))
    await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
      api.SetRegexApproval({
        refId: ref.id,
        approved: true,
        expectedRowVersion: snapshot.ref.rowVersion
      })
    )
  }
  for (const ref of [card, after])
    await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
      api.SetHtmlApproval({
        refId: ref.id,
        scripts: true,
        network: false
      })
    )
  await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.ChangeGenerationDefaults({ change: { preset: before.id } })
  )
  const started = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.StartChat({
      cards: [card.entityId],
      persona: null,
      greeting: 0,
      first: { _tag: "Send", content: "Evening.", speakerEntityId: null }
    })
  )
  await page.goto(`${server().url}/chats/${started.chat.id}`)
  const frame = page.locator('iframe[title="Panel"]')
  await expect(page.frameLocator('iframe[title="Panel"]').locator("#marker")).toHaveText("Delayed")
  await expect(frame).toHaveAttribute("src", "/frame/panel")
  await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.ChangeCast({
      chatId: started.chat.id,
      slotId: null,
      change: { _tag: "Preset", ref: after.id }
    })
  )
  await expect(page.locator("html")).toHaveAttribute("data-display-held", "yes")
  try {
    // At this point the new permissions are current but the worker still holds the new text.
    expect(await page.locator('iframe[title="Panel"][src="/frame/panel?scripts=1"]').count()).toBe(0)
  } finally {
    await page.evaluate(() => (window as unknown as { releaseDisplay: () => void }).releaseDisplay())
  }
  await expect(page.frameLocator('iframe[title="Panel"]').locator("b")).toHaveText("Next")
  await expect(page.locator("html")).not.toHaveAttribute("data-stale-panel-ran")
})

// A panel can take focus briefly. The app restores it to the composer, and a key handled in
// the panel during that window can't use the bridge. A click in the panel permits its copy.
test("a panel that takes focus gives it back, and its copy requires a click in the panel", async ({ page }) => {
  test.setTimeout(180_000)
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: server().url })
  const imported = await page.request.post(`${server().url}/library/import?name=focus.json`, {
    data: Buffer.from(
      JSON.stringify({
        spec: "chara_card_v3",
        spec_version: "3.0",
        data: {
          name: "Focus card",
          first_mes: panel(
            "Focus",
            [
              '<input id="field">',
              "<script>const field = document.getElementById('field')",
              "addEventListener('keydown', () => dreamspan.copy('Panel text'), true)",
              "field.addEventListener('focus', () => { document.body.dataset.focusAttempted = 'yes' }, { once: true })",
              "addEventListener('message', ({ data }) => {",
              "  if (data !== 'test:focus') return",
              "  field.focus()",
              "  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))",
              "})",
              "document.body.dataset.focusReady = 'yes'</script>"
            ].join("\n")
          )
        }
      })
    ),
    headers: { origin: server().url, "content-type": "application/octet-stream" }
  })
  expect(imported.status()).toBe(200)
  const { ref } = ((await imported.json()) as { library: { ref: { id: RefId; entityId: EntityId } } }).library
  await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.SetHtmlApproval({ refId: ref.id, scripts: true, network: false })
  )
  // A preset without display scripts: the card alone is the panel's source, whatever an
  // earlier test in this file left as the default.
  const plain = await page.request.post(`${server().url}/library/import?name=Plain-preset.json`, {
    data: Buffer.from(JSON.stringify({ openai_max_context: 8192 })),
    headers: { origin: server().url, "content-type": "application/octet-stream" }
  })
  expect(plain.status()).toBe(200)
  const { ref: preset } = ((await plain.json()) as { library: { ref: { id: RefId } } }).library
  await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.ChangeGenerationDefaults({ change: { preset: preset.id } })
  )
  const started = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.StartChat({
      cards: [ref.entityId],
      persona: null,
      greeting: 0,
      first: { _tag: "Send", content: "Evening.", speakerEntityId: null }
    })
  )
  await page.goto(`${server().url}/chats/${started.chat.id}`)
  const frame = page.locator('iframe[title="Panel"]')
  const inside = frame.contentFrame()
  await expect(inside.locator("body")).toHaveAttribute("data-focus-ready", "yes")
  await page.evaluate(() => navigator.clipboard.writeText("Unchanged"))
  const composer = page.getByTestId("composer")
  await composer.click()
  await page.keyboard.type("Good evening")
  await frame.evaluate((iframe: HTMLIFrameElement) => iframe.contentWindow!.postMessage("test:focus", "*"))
  await expect(inside.locator("body")).toHaveAttribute("data-focus-attempted", "yes")
  await expect(composer).toBeFocused()
  await page.keyboard.type(" to you")
  await expectTextBox(composer, "Good evening to you")
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("Unchanged")
  await inside.locator("#field").click()
  await expect(inside.locator("#field")).toBeFocused()
  await page.keyboard.type("Room 4")
  await expect(inside.locator("#field")).toHaveValue("Room 4")
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("Panel text")
})

// A press in a panel can reach the app before the pointer's arrival over it does (pointer moves
// wait for the app's next frame; a busy host makes that late): the app then takes the focus
// back at once, as from a frame the pointer isn't over, and the press's signed `dreamspan:focus`
// gives it back. The press's own focus inside the panel must come back with it: the field the
// user pressed in gets the typing, from its first key.
test("a press the app sees before the pointer's arrival keeps its field's focus", async ({ page }) => {
  test.setTimeout(180_000)
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const imported = await page.request.post(`${server().url}/library/import?name=late-hover.json`, {
    data: Buffer.from(
      JSON.stringify({
        spec: "chara_card_v3",
        spec_version: "3.0",
        data: {
          name: "Late hover card",
          first_mes: panel("Late", '<input id="field">\n<script>document.body.dataset.ready = "yes"</script>')
        }
      })
    ),
    headers: { origin: server().url, "content-type": "application/octet-stream" }
  })
  expect(imported.status()).toBe(200)
  const { ref } = ((await imported.json()) as { library: { ref: { id: RefId; entityId: EntityId } } }).library
  await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.SetHtmlApproval({ refId: ref.id, scripts: true, network: false })
  )
  const plain = await page.request.post(`${server().url}/library/import?name=Plain-preset-2.json`, {
    data: Buffer.from(JSON.stringify({ openai_max_context: 8192 })),
    headers: { origin: server().url, "content-type": "application/octet-stream" }
  })
  expect(plain.status()).toBe(200)
  const { ref: preset } = ((await plain.json()) as { library: { ref: { id: RefId } } }).library
  await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.ChangeGenerationDefaults({ change: { preset: preset.id } })
  )
  const started = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.StartChat({
      cards: [ref.entityId],
      persona: null,
      greeting: 0,
      first: { _tag: "Send", content: "Evening.", speakerEntityId: null }
    })
  )
  await page.goto(`${server().url}/chats/${started.chat.id}`)
  const inside = page.frameLocator('iframe[title="Panel"]')
  await expect(inside.locator("body")).toHaveAttribute("data-ready", "yes")
  const composer = page.getByTestId("composer")
  await composer.click()
  await page.keyboard.type("Hello", { delay: 30 })
  await page.waitForTimeout(700)
  const field = (await inside.locator("#field").boundingBox())!
  await page.mouse.move(field.x + field.width / 2, field.y + field.height / 2)
  // The pointer's arrival hasn't reached the app yet: as far as it knows, it's over the composer.
  await composer.dispatchEvent("pointerover")
  await page.mouse.down()
  await page.mouse.up()
  await page.keyboard.type("Room 4", { delay: 60 })
  await expect(inside.locator("#field")).toHaveValue("Room 4")
  await expectTextBox(composer, "Hello")
})

// A message's own HTML can paint over the strip (a decoy with pointer-events: none passes the
// click to the button under it). So the strip's button only asks; the confirmation, outside
// the message, is what allows the scripts.
test("a click through a decoy over the strip doesn't allow a panel's scripts", async ({ page }) => {
  test.setTimeout(180_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const greetingWithDecoy = [
    "Notice.",
    "",
    '<div style="position:relative;height:0"><div style="position:absolute;top:0;left:0;width:100%;height:120px;background:#2a6;color:#fff;pointer-events:none;z-index:50">Continue the story</div></div>',
    "",
    panel("Decoy", "<script>document.body.dataset.ran = 'yes'</script>")
  ].join("\n")
  const imported = await page.request.post(`${server().url}/library/import?name=decoy.json`, {
    data: Buffer.from(
      JSON.stringify({
        spec: "chara_card_v3",
        spec_version: "3.0",
        data: { name: "Decoy card", first_mes: greetingWithDecoy }
      })
    ),
    headers: { origin: server().url, "content-type": "application/octet-stream" }
  })
  expect(imported.status()).toBe(200)
  const { ref } = ((await imported.json()) as { library: { ref: { id: RefId; entityId: EntityId } } }).library
  const plain = await page.request.post(`${server().url}/library/import?name=Decoy-preset.json`, {
    data: Buffer.from(JSON.stringify({ openai_max_context: 8192 })),
    headers: { origin: server().url, "content-type": "application/octet-stream" }
  })
  expect(plain.status()).toBe(200)
  const { ref: preset } = ((await plain.json()) as { library: { ref: { id: RefId } } }).library
  await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.ChangeGenerationDefaults({ change: { preset: preset.id } })
  )
  const started = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.StartChat({
      cards: [ref.entityId],
      persona: null,
      greeting: 0,
      first: { _tag: "Send", content: "Evening.", speakerEntityId: null }
    })
  )
  await page.goto(`${server().url}/chats/${started.chat.id}`)
  const frame = page.locator('iframe[title="Panel"]')
  await expect(page.frameLocator('iframe[title="Panel"]').locator("#marker")).toHaveText("Decoy")
  const run = page.getByRole("button", { name: "Run scripts from Decoy card", exact: true })
  await expect(run).toBeVisible()
  // The user clicks "Continue the story", which is painted over the button.
  const box = (await run.boundingBox())!
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  const confirm = page.getByRole("alertdialog")
  await expect(confirm).toContainText("Run scripts from Decoy card?")
  await expect(frame).toHaveAttribute("src", "/frame/panel")
  await confirm.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(confirm).toHaveCount(0)
  await expect(frame).toHaveAttribute("src", "/frame/panel")
  await expect(page.frameLocator('iframe[title="Panel"]').locator("body")).not.toHaveAttribute("data-ran", "yes")
})

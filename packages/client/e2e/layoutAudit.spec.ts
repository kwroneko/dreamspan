import { draftRequestTests } from "./support/draftRequest.ts"
import { workshopBoundaryTests } from "./support/workshopBoundaries.ts"
import { workshopChatTests } from "./support/workshopChat.ts"
import { workshopApprovalTests } from "./support/workshopApprovals.ts"
import { cardSourceUpdateTests } from "./support/cardSourceUpdates.ts"
import { googleConnectionTests } from "./support/googleConnection.ts"
import { agentResumeTests } from "./support/agentResumeFlows.ts"
import { cardexCriteriaTests } from "./support/cardexCriteria.ts"
import { cardexCreatorTests } from "./support/cardexCreators.ts"
import { cardexLorebookTests } from "./support/cardexLorebooks.ts"
import { exercisePhoneFooters } from "./support/phoneFooters.ts"
import { newflowTests } from "./support/newflows.ts"
import { seedSplitChats } from "./support/splitChats.ts"
import { centerHeaderTests } from "./support/centerHeaders.ts"
import { seedCardArchive } from "./support/cardArchive.ts"
// Run before UI approval: LAYOUT_AUDIT=1 PLAYWRIGHT_WORKERS=1 npx playwright test -c
// packages/client/playwright.config.ts e2e/layoutAudit.spec.ts --project=chromium
// LAYOUT_AUDIT_ST_FOLDER can point to an existing SYNTHETIC fixture only.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, type Locator, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import type { ChatId, EntityId, SlotId, VersionId } from "@rp/shared/chat.ts"
import { findStRoots } from "@rp/shared/stFolder.ts"
import { textField } from "@rp/shared/editing.ts"
import type { RefId } from "@rp/shared/library.ts"
import { layoutAudit, expectLayout } from "./support/layoutAudit.ts"
import { loginCookie, withCookie, type Client } from "./support/rpc.ts"
import { ADMIN, apiLogin, startServer, type TestServer, withAdmin } from "./support/server.ts"
import { startProvider, type FakeProvider } from "./support/provider.ts"
import { closePanel, openPanel, openSummarySettings } from "./support/panel.ts"
import { showAppNavigation, hideAppNavigation } from "./support/appMenu.ts"
import { level1 } from "./support/summaries.ts"
import { modelChip, nextChip, presetChip } from "./support/strip.ts"
import { portraitPng } from "./support/portrait.ts"
import { writeScaleFolder } from "./support/stScaleFolder.ts"
import { writeRealisticStFolder } from "../../server/test/support/stRealistic.ts"
import { modelCatalog } from "./support/modelCatalog.ts"
import { messageMenu } from "./support/message.ts"
import { expectTextBox } from "./support/textbox.ts"

// Opt-in: it imports a large synthetic library and still reports known findings, so the default
// browser suite (`npm run test:browser`, the release gate's `e2e/`) leaves it out.
test.skip(!process.env["LAYOUT_AUDIT"], "the layout audit runs only with LAYOUT_AUDIT=1")
if (process.env.LAYOUT_AUDIT_DRAFT_ONLY === "1") draftRequestTests()
if (process.env.LAYOUT_AUDIT_CARDEX_ONLY === "1") {
  cardexCriteriaTests()
  cardexCreatorTests()
  cardexLorebookTests()
}
if (process.env.LAYOUT_AUDIT_CARDEX_UPDATES_ONLY === "1") cardSourceUpdateTests()
if (process.env.LAYOUT_AUDIT_NEWFLOWS_ONLY === "1") newflowTests()
if (process.env.LAYOUT_AUDIT_WORKSHOP_ONLY === "1") {
  workshopBoundaryTests()
  workshopChatTests()
  workshopApprovalTests()
}
if (process.env.LAYOUT_AUDIT_RESUME_ONLY === "1") agentResumeTests()

test.describe("model picker catalog layout", () => {
  let server: TestServer
  let catalog: Awaited<ReturnType<typeof modelCatalog>>
  let chatId: string
  test.beforeAll(async () => {
    server = await startServer()
    catalog = await modelCatalog()
    chatId = (await withCookie(server, "", catalog.seed)).chat.id
  })
  test.afterAll(async () => {
    await catalog?.stop()
    await server?.stop()
  })
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"] as const)
      test(`${width} ${theme}`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 900 })
        await page.emulateMedia({ colorScheme: theme })
        await page.goto(`${server.url}/chats/${chatId}`)
        await modelChip(page).click()
        await expect(page.getByRole("radiogroup", { name: "Model", exact: true })).toBeVisible()
        await expectLayout(page, info, `model-picker-${width}-${theme}`, { scope: "[data-model-picker]" })
        await page.getByRole("searchbox", { name: "Find a model", exact: true }).fill("story2998")
        await expectLayout(page, info, `model-filtered-${width}-${theme}`, { scope: "[data-model-picker]" })
      })
})

test.use({
  reducedMotion: "reduce",
  // Every finding already has measured evidence and a crop. Repeated snapshots of
  // the scale library make a six-viewport trace needlessly large.
  trace: "off",
  screenshot: "only-on-failure",
  launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"], args: ["--disable-features=OverlayScrollbar"] }
})

// Focused navigation checks use a fresh, synthetic local server.
for (const theme of ["light", "dark"] as const)
  test(`navigation tiles: ${theme}`, async ({ page }, info) => {
    const server = await startServer()
    try {
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.goto(server.url)
      const navigation = page.getByRole("navigation", { name: "Main", exact: true }).filter({ visible: true })
      await expect(navigation).toBeVisible()
      const measurements = []
      for (const size of ["minimum", "default", "maximum", "phone"] as const) {
        if (size === "phone") {
          await page.setViewportSize({ width: 390, height: 900 })
          await showAppNavigation(page)
        } else {
          const grip = page.getByRole("separator", { name: "Resize sidebar", exact: true })
          if (size === "default") await grip.dblclick()
          else {
            await grip.focus()
            await page.keyboard.press(size === "minimum" ? "Home" : "End")
          }
        }
        const links = navigation.locator("a").filter({ has: page.locator("svg") })
        await expect(links).toHaveCount(5)
        for (const link of await links.all()) await expect(link).toBeInViewport()
        await expect
          .poll(async () => {
            const boxes = await links.evaluateAll((elements) => elements.map((el) => el.getBoundingClientRect()))
            const counts = new Map<number, number>()
            for (const box of boxes) counts.set(box.y, (counts.get(box.y) ?? 0) + 1)
            return [...counts.values()].sort().join(",")
          })
          .toBe(size === "minimum" ? "2,3" : "5")
        await expectLayout(page, info, `navtiles-${size}-${theme}`, { scope: 'nav[aria-label="Main"]' })
        const box = await navigation.boundingBox()
        const widths = await links.evaluateAll((elements) => elements.map((el) => el.getBoundingClientRect().width))
        expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(0.1)
        const clipped = await links.evaluateAll((elements) => elements.some((el) => el.scrollWidth > el.clientWidth))
        expect(clipped).toBe(false)
        measurements.push({ size, theme, ...box, widths })
        await navigation.screenshot({ path: info.outputPath(`navtiles-${size}-${theme}.png`) })
      }
      writeFileSync(info.outputPath("tile-widths.json"), JSON.stringify(measurements, null, 2))
      await info.attach("tile widths", {
        body: JSON.stringify(measurements, null, 2),
        contentType: "application/json"
      })
      await page.setViewportSize({ width: 1440, height: 900 })
      await hideAppNavigation(page)
      for (const [label, explanation] of [
        ["Library", "Browse characters, personas, lorebooks and presets."],
        ["Import", "Import characters, chats and library items."],
        ["Settings", "Change your account and app preferences."],
        ["Bin", "Browse deleted items."],
        ["Home", "Open the home page."]
      ]) {
        const link = navigation.getByRole("link", { name: label!, exact: true })
        await link.click()
        await expect(link).toHaveAttribute("data-status", "active")
        await expect(navigation.locator('a[data-status="active"]').filter({ has: page.locator("svg") })).toHaveCount(1)
        await page.mouse.move(0, 0)
        await link.hover()
        await expect(page.getByText(explanation!, { exact: true })).toBeVisible()
        await page.mouse.move(0, 0)
      }
    } finally {
      await server.stop()
    }
  })

// Counted warning above the navigation, in both themes and screen sizes.
for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`footer recovery: ${width} ${theme}`, async ({ page }, info) => {
      const server = await startServer()
      try {
        await page.setViewportSize({ width, height: 900 })
        await page.emulateMedia({ colorScheme: theme })
        await page.goto(server.url)
        await expect(page.getByRole("heading", { name: "Characters", exact: true })).toBeVisible()
        await showAppNavigation(page)
        const nav = page.getByRole("navigation", { name: "Main", exact: true }).filter({ visible: true })
        const warning = nav.getByRole("button", { name: /^\d+ unsaved texts?$/ })
        await expect(warning).toHaveCount(0)
        await expect(nav.getByRole("link", { name: "Account", exact: true })).toHaveCount(0)
        await expectLayout(page, info, `footer-empty-${width}-${theme}`, { scope: 'nav[aria-label="Main"]' })
        const column = width === 390 ? page.locator(".fixed.inset-0") : page.getByRole("complementary").first()
        await column.screenshot({ path: info.outputPath(`left-empty-${width}-${theme}.png`) })
        const user = await withCookie(server, "", (api) => api.Whoami())
        await page.evaluate(async (userId) => {
          const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open("rp-editor-copies", 1)
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
          })
          await new Promise<void>((resolve) => {
            const tx = db.transaction("copies", "readwrite")
            for (const key of ["footer-one", "footer-two"])
              tx.objectStore("copies").put({
                key,
                userId,
                refId: "synthetic",
                field: "description",
                content: "Synthetic unsaved text",
                at: Date.now(),
                ancestors: [],
                save: { kind: "setting", payload: { content: "Synthetic unsaved text" } }
              })
            tx.oncomplete = () => resolve()
          })
          db.close()
          window.dispatchEvent(new Event("rp-browser-copies"))
        }, user.id)
        await expect(warning).toHaveText("2 unsaved texts")
        const tiles = nav.locator("a").first()
        expect((await warning.boundingBox())!.y).toBeLessThan((await tiles.boundingBox())!.y)
        await expectLayout(page, info, `footer-copies-${width}-${theme}`, { scope: 'nav[aria-label="Main"]' })
        await column.screenshot({ path: info.outputPath(`left-copies-${width}-${theme}.png`) })
      } finally {
        await server.stop()
      }
    })

// Account-card logout and the absence of the removed Settings account header.
for (const password of [false, true]) {
  test.describe(`settings account layout ${password ? "session" : "local"}`, () => {
    let accountServer: TestServer
    test.beforeAll(async () => {
      accountServer = await startServer(password ? withAdmin : {})
    })
    test.afterAll(async () => {
      await accountServer?.stop()
    })
    for (const width of [1440, 390])
      for (const theme of ["light", "dark"] as const)
        test(`${width} ${theme}`, async ({ page }, info) => {
          await page.setViewportSize({ width, height: 900 })
          await page.emulateMedia({ colorScheme: theme })
          if (password) await apiLogin(page.request, accountServer, ADMIN.handle, ADMIN.password)
          await page.goto(`${accountServer.url}/settings/account`)
          const account = page.locator("[data-account-page]")
          await expect(account.getByText("Name", { exact: true })).toBeVisible()
          await expect(page.getByRole("region", { name: "Signed-in account", exact: true })).toHaveCount(0)
          await expect(account.getByRole("button", { name: "Log out", exact: true })).toHaveCount(password ? 1 : 0)
          if (width === 1440) {
            const nav = await page.getByRole("navigation", { name: "Settings", exact: true }).boundingBox()
            const content = await account.boundingBox()
            expect(Math.abs(nav!.y - content!.y)).toBeLessThan(1)
          }
          await expectLayout(page, info, `account-${password ? "session" : "local"}-${width}-${theme}`, {
            scope: "[data-account-page]"
          })
          await account
            .locator("../..")
            .screenshot({ path: info.outputPath(`account-${password ? "session" : "local"}-${width}-${theme}.png`) })
          if (password) {
            await account.getByRole("button", { name: "Log out", exact: true }).click()
            await expect(page).toHaveURL(`${accountServer.url}/login`)
          }
        })
  })
}

// Deliberately broken fixtures prove each rule reports measured defects, and the
// exceptions don't hide defects inside an overlay. No app CSS or fixed snapshots.
test("the detector catches geometry defects and respects documented intent", async ({ page }) => {
  await page.setContent(`<style>
    body { margin: 20px; font: 14px Arial; }
    section { border: 1px solid; padding: 12px; margin-bottom: 20px; width: 300px; }
    button { width: 50px; height: 30px; padding: 8px; }
  </style>
  <section id="edge" style="padding:0"><button>Edge</button></section>
  <section><div id="text" style="width:80px;overflow:hidden;white-space:nowrap">A very long clipped sentence without an ellipsis</div></section>
  <section id="gaps" style="display:flex;gap:8px"><button>A</button><button style="margin-left:5px">B</button><button>C</button></section>
  <section id="align" style="display:flex;align-items:center;gap:8px"><button>A</button><button style="transform:translateY(4px)">B</button></section>
  <section id="overlap" style="display:flex"><button>A</button><button style="margin-left:-10px">B</button></section>
  <section id="menu-edge" style="padding:0"><div role="menuitem" tabindex="0">Menu action</div></section>`)
  const found = await layoutAudit(page)
  expect(new Set(found.map((v) => v.kind))).toEqual(new Set(["inset", "text", "gap", "alignment", "overlap"]))
  expect(found.find((v) => v.kind === "inset" && v.related === "#edge")?.measurement).toContain("left 0.00px")
  expect(found.find((v) => v.kind === "alignment")?.measurement).toContain("4.00px")
  expect(found.some((v) => v.kind === "inset" && v.related === "#menu-edge")).toBe(true)
  const scoped = await layoutAudit(page, { scope: "#menu-edge" })
  expect(scoped.length).toBeGreaterThan(0)
  expect(scoped.every((v) => v.related === "#menu-edge")).toBe(true)
  await page.setContent(`<style>body{margin:20px}button{padding:8px}</style>
    <div style="width:60px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Intended ellipsis on this very long text</div>
    <div data-layout-audit-ignore="inset: joined segments share an outer border" style="border:1px solid"><button>A</button></div>
    <button style="position:absolute;top:80px;left:20px">Behind</button>
    <div data-layout-overlay="tooltip floats above the page" style="position:absolute;top:80px;left:20px"><button>Above</button></div>`)
  expect(await layoutAudit(page)).toEqual([])
  await page.locator("[data-layout-overlay]").evaluate((el) => {
    ;(el as HTMLElement).style.cssText += ";border:1px solid;padding:0"
  })
  expect((await layoutAudit(page)).some((v) => v.kind === "inset")).toBe(true)
  // Open shadow roots (the real code editor uses one) aren't invisible to the audit.
  await page.setContent('<div id="host"></div>')
  await page.locator("#host").evaluate((el) => {
    el.attachShadow({ mode: "open" }).innerHTML =
      '<div style="border:1px solid;padding:0"><button>Bad inset</button></div>'
  })
  expect((await layoutAudit(page)).some((v) => v.selector.includes(">>>"))).toBe(true)
  await page.setContent(`<style>body{margin:20px;font:16px Arial}</style>
    <div id="icon-row" style="display:flex;align-items:center;gap:8px">
      <svg width="16" height="16" style="transform:translateY(4px)"><path d="M0 0h16v16H0z" /></svg><span>Label</span>
    </div>
    <div style="position:absolute;top:100px;left:20px"><span>First text</span></div>
    <div style="position:absolute;top:100px;left:25px"><span>Second text</span></div>
    <div id="scroll" style="position:absolute;top:160px;width:180px;height:60px;overflow:auto;border:1px solid">
      <div style="height:120px;padding:12px"><button style="position:relative;left:110px;width:80px">Crosses</button></div>
    </div>`)
  const across = await layoutAudit(page)
  expect(across.some((v) => v.kind === "alignment" && v.selector === "#icon-row")).toBe(true)
  expect(across.some((v) => v.kind === "overlap" && v.measurement.startsWith("content intersection"))).toBe(true)
  expect(across.some((v) => v.kind === "inset" && v.related === "#scroll")).toBe(true)
  await page.setContent('<div data-layout-audit-ignore="inset"><button>Missing reason</button></div>')
  expect((await layoutAudit(page)).some((v) => v.kind === "exception")).toBe(true)
  await page.setContent(`<div id="vertical" style="height:8px;overflow:hidden"><span>Clipped vertically</span></div>
    <div style="display:flex;align-items:center;gap:8px;padding:12px;width:300px">
      <button>First</button><span style="flex:1"></span><button>Second</button><button>Third</button>
    </div>
    <div style="display:flex;align-items:center;gap:8px;padding:12px">
      <button>First</button><button style="opacity:0">Reserved hover action</button><button>Third</button><button>Fourth</button>
    </div>
    <div style="display:flex;align-items:center;gap:8px;padding:12px">
      <button>First</button><span style="display:contents"><button>Second</button></span><button>Third</button><button>Fourth</button>
    </div>
    <div style="display:grid;grid-template-columns:40px 200px auto;align-items:center;gap:8px;padding:12px">
      <div style="grid-row:1/span 2;height:60px">Face</div>
      <span style="grid-column:2;grid-row:1">Title</span><span style="grid-column:2;grid-row:2">Metadata</span>
      <button style="grid-column:3;grid-row:1/span 2">Action</button>
    </div>
    <p style="font:13px monospace;white-space:pre-wrap;width:85px">one two three four five six seven</p>`)
  const clipping = await layoutAudit(page)
  expect(clipping.some((v) => v.kind === "text" && v.related === "#vertical")).toBe(true)
  expect(clipping.every((v) => v.kind !== "gap")).toBe(true)
  expect(clipping.filter((v) => v.kind === "text").every((v) => v.related === "#vertical")).toBe(true)
  // Toggles over a tile's picture, at rest: the archive job's stack (a hidden star keeping its
  // place above the archive, whose backing was its wrapper's, shown though off) is reported;
  // each toggle alone in its corner, backed itself and shown only when pressed, is not.
  const tiles = (toggles: (i: number) => string) => `<style>
      body { margin: 20px; } .grid { display: grid; grid-template-columns: repeat(3, 120px); gap: 8px; }
      .tile { position: relative; } .pic { display: block; height: 180px; background: #888; }
      button { width: 32px; height: 32px; padding: 0; border: 0; background: transparent; }
      .backed { background: rgba(255, 255, 255, 0.85); }
    </style>
    <div class="grid">${[0, 1, 2].map((i) => `<div class="tile"><span class="pic" data-portrait></span>${toggles(i)}</div>`).join("")}</div>`
  await page.setContent(
    tiles(
      (
        i
      ) => `<span data-layout-overlay="toggles" style="position:absolute;top:8px;left:8px;display:flex;flex-direction:column;gap:4px">
        <button class="backed" aria-pressed="${i === 0}" style="opacity:${i === 0 ? 1 : 0}">S</button>
        <span class="backed" style="display:flex"><button aria-label="Archive ${i}">A</button></span></span>`
    )
  )
  const stacked = (await layoutAudit(page)).filter((v) => v.kind === "overlay").map((v) => v.measurement)
  expect(stacked.some((m) => m.startsWith("backing on the wrapper"))).toBe(true)
  expect(stacked.some((m) => m.includes("keeps its space before this control"))).toBe(true)
  expect(stacked.some((m) => m.startsWith("first shown control at 8.00, 8.00px"))).toBe(true)
  expect(stacked.some((m) => m.startsWith("shown at rest"))).toBe(true)
  expect(stacked.some((m) => m.startsWith("hidden, yet takes clicks"))).toBe(true)
  await page.setContent(
    tiles(
      (i) => `<span data-layout-overlay="star" style="position:absolute;top:8px;left:8px;display:flex">
        <button class="backed" aria-pressed="${i === 0}" style="opacity:${i === 0 ? 1 : 0};pointer-events:${i === 0 ? "auto" : "none"}">S</button></span>
        <span data-layout-overlay="archive" style="position:absolute;top:8px;right:8px;display:flex">
        <button class="backed" aria-pressed="${i === 1}" style="opacity:${i === 1 ? 1 : 0};pointer-events:${i === 1 ? "auto" : "none"}">A</button></span>`
    )
  )
  expect((await layoutAudit(page)).filter((v) => v.kind === "overlay")).toEqual([])
})

test("picture overlays exclude page positioners and portalled popups, but audit their contents", async ({ page }) => {
  await page.setContent(`<style>
    body { margin: 20px; }
    [data-portrait] { display: block; width: 120px; height: 180px; }
    button { width: 32px; height: 32px; padding: 0; border: 0; background: transparent; }
    .popup { padding: 12px; background: white; }
  </style>
  <span data-portrait></span>
  <div data-layout-overlay="Page positioner" style="position:absolute;top:20px;left:20px">
    <div class="popup"><button>Page</button></div>
  </div>
  <div style="position:relative">
    <div data-base-ui-portal>
      <div data-layout-overlay="Portalled positioner" style="position:absolute;top:0;left:0">
        <div class="popup" role="dialog"><span data-portrait></span><button>Pick</button>
          <div style="position:relative">
            <span data-portrait></span>
            <button id="local" data-layout-overlay="Local portrait toggle" style="position:absolute;top:8px;left:8px">S</button>
          </div>
        </div>
      </div>
    </div>
  </div>`)
  // The popup is portalled into a positioned container rather than document.body.
  // Its local portrait toggle still needs a backing; skipping a portal's whole subtree
  // would hide that real defect.
  expect((await layoutAudit(page)).filter((v) => v.kind === "overlay")).toEqual([
    expect.objectContaining({ selector: "#local", measurement: "no backing of its own over the picture" })
  ])
  await page.locator("#local").evaluate((el) => (el.style.background = "white"))
  expect((await layoutAudit(page)).filter((v) => v.kind === "overlay")).toEqual([])
  await page.locator('[role="dialog"]').evaluate((el) => {
    el.style.padding = "0"
    el.style.border = "1px solid"
  })
  expect((await layoutAudit(page)).some((v) => v.kind === "inset")).toBe(true)
})

test("picture overlays report hidden space between visible controls", async ({ page }) => {
  await page.setContent(`<style>
    body { margin: 20px; }
    .tile { position: relative; width: 120px; }
    .pic { display: block; height: 180px; background: #888; }
    button { width: 32px; height: 32px; border: 0; background: white; }
  </style>
  <div class="tile"><span class="pic" data-portrait></span>
    <span data-layout-overlay="toggles" style="position:absolute;top:8px;left:8px;display:flex;flex-direction:column;gap:4px">
      <button aria-pressed="true">S</button>
      <button id="hidden" style="opacity:0;pointer-events:none">H</button>
      <button id="archive" aria-pressed="true">A</button>
    </span>
  </div>`)
  expect((await layoutAudit(page)).filter((v) => v.kind === "overlay")).toEqual([
    expect.objectContaining({
      selector: "#archive",
      related: "#hidden",
      measurement: "hidden #hidden keeps its space before this control"
    })
  ])
  await page.locator("#hidden").evaluate((el) => (el.style.display = "none"))
  expect((await layoutAudit(page)).filter((v) => v.kind === "overlay")).toEqual([])
})

test("picture overlay controls are audited when they carry the overlay marker", async ({ page }) => {
  await page.setContent(`<style>
    body { margin: 20px; }
    .grid { display: grid; grid-template-columns: 120px; }
    .tile { position: relative; }
    .pic { display: block; height: 180px; background: #888; }
    button { width: 32px; height: 32px; border: 0; background: transparent; }
  </style>
  <div class="grid"><div class="tile"><span class="pic" data-portrait></span>
    <button id="star" data-layout-overlay="star" aria-pressed="false" style="position:absolute;top:8px;left:8px">S</button>
  </div></div>`)
  const measurements = async () =>
    (await layoutAudit(page)).filter((v) => v.kind === "overlay").map((v) => v.measurement)
  expect(await measurements()).toContain("no backing of its own over the picture")
  const star = page.locator("#star")
  await star.evaluate((el) => (el.style.background = "white"))
  expect(await measurements()).toContain("shown at rest though not a pressed toggle (hover or focus should reveal it)")
  await star.evaluate((el) => (el.style.opacity = "0"))
  expect(await measurements()).toContain("hidden, yet takes clicks meant for the picture under it")
  await star.evaluate((el) => (el.style.pointerEvents = "none"))
  expect(await measurements()).toEqual([])
  await star.evaluate((el) => {
    el.style.opacity = "1"
    el.style.pointerEvents = "auto"
    el.setAttribute("aria-pressed", "true")
  })
  expect(await measurements()).toEqual([])
})

const work = process.env.LAYOUT_AUDIT_WORK ?? mkdtempSync(join(tmpdir(), "rp-layout-audit-"))
const selected = new RegExp(process.env.LAYOUT_AUDIT_SURFACES ?? ".*")
const avatarStackNames = ["Double Capitals", "Other 1", "Other 3", "Wide WWW", "ß ß", "Hidden Willow"]
// Surfaces to keep a whole-window screenshot of, for before-and-after evidence (shots/ in the work folder).
const shots = process.env.LAYOUT_AUDIT_SHOTS ? new RegExp(process.env.LAYOUT_AUDIT_SHOTS) : null

// Inspect content below the fold as well as the initial viewport. Message history
// and editable field interiors have separate tests; don't page a 188k-message timeline.
async function sampleScrollEnds(page: Page, check: (suffix: string) => Promise<void>) {
  const count = await page.evaluate(() => {
    const scrolls = [
      ...document.querySelectorAll<HTMLElement>("main, main *, aside, aside *, [role=dialog], [role=dialog] *")
    ].filter((el) => {
      const s = getComputedStyle(el),
        r = el.getBoundingClientRect()
      return (
        el.checkVisibility() &&
        r.height > 120 &&
        r.width > 80 &&
        r.top < innerHeight &&
        r.bottom > 0 &&
        /auto|scroll/.test(s.overflowY) &&
        el.scrollHeight > el.clientHeight + 1 &&
        !el.closest('[data-testid="messages"]') &&
        !el.matches("textarea, [contenteditable]")
      )
    })
    scrolls.forEach((el, i) => el.setAttribute("data-layout-audit-scroll", String(i)))
    return scrolls.length
  })
  for (let i = 0; i < count; i++) {
    const box = page.locator(`[data-layout-audit-scroll="${i}"]`)
    const original = await box.evaluate((el) => el.scrollTop)
    await box.evaluate((el) => {
      el.scrollTop = el.scrollHeight
    })
    await check(`-scroll-${i}-end`)
    await box.evaluate((el, top) => {
      el.scrollTop = top
    }, original)
  }
  await page
    .locator("[data-layout-audit-scroll]")
    .evaluateAll((els) => els.forEach((el) => el.removeAttribute("data-layout-audit-scroll")))
}

test.describe("synthetic library and every app surface", () => {
  test.skip(!!process.env.LAYOUT_AUDIT_CENTERHEADER_ONLY, "Focused center headers")
  test.describe.configure({ mode: "default" })

  let server: TestServer
  let provider: FakeProvider
  let chatId: ChatId, cardId: EntityId, cardRef: RefId, presetRef: RefId, bookRef: RefId, replyId: VersionId
  let connectionId = "",
    cardName = "",
    cookie = ""
  const admin = <A>(use: (api: Client) => Effect.Effect<A, unknown>) => withCookie(server, cookie, use)
  test.beforeAll(async () => {
    test.setTimeout(3_600_000)
    mkdirSync(work, { recursive: true })
    server = await startServer({
      ...withAdmin,
      DATA_DIR: join(work, "data"),
      ...(process.env.LAYOUT_AUDIT_CLIENT_DIST ? { CLIENT_DIST: process.env.LAYOUT_AUDIT_CLIENT_DIST } : {})
    })
    provider = await startProvider()
    cookie = await loginCookie(server, ADMIN.handle, ADMIN.password)
    const cards = await admin((api) => api.ListLibrary({ kind: "card" }))
    if (
      (cards.length < 422 || !existsSync(join(work, "scale-import-complete"))) &&
      process.env.LAYOUT_AUDIT_SMALL !== "1"
    ) {
      // dataset.md's archived fixture may have been pruned; regenerate from the
      // checked-in synthetic generator rather than silently auditing an empty app.
      const folder = process.env.LAYOUT_AUDIT_ST_FOLDER ?? join(work, "synthetic-scale")
      if (process.env.LAYOUT_AUDIT_ST_FOLDER && !existsSync(folder))
        throw new Error(`Synthetic fixture is missing: ${folder}`)
      if (!process.env.LAYOUT_AUDIT_ST_FOLDER) {
        if (!existsSync(join(folder, "data/default-user/settings.json")))
          writeScaleFolder(folder, { cards: 422, chats: 2102, longChats: 3, groups: 20 })
        // Match dataset.md's message scale. The general generator has a heavier
        // long tail; thin only this job's freshly generated synthetic chat files.
        if (!existsSync(join(work, "scale-sized"))) {
          const user = join(folder, "data/default-user")
          const files = ["chats", "group chats"].flatMap((dir) =>
            readdirSync(join(user, dir), { recursive: true, encoding: "utf8" })
              .filter((name) => name.endsWith(".jsonl"))
              .map((name) => join(user, dir, name))
          )
          const chats = files.map((path) => ({ path, lines: readFileSync(path, "utf8").trimEnd().split("\n") }))
          const total = chats.reduce((sum, c) => sum + c.lines.length - 1, 0)
          const budget = Math.min(188000, total)
          const counts = chats.map((c) => Math.max(1, Math.floor(((c.lines.length - 1) * budget) / total)))
          let left = budget - counts.reduce((sum, n) => sum + n, 0)
          for (const [i, c] of chats.entries())
            if (left > 0 && counts[i]! < c.lines.length - 1) {
              counts[i]!++
              left--
            }
          expect(left).toBe(0)
          for (const [i, c] of chats.entries())
            writeFileSync(c.path, c.lines.slice(0, counts[i]! + 1).join("\n") + "\n")
          writeFileSync(
            join(work, "scale-fixture.json"),
            JSON.stringify({ cards: 422, chats: files.length, groups: 20, messages: budget }, null, 2)
          )
          writeFileSync(join(work, "scale-sized"), "complete\n")
        }
      }
      const scanned = await admin((api) => api.ScanStFolder({ path: folder }))
      const prefix = findStRoots(scanned.files.map((f) => f.path))[0]?.prefix
      expect(prefix, "synthetic fixture contains an ST user folder").toBeDefined()
      const job = await admin((api) => api.StartStPathImport({ path: scanned.root, prefix: prefix! }))
      await expect
        .poll(async () => (await admin((api) => api.GetStImport({ importId: job.importId }))).job.status, {
          timeout: 3_000_000,
          intervals: [2000, 5000]
        })
        .not.toBe("running")
      expect((await admin((api) => api.GetStImport({ importId: job.importId }))).job.status).toBe("complete")
      await admin((api) => api.SeenStImport({ importId: job.importId }))
      writeFileSync(join(work, "scale-import-complete"), "complete\n")
    }
    // Rich realistic cards, presets and books supplement the bulk scale fixture.
    if (!(await admin((api) => api.ListLibrary({ kind: "preset" }))).length) {
      const folder = writeRealisticStFolder(join(work, "synthetic-realistic"))
      const job = await admin((api) => api.StartStPathImport({ path: folder, prefix: "" }))
      await expect
        .poll(async () => (await admin((api) => api.GetStImport({ importId: job.importId }))).job.status, {
          timeout: 300_000,
          intervals: [1000, 3000]
        })
        .toBe("complete")
      await admin((api) => api.SeenStImport({ importId: job.importId }))
    }
    if (process.env.LAYOUT_AUDIT_SMALL !== "1") {
      // The archived dataset also has 43 books and 15 personas. The general scale
      // generator starts with fewer; bring the fallback up to that scale too.
      const books = await admin((api) => api.ListLibrary({ kind: "lorebook" }))
      for (let i = books.length; i < 43; i++) {
        const response = await fetch(`${server.url}/library/import?name=Layout%20world%20${i}.json`, {
          method: "POST",
          headers: { cookie, origin: server.url, "content-type": "application/octet-stream" },
          body: JSON.stringify({ entries: { "0": { uid: 0, key: ["harbour"], content: `Synthetic harbour ${i}.` } } })
        })
        expect(response.ok).toBe(true)
      }
      await admin((api) =>
        Effect.gen(function* () {
          const personas = (yield* api.ListCards()).filter((card) => card.persona).length
          for (let i = personas; i < 15; i++) {
            const card = yield* api.CreateCard({ label: `Layout persona ${i}`, name: `Layout persona ${i}` })
            yield* api.SetPersona({ entityId: card.entityId, persona: true })
          }
          expect((yield* api.ListCards()).filter((card) => card.persona).length).toBeGreaterThanOrEqual(15)
          expect((yield* api.ListLibrary({ kind: "lorebook" })).length).toBeGreaterThanOrEqual(43)
        })
      )
    }
    if (process.env.LAYOUT_AUDIT_AVATAR_STACKS_ONLY === "1") {
      await admin((api) =>
        Effect.gen(function* () {
          for (const name of avatarStackNames) yield* api.CreateCard({ label: name, name })
        })
      )
    }
    const seeded = await admin((api) =>
      Effect.gen(function* () {
        const cards = yield* api.ListLibrary({ kind: "card" })
        const a = cards.find((c) => c.label === "Aria Vance") ?? cards[0]!
        const b = cards.find((c) => c.entityId !== a.entityId)!
        const overflowCards =
          process.env.LAYOUT_AUDIT_AVATAR_STACKS_ONLY === "1"
            ? (yield* api.ListCards()).filter((card) => avatarStackNames.includes(card.name))
            : []
        const preset = (yield* api.ListLibrary({ kind: "preset" }))[0]!
        const book = (yield* api.ListLibrary({ kind: "lorebook" }))[0]!
        const connection = yield* api.CreateConnection({
          kind: "openai-chat",
          settings: {
            name: "Layout model",
            baseUrl: provider.baseUrl,
            compat: {},
            cacheTtlS: null,
            maxConcurrent: null,
            presetOverrideRefId: null
          },
          apiKey: "sk-layout-synthetic-key"
        })
        const model = yield* api.AddUserModel({ connectionId: connection.id, key: "fake-small", overrides: {} })
        yield* api.SetGenerationDefaults({
          defaults: {
            model: { connection: connection.id, model: model.id },
            preset:
              process.env.LAYOUT_AUDIT_CARDHISTORY_ONLY === "1" ||
              process.env.LAYOUT_AUDIT_PRESETS_ONLY === "1" ||
              process.env.LAYOUT_AUDIT_PROMPTROWS_ONLY === "1" ||
              process.env.LAYOUT_AUDIT_SAVEFLOW_ONLY === "1" ||
              process.env.LAYOUT_AUDIT_SEARCHREPLACE_ONLY === "1" ||
              process.env.LAYOUT_AUDIT_SMALLFIXES4_ONLY === "1" ||
              process.env.LAYOUT_AUDIT_SMALLFIXES5_ONLY === "1"
                ? preset.id
                : null
          }
        })
        const started = yield* api.StartChat({
          cards:
            process.env.LAYOUT_AUDIT_AVATAR_STACKS_ONLY === "1"
              ? overflowCards.map((card) => card.entityId)
              : [a.entityId, b.entityId],
          persona: null,
          greeting: null,
          first: { _tag: "Send", content: "A synthetic group gathers at the harbour.", speakerEntityId: null }
        })
        yield* api.ChangeCast({
          chatId: started.chat.id,
          slotId: null,
          change: { _tag: "Lorebook", ref: book.id, active: true }
        })
        yield* api.CreateChatNote({ chatId: started.chat.id, title: "Author's Note" })
        yield* api.CreateCardNote({
          cardRefId: a.id,
          title: "Character's Note",
          chatNote: { chatId: started.chat.id, slotId: null }
        })
        const reply = yield* api.Generate({
          chatId: started.chat.id,
          parentSlotId: started.entry.slotId,
          branch: false
        })
        if (reply._tag !== "Posted") throw new Error("fixture reply queued")
        yield* api.CreateFork({ chatId: started.chat.id, fromForkId: null, atSlotId: started.entry.slotId })
        if (process.env.LAYOUT_AUDIT_CHAT_ROWS_ONLY === "1") {
          const forks = yield* api.ListForks({ chatId: started.chat.id })
          yield* api.PinFork({ forkId: forks[0]!.id, pinned: true })
          yield* api.SetChatPin({ chatId: started.chat.id, leaf: null, pinned: true })
        }
        return {
          chatId: started.chat.id,
          cardId: a.entityId,
          cardName: a.label,
          cardRef: a.id,
          presetRef: preset.id,
          bookRef: book.id,
          replyId: reply.entry.version.id,
          connectionId: connection.id,
          entries: (yield* api.ReadPath({
            chatId: started.chat.id,
            leafSlotId: null,
            range: { _tag: "Bottom" },
            limit: 100
          })).entries
        }
      })
    )
    ;({ chatId, cardId, cardRef, presetRef, bookRef, replyId, connectionId, cardName } = seeded)
    if (process.env.LAYOUT_AUDIT_PICTURECROP_ONLY === "1") {
      const ref = await admin((api) => api.OpenEditor({ refId: cardRef }))
      const response = await fetch(`${server.url}/library/avatar?ref=${cardRef}&rowVersion=${ref.ref.rowVersion}`, {
        method: "POST",
        headers: { cookie, "content-type": "application/octet-stream" },
        body: portraitPng()
      })
      expect(response.ok).toBe(true)
    }
    // Populate the shared Extra-tab gallery for its grid audit, at both panel widths.
    for (const [index, name] of ["Alternative coat", "Happy", "Harbor", "Evening"].entries()) {
      const ref = await admin((api) => api.OpenEditor({ refId: cardRef }))
      const response = await fetch(
        `${server.url}/library/gallery?ref=${cardRef}&rowVersion=${ref.ref.rowVersion}&name=${encodeURIComponent(name)}`,
        {
          method: "POST",
          headers: { cookie, "content-type": "application/octet-stream" },
          body: portraitPng([], index)
        }
      )
      expect(response.status).toBe(200)
      if (index < 3)
        await admin((api) =>
          Effect.gen(function* () {
            const opened = yield* api.OpenEditor({ refId: cardRef })
            const images = yield* api.GetCardGallery({ refId: cardRef })
            yield* api.ChangeCardAsset({
              refId: cardRef,
              expectedRowVersion: opened.ref.rowVersion,
              uri: images.images.at(-1)!.uri,
              change: { action: "kind", kind: (["icon", "emotion", "background"] as const)[index]! }
            })
          })
        )
    }

    await level1(
      join(work, "data"),
      chatId,
      seeded.entries.slice(0, Math.max(1, seeded.entries.length - 1)),
      "The group met by the harbour to read a synthetic ledger."
    )
  })
  test.afterAll(async () => {
    await server?.stop()
    await provider?.stop()
    if (!process.env.LAYOUT_AUDIT_WORK) rmSync(work, { recursive: true, force: true })
  })

  for (const width of process.env.LAYOUT_AUDIT_WIDTHS?.split(",").map(Number) ?? [1440, 1024, 390])
    for (const theme of ["light", "dark"] as const) {
      test(`${width} ${theme}: all surfaces`, async ({ page }, info) => {
        test.setTimeout(1_800_000)
        page.setDefaultTimeout(15000)
        await page.setViewportSize({ width, height: 900 })
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
        await apiLogin(page.request, server, ADMIN.handle, ADMIN.password)
        const findings: unknown[] = []
        const audit = async (surface: string, scope?: string) => {
          if (!selected.test(surface)) return
          await expect(page.getByRole("status").filter({ hasText: /^(Loading|Still loading)/ })).toHaveCount(0, {
            timeout: 30000
          })
          const inspect = async (suffix = "") => {
            const violations = await expectLayout(
              page,
              info,
              surface + suffix,
              scope
                ? { scope }
                : process.env.LAYOUT_AUDIT_CHAT_ROWS_ONLY === "1"
                  ? { scope: '[data-fork-row], [aria-label="Chat filters and sorting"]' }
                  : process.env.LAYOUT_AUDIT_SNIPPETS_ONLY === "1"
                    ? { scope: '[role="tabpanel"], [role="dialog"]' }
                    : process.env.LAYOUT_AUDIT_HISTORY_ONLY === "1"
                      ? { scope: "[data-history-panel]" }
                      : process.env.LAYOUT_AUDIT_SUMMARY_SETTINGS_ONLY === "1"
                        ? {
                            scope: surface.startsWith("panel-")
                              ? 'section[aria-label="Summary settings"]'
                              : 'section[aria-label="Models for summaries"], section[aria-label="Summary defaults for new chats"]'
                          }
                        : process.env.LAYOUT_AUDIT_REPLY_SETTINGS_ONLY === "1"
                          ? { scope: 'section[aria-label="Who replies"]' }
                          : process.env.LAYOUT_AUDIT_LOREBOOKS_ONLY === "1"
                            ? { scope: "[data-lorebook-audit]" }
                            : process.env.LAYOUT_AUDIT_EXPORT_MENUS_ONLY === "1"
                              ? { scope: '[role="menu"]' }
                              : {}
            )
            console.log(`${width} ${theme} ${surface + suffix}: ${violations.length} violations`)
            findings.push({ surface: surface + suffix, violations })
            writeFileSync(join(work, `findings-${width}-${theme}.json`), JSON.stringify(findings, null, 2))
          }
          if (shots?.test(surface)) {
            const bounds =
              process.env.LAYOUT_AUDIT_HISTORY_ONLY === "1"
                ? await page.locator("[data-history-panel]").boundingBox()
                : null
            const viewport = page.viewportSize()!
            const clip = bounds
              ? {
                  x: Math.max(0, bounds.x),
                  y: Math.max(0, bounds.y),
                  width: Math.min(viewport.width, bounds.x + bounds.width) - Math.max(0, bounds.x),
                  height: Math.min(viewport.height, bounds.y + bounds.height) - Math.max(0, bounds.y)
                }
              : null
            await page.screenshot({
              path: join(work, "shots", `${width}-${theme}-${surface.replace(/\W+/g, "-")}.png`),
              ...(clip ? { clip } : {})
            })
          }
          await inspect()
          await sampleScrollEnds(page, inspect)
        }
        const go = async (surface: string, path: string) => {
          await page.goto(`${server.url}${path}`)
          await expect(page.locator("main")).toBeVisible()
          await expect(page.getByRole("main").getByRole("heading").first()).toBeVisible({ timeout: 30000 })
          await audit(surface)
        }
        if (process.env.LAYOUT_AUDIT_SUITEFIX2_ONLY === "1") {
          await go("suitefix2-pending", `/cards/${cardId}/chat`)
          const cast = await openPanel(page, "Cast")
          await cast.getByRole("button", { name: /^Playing as / }).click()
          await page.getByRole("tab", { name: "All cards", exact: true }).click()
          await page.getByRole("combobox", { name: "Find a card to play as" }).fill(cardName)
          const picker = page.getByRole("dialog", { name: "Your persona", exact: true })
          await expect(picker.getByRole("option", { name: cardName, exact: true })).toBeVisible()
          await audit("suitefix2-persona-picker", '[role="dialog"]:has([aria-label="Find a card to play as"])')
          await picker.getByRole("option", { name: cardName, exact: true }).click()
          await audit("suitefix2-pending-cast", '[role="tabpanel"][aria-label="Cast"]')
          await closePanel(page)

          const long = Array.from(
            { length: 40 },
            (_, i) => `Paragraph ${i}. ${"A long synthetic turn. ".repeat(8)}`
          ).join("\n\n")
          const sent = await admin((api) =>
            Effect.gen(function* () {
              const chat = yield* api.CreateChat({ title: "Long editor footer audit" })
              const sent = yield* api.SendMessage({
                chatId: chat.id,
                parentSlotId: null,
                branch: false,
                content: long,
                reply: false
              })
              if (sent._tag !== "Posted") return yield* Effect.die("unexpected queue")
              return { chat, entry: sent.entry }
            })
          )
          await page.goto(`${server.url}/chats/${sent.chat.id}?slot=${sent.entry.slotId}`)
          const row = page.locator(`article[data-slot="${sent.entry.slotId}"]`)
          await messageMenu(row, "Edit")
          await expectTextBox(row.getByRole("textbox", { name: "Message text", exact: true }), long)
          const cancel = row.getByRole("button", { name: "Cancel", exact: true })
          await expect(cancel).toBeInViewport()
          await audit("suitefix2-message-footer", '[data-testid="messages"]')
          await expect(cancel).toBeInViewport()
          return
        }
        if (process.env.LAYOUT_AUDIT_NOSTARTCHAT_ONLY === "1") {
          await go("nostartchat-home", "/?side=characters")
          await audit("nostartchat-home-grid", 'main [aria-label="Characters"]')
          await showAppNavigation(page)
          const navigation = width < 1024 ? ".fixed.inset-0" : "aside"
          await audit("nostartchat-sidebar", navigation)
          await hideAppNavigation(page)
          await go("nostartchat-library", "/library")
          await expect(page.getByRole("list", { name: "Cards", exact: true })).toBeVisible()
          await audit("nostartchat-library-list", 'main [aria-label="Cards"]')
          return
        }
        if (process.env.LAYOUT_AUDIT_GUIDANCE_ONLY === "1") {
          const scope = '.chat-column:has([data-testid="composer"])'
          await page.goto(`${server.url}/chats/${chatId}`)
          const toggle = page.getByRole("switch", { name: "Guidance", exact: true })
          await expect(toggle).toBeEnabled()
          if (await toggle.isChecked()) await toggle.click()
          await expect(toggle).not.toBeChecked()
          await audit("composer-message", scope)
          await toggle.click()
          await expect(toggle).toBeChecked()
          await audit("composer-guidance", scope)
          await page.goto(`${server.url}/cards/${cardId}/chat`)
          await expect(toggle).toBeEnabled()
          await audit("pending-message", scope)
          await toggle.click()
          await expect(toggle).toBeChecked()
          await audit("pending-guidance", scope)
          return
        }
        if (process.env.LAYOUT_AUDIT_ADDCHARS_ONLY === "1") {
          await go("addchars-chat", `/chats/${chatId}`)
          await openPanel(page, "Cast")
          const add = page.getByRole("button", { name: "Add characters", exact: true })
          if ((await add.getAttribute("aria-expanded")) !== "true") await add.click()
          await audit("addchars-grid", '[aria-label="Characters"]')
          return
        }
        if (process.env.LAYOUT_AUDIT_PICTURECROP_ONLY === "1") {
          await page.goto(`${server.url}/chats/${chatId}`)
          const card = await openPanel(page, cardName)
          await card.getByRole("button", { name: "Picture", exact: true }).click()
          await expect(page.locator("[data-cutout-box]")).toBeVisible()
          const dialog = page.getByRole("dialog")
          for (const tab of ["Picture", "Portrait"]) {
            await dialog.getByRole("button", { name: tab, exact: true }).click()
            await audit(`dialog-picture-${tab.toLowerCase()}`, '[role="dialog"]')
            await dialog.screenshot({ path: join(work, `${width}-${theme}-${tab.toLowerCase()}.png`) })
          }
          return
        }
        if (process.env.LAYOUT_AUDIT_HTML_MESSAGES_ONLY === "1") {
          await page.goto(`${server.url}/chats/${chatId}`)
          await openPanel(page, "This chat")
          await audit("html-chat-settings", '[role="tabpanel"][aria-label="This chat"]')
          await openPanel(page, "Interface")
          await audit("html-interface", '[role="tabpanel"][aria-label="Interface"]')
          await openPanel(page, cardName)
          await page.getByRole("tab", { name: "Extra", exact: true }).click()
          await audit("html-card-panel", '[data-card-tabs] [role="tabpanel"]')
          await page.goto(`${server.url}/library/${cardRef}`)
          await page.getByRole("tab", { name: "Extra", exact: true }).click()
          await audit("html-card-editor")
          return
        }
        if (process.env.LAYOUT_AUDIT_INTERFACE_ONLY === "1") {
          await page.goto(`${server.url}/chats/${chatId}`)
          await openPanel(page, "Interface")
          const tabs = page.getByRole("tablist", { name: "Chat panel", exact: true })
          await expect(tabs.getByRole("tab", { name: "Interface", exact: true })).toBeVisible()
          const bar = tabs.locator("../..")
          await bar.evaluate((element) => element.setAttribute("data-interface-tabs-audit", ""))
          await bar.screenshot({ path: join(work, `${width}-${theme}-interface-tabs.png`) })
          await audit("interface-tab-bar", "[data-interface-tabs-audit]")
          return
        }
        if (process.env.LAYOUT_AUDIT_SUMMARY_SETTINGS_ONLY === "1") {
          await admin((api) => api.ChangeLcmSettings({ chatId, change: { withPreset: "specific", preset: presetRef } }))
          await page.goto(`${server.url}/chats/${chatId}`)
          const section = await openSummarySettings(page)
          await expect(section.getByRole("button", { name: "Preset for summaries", exact: true })).toBeVisible()
          await audit("panel-summary-settings")
          await admin((api) =>
            api.ChangeGenerationDefaults({ change: { lcm: { withPreset: "specific", preset: presetRef } } })
          )
          await go("settings-chats", "/settings/chats")
          return
        }
        if (process.env.LAYOUT_AUDIT_SMALLFIXES5_ONLY === "1") {
          await page.goto(`${server.url}/chats/${chatId}`)
          const card = await openPanel(page, cardName)
          await expect(card.locator("[data-card-tokens]")).toBeVisible()
          await audit("panel-card-header", "[data-card-header]")
          const preset = await openPanel(page, "Prompt preset")
          await expect(preset.getByRole("list", { name: "Preset blocks" })).toBeVisible()
          await audit("panel-preset", '[aria-label="Preset blocks"], [aria-label="Prompt order"]')
          await preset.getByRole("link", { name: "Open the preset in the large editor", exact: true }).click()
          await expect(page.getByRole("region", { name: "Preset editor", exact: true })).toBeVisible()
          await audit("large-preset", '[aria-label="Preset blocks"], [aria-label="Prompt order"]')
          return
        }
        if (process.env.LAYOUT_AUDIT_SMALLFIXES4_ONLY === "1") {
          await page.goto(`${server.url}/library/${cardRef}`)
          await expect(page.getByRole("button", { name: "About Description", exact: true })).toBeVisible()
          await audit("card-definition", "[data-card-tabs] [role=tabpanel]")
          await page.goto(`${server.url}/chats/${chatId}`)
          const card = await openPanel(page, cardName)
          await expect(card.locator("[data-card-tokens]")).toBeVisible()
          await audit("panel-card-header", "[data-card-header]")
          await audit("panel-card-definition", "[data-card-tabs] [role=tabpanel]")
          const preset = await openPanel(page, "Prompt preset")
          await expect(preset.getByRole("list", { name: "Preset blocks" })).toBeVisible()
          await expect(preset.locator("[data-note-slot]").first()).toBeVisible()
          await audit("panel-preset-notes", "[data-note-slot]")
          return
        }
        if (process.env.LAYOUT_AUDIT_COPY_ONLY === "1") {
          await go("home-copy", "/")
          await go("library-copy", "/library")
          await go("card-copy", `/cards/${cardId}`)
          await go("card-editor-copy", `/library/${cardRef}`)
          await go("preset-editor-copy", `/library/${presetRef}`)
          await go("chat-copy", `/chats/${chatId}`)
          for (const tab of ["This chat", "Lorebooks", "Notes", "Summaries", "History edits"]) {
            await openPanel(page, tab)
            await audit(`panel-${tab}-copy`)
          }
          for (const section of ["costs", "regex"]) await go(`settings-${section}-copy`, `/settings/${section}`)
          return
        }
        if (process.env.LAYOUT_AUDIT_HELP_ONLY === "1") {
          await go("group-chat", `/chats/${chatId}`)
          await openPanel(page, "Lorebooks")
          await audit("panel-Lorebooks")
          await openSummarySettings(page)
          await audit("panel-summary-settings")
          await go("preset-editor", `/library/${presetRef}`)
          await go("card-editor", `/library/${cardRef}`)
          for (const section of ["chats", "display", "costs"]) await go(`settings-${section}`, `/settings/${section}`)
          return
        }
        if (process.env.LAYOUT_AUDIT_SETTINGS_ONLY === "1") {
          for (const section of [
            "connections",
            "keys",
            "network",
            "costs",
            "chats",
            "interface",
            "regex",
            "notifications",
            "account",
            "users",
            "status"
          ]) {
            await go(`settings-${section}`, `/settings/${section}`)
          }
          await go("bin", "/bin")
          await page.getByText("Bin capacity", { exact: true }).click()
          await audit("bin-capacity")
          for (const path of ["/import", "/import/st"]) await go(path.slice(1).replaceAll("/", "-"), path)
          return
        }
        if (process.env.LAYOUT_AUDIT_IMPORT_ONLY === "1") {
          await go("import-st", "/import/st")
          await page.getByRole("button", { name: "Import ST data again" }).click()
          await expect(page.getByLabel("Folder path")).toBeVisible()
          await audit("import-st-form")
          return
        }
        if (process.env.LAYOUT_AUDIT_DEFAULT_PERSONA_ONLY === "1") {
          const persona = await admin((api) =>
            Effect.gen(function* () {
              const card = (yield* api.ListCards()).find((card) => card.persona)!
              const ref = (yield* api.ListLibrary({ kind: "card" })).find((ref) => ref.entityId === card.entityId)!
              yield* api.ChangeGenerationDefaults({ change: { persona: card.entityId } })
              return { card, ref }
            })
          )
          await go("default-library-list", "/library?show=personas")
          await page
            .getByRole("button", {
              name: `More actions for ${persona.ref.label}`,
              exact: true
            })
            .click()
          await audit("default-library-menu")
          await go("default-library-grid", "/library?show=personas&view=grid")
          await go("default-home", "/?show=personas")
          await showAppNavigation(page)
          await page
            .getByRole("group", { name: "Left panel", exact: true })
            .getByRole("button", { name: "Characters", exact: true })
            .click()
          const leftShow = page.getByRole("combobox", { name: "Show", exact: true })
          await leftShow.click()
          await page.getByRole("option", { name: /^Personas/ }).click()
          await audit("default-sidebar")
          await hideAppNavigation(page)
          await go("default-card", `/cards/${persona.card.entityId}`)
          await go("default-editor", `/library/${persona.ref.id}`)
          await page.getByRole("button", { name: "More actions", exact: true }).click()
          await audit("default-editor-menu")
          await go("default-pending", `/cards/${cardId}/chat`)
          await openPanel(page, "Cast")
          await audit("default-pending-cast")
          await page.getByRole("button", { name: /^Playing as / }).click()
          await audit("default-persona-picker")
          await page
            .getByRole("option", { name: persona.card.name, exact: true })
            .getByRole("button", { name: /^Persona actions for/ })
            .click()
          await audit("default-persona-menu")
          await page.keyboard.press("Escape")
          await page.keyboard.press("Escape")
          await closePanel(page)
          await go("default-chat", `/chats/${chatId}`)
          await openPanel(page, "Cast")
          const add = page.getByRole("button", { name: "Add characters", exact: true })
          if ((await add.getAttribute("aria-expanded")) !== "true") await add.click()
          const section = page.getByRole("region", { name: "Add characters", exact: true })
          await section.getByRole("combobox", { name: "Show" }).click()
          await page.getByRole("option", { name: /^Personas/ }).click()
          await audit("default-add-characters")
          await closePanel(page)
          await page.getByRole("button", { name: /^Speaking as / }).click()
          await audit("default-speaker-picker")
          return
        }
        if (process.env.LAYOUT_AUDIT_SPLITLINK_ONLY === "1") {
          const branch = await admin((api) =>
            Effect.gen(function* () {
              const forks = yield* api.ListForks({ chatId })
              const parent = forks.find((f) => f.current)!
              const { fork } = yield* api.CreateFork({ chatId, fromForkId: parent.id, atSlotId: parent.tipSlotId })
              yield* api.NameFork({
                forkId: fork.id,
                name: "A very long branch name that keeps going beyond the available title space on every panel width"
              })
              return fork
            })
          )
          await go("splitlink-branch", `/chats/${chatId}?fork=${branch.id}&side=chats&forks=${chatId}`)
          await showAppNavigation(page)
          await audit("splitlink-rows", "[data-fork-row]")
          const pencil = page.getByRole("button", { name: /^Rename branch / }).first()
          await pencil.click()
          await expect(page.getByPlaceholder("Branch name")).toBeVisible()
          await audit("splitlink-rename", "[data-fork-row]")
          await page.getByPlaceholder("Branch name").press("Escape")
          await hideAppNavigation(page)
          await page.getByRole("button", { name: /switch branch/ }).click()
          await audit("splitlink-header", '[role="dialog"]')
          return
        }
        if (process.env.LAYOUT_AUDIT_CHATMERGE_ONLY === "1") {
          // Merging another chat (spec/CHAT-MERGE.md §7): the dialog, the timeline entry, the setting.
          const source = await admin((api) =>
            Effect.gen(function* () {
              const made = yield* api.CreateChat({
                title: `Merge source with a long title at ${width} ${theme} ${Date.now()}`
              })
              let parent: SlotId | null = null
              for (const content of ["The far docks wake under a grey sky.", "Cranes swing over the quiet water."]) {
                const sent: { readonly _tag: string; readonly entry?: { readonly slotId: SlotId } } =
                  yield* api.SendMessage({
                    chatId: made.id,
                    forkId: made.currentForkId!,
                    parentSlotId: parent,
                    branch: false,
                    content
                  })
                parent = sent.entry!.slotId
              }
              return made
            })
          )
          await go("chatmerge-chat", `/chats/${chatId}`)
          await page.getByRole("button", { name: "Chat actions", exact: true }).click()
          await page.getByRole("menuitem", { name: "Merge another chat…", exact: true }).click()
          const dialog = page.getByRole("dialog", { name: "Merge a chat into this one", exact: true })
          await expect(dialog).toBeVisible()
          await audit("chatmerge-dialog-empty", '[role="dialog"]')
          await dialog.getByRole("searchbox", { name: "Chat to merge" }).fill(source.title)
          await dialog
            .getByRole("list", { name: "Chats" })
            .getByRole("button", { name: source.title, exact: true })
            .click()
          await expect(dialog.getByTestId("merge-relation")).toBeVisible()
          await dialog.getByText("What the model reads", { exact: true }).click()
          await audit("chatmerge-dialog", '[role="dialog"]')
          await dialog.getByRole("button", { name: "Merge", exact: true }).click()
          await expect(dialog).toHaveCount(0)
          const row = page.locator("article[data-merge]").last()
          await row.getByRole("button", { name: /^Merged “/ }).click()
          await expect(row.getByRole("list", { name: /^Messages of / })).toBeVisible()
          await audit("chatmerge-timeline", "article[data-merge]")
          await openPanel(page, "This chat")
          await expect(page.getByRole("radiogroup", { name: "Merged chats" })).toBeVisible()
          await audit("chatmerge-setting", 'section[aria-label="Merged chats"]')
          return
        }
        if (process.env.LAYOUT_AUDIT_SPLITCONFIRM_ONLY === "1") {
          const branch = await admin((api) =>
            Effect.gen(function* () {
              const forks = yield* api.ListForks({ chatId })
              const parent = forks.find((f) => f.current)!
              const { fork } = yield* api.CreateFork({ chatId, fromForkId: parent.id, atSlotId: parent.tipSlotId })
              return fork
            })
          )
          await go("splitconfirm-chat", `/chats/${chatId}?fork=${branch.id}`)
          await audit("splitconfirm-composer", '.chat-column:has([data-testid="composer"])')
          await showAppNavigation(page)
          const foot = page
            .getByRole("region", { name: "Branches of the open chat", exact: true })
            .getByRole("button", { name: /^Branches of / })
          if ((await foot.getAttribute("aria-expanded")) !== "true") await foot.click()
          await expect(foot).toHaveAttribute("aria-expanded", "true")
          await audit("splitconfirm-rows", "[data-fork-row]")
          await page
            .getByRole("button", { name: /its own chat$/ })
            .first()
            .click()
          await expect(page.getByRole("dialog")).toBeVisible()
          await audit("splitconfirm-dialog", '[role="dialog"]')
          await page.keyboard.press("Escape")
          await go("splitconfirm-list", `/chats/${chatId}?fork=${branch.id}&side=chats&forks=${chatId}`)
          await showAppNavigation(page)
          await audit("splitconfirm-list-rows", "[data-fork-row]")
          return
        }
        if (process.env.LAYOUT_AUDIT_SIDEBAR_ONLY === "1") {
          for (const [scope, query] of [
            ["all", ""],
            ["character", `&character=${cardId}`],
            ["branches", `&character=${cardId}&forks=${chatId}`]
          ]) {
            if (process.env.LAYOUT_AUDIT_BRANCH_ROWS_ONLY === "1" && scope !== "branches") continue
            await go(`sidebar-before-${scope}`, `/?side=chats${query}`)
            await showAppNavigation(page)
            await audit(`sidebar-scope-${scope}`)
            if (scope !== "branches") {
              const panel =
                width === 390
                  ? page.locator(".fixed.inset-0")
                  : page.getByRole("complementary", { name: "Sidebar", exact: true })
              await panel.getByRole("combobox", { name: "Show chats", exact: true }).click()
              await audit(`sidebar-filter-${scope}`)
              await page.keyboard.press("Escape")
              await panel.getByRole("button", { name: /^Sort chats:/ }).click()
              await audit(`sidebar-sort-${scope}`)
              await page.keyboard.press("Escape")
            }
            await hideAppNavigation(page)
          }
          return
        }
        if (process.env.LAYOUT_AUDIT_PERSONA_BADGES_ONLY === "1") {
          const persona = await admin((api) =>
            Effect.gen(function* () {
              const card = (yield* api.ListCards()).find((card) => card.persona)!
              const ref = (yield* api.ListLibrary({ kind: "card" })).find((ref) => ref.entityId === card.entityId)!
              yield* api.ChangeCast({ chatId, slotId: null, change: { _tag: "Persona", entityId: card.entityId } })
              return { card, ref }
            })
          )
          await go("persona-home-mixed", "/?personas=true&sidePersonas=true")
          await showAppNavigation(page)
          await page
            .getByRole("group", { name: "Left panel", exact: true })
            .getByRole("button", { name: "Characters", exact: true })
            .click()
          await audit("persona-sidebar-mixed")
          await hideAppNavigation(page)
          await go("persona-library-list", "/library?show=personas")
          await go("persona-library-grid", "/library?show=personas&view=grid")
          await go("persona-card-page", `/cards/${persona.card.entityId}`)
          await go("persona-editor", `/library/${persona.ref.id}`)
          await go("persona-chat", `/chats/${chatId}`)
          await openPanel(page, "Cast")
          await audit("persona-cast")
          const add = page.getByRole("button", { name: "Add characters", exact: true })
          if ((await add.getAttribute("aria-expanded")) !== "true") await add.click()
          const section = page.getByRole("region", { name: "Add characters", exact: true })
          await section.getByRole("combobox", { name: "Show" }).click()
          await page.getByRole("option", { name: /^Personas/ }).click()
          await audit("persona-add-characters")
          await openPanel(page, persona.card.name)
          await audit("persona-chat-card")
          await go("persona-chat-editor", `/chats/${chatId}?editor=${persona.ref.id}`)
          await go("persona-speaker", `/chats/${chatId}`)
          if (await page.getByRole("tablist", { name: "Chat panel", exact: true }).isVisible()) await closePanel(page)
          await page.getByRole("button", { name: /^Speaking as / }).click()
          await audit("persona-speaker-switcher")
          return
        }
        if (process.env.LAYOUT_AUDIT_EXPORT_MENUS_ONLY === "1") {
          const formats = async (surface: string, nested: boolean) => {
            if (nested) {
              // The detector moves the pointer aside. Open by keyboard so the submenu
              // remains present throughout the measurements and scroll-end samples.
              await page.mouse.move(0, 0)
              const trigger = page.getByRole("menuitem", { name: "Export…", exact: true })
              await trigger.focus()
              await trigger.press("ArrowRight")
            } else await page.getByRole("button", { name: "Export…", exact: true }).click()
            await expect(page.getByRole("menuitem", { name: "PNG", exact: true })).toBeVisible()
            await audit(surface)
            await expect(page.getByRole("menuitem", { name: "PNG", exact: true })).toBeVisible()
          }
          await go("library-before-export", "/library")
          await page
            .getByRole("listitem")
            .filter({ has: page.locator(`a[href="/library/${cardRef}"]`) })
            .getByRole("button", { name: /^More actions for/ })
            .click()
          await formats("menu-library-export", true)
          await go("editor-before-export", `/library/${cardRef}`)
          await formats("menu-editor-export", false)
          await go("chat-before-export", `/chats/${chatId}`)
          await openPanel(page, "Cast")
          await page.getByRole("button", { name: `More for ${cardName}`, exact: true }).click()
          await formats("menu-cast-export", true)
          await page.keyboard.press("Escape")
          await page.keyboard.press("Escape")
          const characterTab = await openPanel(page, cardName)
          await characterTab.getByRole("button", { name: "Export…", exact: true }).click()
          await expect(page.getByRole("menuitem", { name: "PNG", exact: true })).toBeVisible()
          await audit("menu-character-export")
          await go("pending-before-export", `/cards/${cardId}/chat`)
          await openPanel(page, "Cast")
          await page.getByRole("button", { name: `More for ${cardName}`, exact: true }).click()
          await formats("menu-pending-cast-export", true)
          return
        }
        if (process.env.LAYOUT_AUDIT_CARDHISTORY_ONLY === "1") {
          const persona = await admin((api) =>
            api.CreateCard({ label: `History persona ${width} ${theme}`, name: `History persona ${width} ${theme}` })
          )
          await admin((api) =>
            api.ChangeCast({ chatId, slotId: null, change: { _tag: "Persona", entityId: persona.entityId } })
          )
          const book = (await admin((api) => api.ListLibrary({ kind: "lorebook" }))).find((ref) => ref.id === bookRef)!
          for (const [kind, tab] of [
            ["card", cardName],
            ["persona", persona.label],
            ["preset", "Prompt preset"],
            ["lorebook", "Lorebooks"]
          ]) {
            await page.goto(
              `${server.url}/chats/${chatId}${kind === "persona" ? `?panel=card:${persona.entityId}` : ""}`
            )
            let editor =
              kind === "persona"
                ? page.getByRole("tabpanel", { name: persona.label, exact: true })
                : await openPanel(page, tab!)
            if (kind === "lorebook") {
              await editor.getByRole("button").filter({ hasText: book.label }).first().click()
              editor = editor.getByRole("region", { name: `Lorebook ${book.label}`, exact: true })
            }
            const row =
              kind === "lorebook"
                ? editor.getByRole("toolbar", { name: "Editing", exact: true })
                : editor.getByRole("button", { name: "Search and replace", exact: true }).locator("..")
            await row.evaluate((el) => el.setAttribute("data-cardhistory-header", ""))
            await expect(editor.getByRole("button", { name: "History", exact: true })).toBeVisible()
            await audit(`cardhistory-${kind}`, "[data-cardhistory-header]")
          }
          return
        }
        if (process.env.LAYOUT_AUDIT_SEARCHREPLACE_ONLY === "1") {
          const bookLabel = (await admin((api) => api.ListLibrary({ kind: "lorebook" }))).find(
            (ref) => ref.id === bookRef
          )!.label
          for (const kind of ["card", "preset", "lorebook"] as const) {
            for (const surface of ["panel", "large"] as const) {
              await page.goto(
                `${server.url}/chats/${chatId}${surface === "large" ? `?editor=${kind === "card" ? cardRef : kind === "preset" ? presetRef : bookRef}` : ""}`
              )
              let editor =
                surface === "large"
                  ? page.locator('[data-testid="preset-scroll"]')
                  : await openPanel(
                      page,
                      kind === "card" ? cardName : kind === "preset" ? "Prompt preset" : "Lorebooks"
                    )
              if (kind === "lorebook" && surface === "panel") {
                await editor.getByRole("button").filter({ hasText: bookLabel }).first().click()
                editor = editor.getByRole("region", { name: `Lorebook ${bookLabel}`, exact: true })
              }
              await editor.getByRole("button", { name: "Search and replace", exact: true }).click()
              const search = editor.getByRole("region", { name: "Search and replace", exact: true })
              await expect(search).toBeVisible()
              await editor.evaluate((element) => element.setAttribute("data-searchreplace-audit", ""))
              await audit(`searchreplace-${kind}-${surface}`, "[data-searchreplace-audit]")
            }
          }
          return
        }
        if (process.env.LAYOUT_AUDIT_SAVEFLOW_ONLY === "1") {
          const bookLabel = (await admin((api) => api.ListLibrary({ kind: "lorebook" }))).find(
            (ref) => ref.id === bookRef
          )!.label
          for (const kind of ["card", "preset", "lorebook"] as const) {
            await page.goto(`${server.url}/chats/${chatId}`)
            let editor = await openPanel(
              page,
              kind === "card" ? cardName : kind === "preset" ? "Prompt preset" : "Lorebooks"
            )
            if (kind === "lorebook") {
              await editor.getByRole("button").filter({ hasText: bookLabel }).first().click()
              editor = editor.getByRole("region", { name: `Lorebook ${bookLabel}`, exact: true })
            }
            await expect(editor.getByRole("group", { name: "Save", exact: true }).first()).toBeVisible()
            if (kind === "preset")
              await expect(editor.getByRole("list", { name: "Preset blocks", exact: true })).toBeVisible({
                timeout: 60000
              })
            if (kind === "lorebook")
              await editor
                .getByRole("button", { name: /^Open / })
                .first()
                .click()
            await editor.evaluate((element) => element.setAttribute("data-saveflow-layout", ""))
            await audit(`saveflow-${kind}-panel`, "[data-saveflow-layout]")
            const ref = kind === "card" ? cardRef : kind === "preset" ? presetRef : bookRef
            await page.goto(`${server.url}/chats/${chatId}?editor=${ref}`)
            const large = page.locator('[data-testid="preset-scroll"]')
            await expect(large.getByRole("group", { name: "Save", exact: true }).first()).toBeVisible()
            if (kind === "preset")
              await expect(large.getByRole("list", { name: "Prompt order", exact: true })).toBeVisible({
                timeout: 60000
              })
            if (kind === "lorebook")
              await large
                .getByRole("button", { name: /^Open / })
                .first()
                .click()
            await large.evaluate((element) => element.setAttribute("data-saveflow-layout", ""))
            await audit(`saveflow-${kind}-large`, "[data-saveflow-layout]")
          }
          return
        }
        if (process.env.LAYOUT_AUDIT_LOREBOOKS_ONLY === "1") {
          await page.goto(`${server.url}/chats/${chatId}`)
          const panel = await openPanel(page, "Lorebooks")
          const book = (await admin((api) => api.ListLibrary({ kind: "lorebook" }))).find((ref) => ref.id === bookRef)!
          await panel
            .getByRole("list", { name: "Lorebooks in this chat" })
            .getByRole("button")
            .filter({ has: page.getByText(book.label, { exact: true }) })
            .click()
          const editor = panel.getByRole("region", { name: `Lorebook ${book.label}`, exact: true })
          const inspect = async (scope: Locator, surface: string) => {
            await scope.evaluate((el) => el.setAttribute("data-lorebook-audit", ""))
            await expect(scope.getByRole("list", { name: "Entries", exact: true })).toBeVisible()
            const collapse = scope.getByRole("button", { name: "Collapse all", exact: true })
            if ((await collapse.count()) > 0) await collapse.click()
            await audit(`${surface}-headers`)
            await scope
              .getByRole("button", { name: /^Open / })
              .first()
              .click()
            const entry = scope.getByRole("group", { name: /^Lorebook entry/ }).first()
            await entry.getByRole("button", { name: /^Settings of / }).click()
            await audit(`${surface}-settings`)
            const closed = entry.locator("[data-section-toggle][aria-expanded=false]")
            while ((await closed.count()) > 0) await closed.first().click()
            await audit(`${surface}-all-settings`)
            const keys = entry.getByRole("textbox", { name: "Primary keys", exact: true })
            await keys.focus()
            await audit(`${surface}-keys`)
            await keys.blur()
            await scope.evaluate((el) => el.removeAttribute("data-lorebook-audit"))
          }
          await inspect(editor, "lorebook-panel")
          await editor.getByRole("link", { name: "Large editor", exact: true }).click()
          await inspect(page.getByRole("region", { name: "Lorebook editor", exact: true }), "lorebook-large")
          await page.goto(`${server.url}/library/${bookRef}`)
          await inspect(page.getByRole("main"), "lorebook-page")
          return
        }
        if (process.env.LAYOUT_AUDIT_PROMPTROWS_ONLY === "1") {
          await page.goto(`${server.url}/chats/${chatId}`)
          const panel = await openPanel(page, "Prompt preset")
          const inspectRows = async (root: Locator, surface: string) => {
            const list = root.getByRole("list", { name: /^(Preset blocks|Prompt order)$/ })
            await expect(list).toBeVisible({ timeout: 60000 })
            await list.evaluate((element) => {
              for (let parent: Element | null = element; parent; parent = parent.parentElement) {
                if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY)) parent.scrollTop = 0
              }
            })
            await page.mouse.move(0, 0)
            const box = (await list.boundingBox())!
            const viewport = page.viewportSize()!
            await page.screenshot({
              path: join(work, `${width}-${theme}-${surface}.png`),
              clip: {
                x: Math.max(0, box.x),
                y: Math.max(0, box.y),
                width: Math.min(box.width, viewport.width - Math.max(0, box.x)),
                height: Math.min(650, viewport.height - Math.max(0, box.y))
              }
            })
            await root.evaluate((element) => element.setAttribute("data-promptrows-audit", ""))
            await audit(
              surface,
              '[data-promptrows-audit] [aria-label="Preset blocks"], [data-promptrows-audit] [aria-label="Prompt order"]'
            )
            await root.evaluate((element) => element.removeAttribute("data-promptrows-audit"))
            if (box.width < 576) {
              const rows = await list.locator(".prompt-row-header").evaluateAll((headers) =>
                headers.map((header) => {
                  const title = header.querySelector("[data-prompt-title-row]")!
                  const end = header.querySelector("[data-prompt-end], [data-prompt-info]")
                  const source = header.querySelector("[data-placeholder-source]")
                  const detail = header.querySelector(
                    "[data-prompt-description], [data-prompt-column-preview], [data-prompt-preview]"
                  )
                  return {
                    fullWidth:
                      !detail || detail.getBoundingClientRect().width >= header.getBoundingClientRect().width - 24,
                    separate: !end || end.getBoundingClientRect().top >= title.getBoundingClientRect().bottom,
                    words: !source || getComputedStyle(source).overflowWrap === "normal"
                  }
                })
              )
              expect(rows.length).toBeGreaterThan(0)
              expect(rows.every((row) => row.separate && row.words && row.fullWidth)).toBe(true)
            }
          }
          await inspectRows(panel, "promptrows-panel")
          if (width >= 1024) {
            await page.getByRole("separator", { name: "Resize chat panel", exact: true }).press("Home")
            await inspectRows(panel, "promptrows-minimum")
          }
          const add = panel.getByRole("button", { name: "Add definitions block", exact: true })
          if (await add.isEnabled()) await add.click()
          await expect(panel.locator('[data-prompt="charDefinitions"]')).toBeVisible()
          const unsaved = page.getByRole("region", { name: "Unsaved changes" })
          if (await unsaved.isVisible()) {
            await panel
              .getByRole("group", { name: "Save", exact: true })
              .getByRole("button", { name: "Save", exact: true })
              .click()
            await expect(unsaved).toHaveCount(0)
          }
          await inspectRows(panel, "promptrows-definitions")
          await panel.getByRole("link", { name: "Open the preset in the large editor", exact: true }).click()
          await inspectRows(page.getByRole("region", { name: "Preset editor", exact: true }), "promptrows-large")
          return
        }
        if (process.env.LAYOUT_AUDIT_PRESETS_ONLY === "1") {
          await go("group-chat", `/chats/${chatId}`)
          const panel = await openPanel(page, "Prompt preset")
          await expect(panel.getByRole("list", { name: "Preset blocks" })).toBeVisible({ timeout: 60000 })
          await audit("panel-Prompt-preset")
          const addDefinitions = panel.getByRole("button", { name: "Add definitions block", exact: true })
          if (await addDefinitions.isEnabled()) await addDefinitions.click()
          const unsaved = page.getByRole("region", { name: "Unsaved changes" })
          if (await unsaved.isVisible()) {
            await panel
              .getByRole("group", { name: "Save", exact: true })
              .getByRole("button", { name: "Save", exact: true })
              .click()
            await expect(unsaved).toHaveCount(0)
          }
          await expect(panel.locator('[data-prompt="charDefinitions"]')).toBeVisible()
          await audit("panel-Prompt-preset-definitions")
          await panel.getByRole("link", { name: "Open the preset in the large editor", exact: true }).click()
          const large = page.getByRole("region", { name: "Preset editor", exact: true })
          await expect(large.getByRole("list", { name: "Prompt order", exact: true })).toBeVisible({ timeout: 60000 })
          await audit("preset-large")
          return
        }
        if (process.env.LAYOUT_AUDIT_HEADERSPACING_ONLY === "1") {
          await page.goto(`${server.url}/chats/${chatId}`)
          const panel = await openPanel(page, cardName)
          const header = panel.locator("[data-card-header]")
          await expect(header.locator("[data-card-tokens]")).toBeVisible()
          if (process.env.LAYOUT_AUDIT_HEADER_MINIMUM === "1" && width >= 1024)
            await page.getByRole("separator", { name: "Resize chat panel", exact: true }).press("Home")
          for (const persona of [false, true]) {
            const toggle = header.getByRole("button", { name: "Persona", exact: true })
            if ((await toggle.getAttribute("aria-pressed")) !== String(persona)) await toggle.click()
            await expect(toggle).toHaveAttribute("aria-pressed", String(persona))
            await page.mouse.move(0, 0)
            await header.screenshot({
              path: join(work, `header-${width}-${theme}-${persona ? "persona" : "character"}.png`)
            })
            await audit(`panel-${persona ? "persona" : "character"}-header`, "[data-card-header]")
          }
          return
        }
        if (process.env.LAYOUT_AUDIT_CARD_HEADERS_ONLY === "1") {
          await page.goto(`${server.url}/library/${cardRef}`)
          await expect(page.locator("[data-card-tokens]")).toBeVisible()
          await audit("card-editor-header", "[data-card-header]")
          await go("card-page-header", `/cards/${cardId}`)
          await page.goto(`${server.url}/chats/${chatId}`)
          await openPanel(page, cardName)
          await expect(page.locator("[data-card-header] [data-card-tokens]")).toBeVisible()
          await audit("panel-card-header", "[data-card-header]")
          if (width >= 1024) {
            const handle = page.getByRole("separator", { name: "Resize chat panel", exact: true })
            await handle.press("Home")
            await audit("panel-card-header-narrow", "[data-card-header]")
            await handle.press("End")
            await audit("panel-card-header-wide", "[data-card-header]")
          }
          return
        }
        if (process.env.LAYOUT_AUDIT_DIALOGS_ONLY === "1") {
          await go("library-before-dialogs", "/library")
          for (const name of ["New card", "New prompt preset"]) {
            await page.getByRole("tab", { name: name === "New card" ? /^Cards/ : /^Presets/ }).click()
            await page.getByRole("main").getByRole("button", { name, exact: true }).click()
            await expect(page.getByRole("dialog", { name, exact: true })).toBeVisible()
            await audit(`dialog-${name}`)
            await page.keyboard.press("Escape")
          }
          await go("card-before-large", `/library/${cardRef}`)
          await page.getByRole("button", { name: "Open Description large", exact: true }).click()
          const large = page.getByRole("dialog", { name: "Description", exact: true })
          await expect(large).toBeVisible()
          await audit("dialog-large-text")
          await page.keyboard.press("Escape")
          await go("chat-before-sheet", `/chats/${chatId}`)
          await openPanel(page, "This chat")
          if (width < 1024) await audit("dialog-panel-sheet")
          await closePanel(page)
          await page.getByRole("button", { name: "Chat actions", exact: true }).click()
          await page.getByRole("menuitem", { name: "Branches…", exact: true }).click()
          await expect(page.getByRole("dialog", { name: "Branches of this chat" })).toBeVisible()
          await audit("dialog-branches")
          await page.keyboard.press("Escape")
          const cardTab = await openPanel(page, cardName)
          await cardTab.getByRole("button", { name: `Use another version: ${cardName}`, exact: true }).click()
          await expect(page.getByRole("dialog", { name: "Use another version", exact: true })).toBeVisible()
          await audit("dialog-card-family", '[role="dialog"]')
          await page.keyboard.press("Escape")
          await go("home-before-picker", "/")
          await showAppNavigation(page)
          if (width < 1024) await audit("dialog-navigation-drawer")
          return
        }
        if (process.env.LAYOUT_AUDIT_AVATAR_STACKS_ONLY === "1") {
          await go("home-groups", "/?show=groups")
          await go("group-page", `/groups/${chatId}`)
          await go("library-rows", "/library")
          await go("chat-list", "/chats")
          await go("group-chat-header", `/chats/${chatId}`)
          await openPanel(page, "Cast")
          await audit("panel-Cast")
          return
        }
        if (process.env.LAYOUT_AUDIT_LOCKCHAT_ONLY === "1") {
          await go("lockchat-chips", `/chats/${chatId}`)
          await audit("lockchat-chips", '[role="group"][aria-label="Next reply"]')
          for (const [kind, chip] of [
            ["preset", presetChip],
            ["model", modelChip]
          ] as const) {
            await chip(page).click()
            const toggle = page.getByRole("switch", { name: "Lock for this chat" })
            await expect(toggle).toBeVisible()
            if (await toggle.isChecked()) await toggle.click()
            await expect(toggle).not.toBeChecked()
            await expect(page.getByText(/^Picking a (preset|model) here changes it for/)).toHaveCount(0)
            await page.getByRole("dialog").screenshot({
              path: join(work, `${width}-${theme}-${kind}-unlocked.png`),
              animations: "disabled"
            })
            await audit(`lockchat-${kind}-picker`, '[role="dialog"]')
            await toggle.click()
            await expect(toggle).toBeChecked()
            await expect(page.getByText(/^Picking a (preset|model) here changes it for/)).toHaveCount(0)
            await page.getByRole("dialog").screenshot({
              path: join(work, `${width}-${theme}-${kind}-locked.png`),
              animations: "disabled"
            })
            await audit(`lockchat-${kind}-locked-picker`, '[role="dialog"]')
            await page.keyboard.press("Escape")
          }
          await audit("lockchat-locked-chips", '[role="group"][aria-label="Next reply"]')
          return
        }
        if (process.env.LAYOUT_AUDIT_NOONE_ONLY === "1") {
          // Next's No one: the Who replies next menu with its row, and the pill once it's chosen.
          await go("noone-chips", `/chats/${chatId}`)
          await audit("noone-chips", '[role="group"][aria-label="Next reply"]')
          await nextChip(page).click()
          const menu = page.getByRole("radiogroup", { name: "Who replies next", exact: true })
          await menu.getByRole("radio", { name: "No one", exact: true }).hover()
          await page.screenshot({ path: join(work, `${width}-${theme}-noone-menu.png`), animations: "disabled" })
          await audit("noone-menu", '[role="dialog"]')
          await menu.getByRole("radio", { name: "No one", exact: true }).click()
          await expect(nextChip(page)).toHaveAccessibleName(
            "Next: no one, until you choose otherwise. Choose who replies next"
          )
          await page.mouse.move(0, 0)
          await page.screenshot({ path: join(work, `${width}-${theme}-noone-pill.png`), animations: "disabled" })
          await audit("noone-pill", '[role="group"][aria-label="Next reply"]')
          await nextChip(page).click()
          await page.screenshot({ path: join(work, `${width}-${theme}-noone-chosen-menu.png`), animations: "disabled" })
          await audit("noone-chosen-menu", '[role="dialog"]')
          return
        }
        if (process.env.LAYOUT_AUDIT_CHAT_SETTINGS_ONLY === "1") {
          await go("group-chat-header", `/chats/${chatId}`)
          const settings = await openPanel(page, "This chat")
          await audit("panel-This chat")
          await settings.getByRole("switch", { name: "Tools", exact: true }).click()
          await expect(settings.getByRole("group", { name: "Allowed tools" })).toBeVisible()
          await settings.getByRole("switch", { name: /^Card swap/ }).click()
          await audit("panel-This chat-tools")
          return
        }
        if (process.env.LAYOUT_AUDIT_REPLY_SETTINGS_ONLY === "1") {
          await go("group-chat-header", `/chats/${chatId}`)
          const cast = await openPanel(page, "Cast")
          if (width === 1440) await page.getByRole("separator", { name: "Resize chat panel" }).press("End")
          const replies = cast.getByRole("region", { name: "Who replies", exact: true })
          await expect(replies.getByRole("switch", { name: "One reply at a time" })).toBeVisible()
          await replies.screenshot({ path: join(work, `${width}-${theme}-reply-settings.png`), animations: "disabled" })
          await audit("panel-Cast")
          return
        }
        if (process.env.LAYOUT_AUDIT_IMAGES_ONLY === "1") {
          await go("shell-header", "/")
          await showAppNavigation(page)
          await audit("shell-navigation-header")
          const navigation =
            width < 1024 ? page.locator('[data-layout-overlay="Mobile navigation drawer covers the page"]') : page
          await navigation
            .getByRole("button", { name: /^(Blur|Hide|Show) all images$/ })
            .filter({ visible: true })
            .first()
            .click({ button: "right" })
          await audit("image-concealment-menu")
          await page.keyboard.press("Escape")
          await hideAppNavigation(page)
          await go("chat-before-display", `/chats/${chatId}`)
          await openPanel(page, "Interface")
          await audit("panel-Interface")
          return
        }
        if (process.env.LAYOUT_AUDIT_HEADER_ONLY === "1") {
          await go("pending-chat-header", `/cards/${cardId}/chat`)
          await go("saved-chat-header", `/chats/${chatId}`)
          await openPanel(page, "This chat")
          await audit("panel-header")
          return
        }
        if (process.env.LAYOUT_AUDIT_SNIPPETS_ONLY === "1") {
          await admin((api) =>
            Effect.gen(function* () {
              if ((yield* api.ListSnippets({ chatId })).length === 0) {
                for (const title of ["Harbour details", "Next scene"]) {
                  yield* api.CreateSnippet({
                    chatId,
                    title,
                    content: "A lighthouse above the quiet harbour.\nLanterns shine along the pier."
                  })
                }
              }
            })
          )
          await go("group-chat", `/chats/${chatId}`)
          await openPanel(page, "Snippets")
          await audit("panel-Snippets")
          const snippet = page.getByRole("region", { name: "Snippet Harbour details", exact: true })
          await snippet.getByRole("button", { name: "Rename Harbour details", exact: true }).click()
          await snippet
            .getByRole("textbox", { name: "New name for Harbour details", exact: true })
            .fill("Harbour revisions")
          await page.keyboard.press("Enter")
          const renamed = page.getByRole("region", { name: "Snippet Harbour revisions", exact: true })
          const expand = renamed.getByRole("button", { name: "Expand Harbour revisions", exact: true })
          if (await expand.count()) await expand.click()
          await renamed.getByRole("button", { name: "History of Harbour revisions", exact: true }).click()
          await expect(page.getByRole("dialog", { name: "History: Harbour revisions", exact: true })).toBeVisible()
          await audit("dialog-snippet-History", '[role="dialog"]')
          // The synthetic chat is shared by the viewport/theme profiles.
          await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click()
          await renamed.getByRole("button", { name: "Rename Harbour revisions", exact: true }).click()
          await renamed
            .getByRole("textbox", { name: "New name for Harbour revisions", exact: true })
            .fill("Harbour details")
          await page.keyboard.press("Enter")
          return
        }
        if (process.env.LAYOUT_AUDIT_CASTGAP_ONLY === "1") {
          await go("group-chat", `/chats/${chatId}`)
          await openPanel(page, "This chat")
          const subjects = page.getByRole("tablist", { name: "Characters", exact: true })
          const strip = subjects.locator("xpath=../../..")
          const nav = strip.locator("..")
          const scope = "[data-castgap-audit]"
          await nav.evaluate((el) => el.setAttribute("data-castgap-audit", ""))
          const names = [
            "This chat",
            "Cast",
            "Model",
            "Prompt preset",
            "Notes",
            "Lorebooks",
            "Summaries",
            "Interface",
            "Snippets",
            "History edits"
          ]
          const characters = await subjects
            .getByRole("tab")
            .evaluateAll((tabs) => tabs.slice(1).map((tab) => tab.getAttribute("title")!))
          const measurements = []
          for (const name of [...names, ...characters]) {
            if (characters.includes(name)) await subjects.getByTitle(name, { exact: true }).click()
            else await openPanel(page, name)
            await expect(
              page
                .getByRole("tabpanel")
                .filter({ visible: true })
                .getByText(/^(Loading|Still loading)/)
            ).toHaveCount(0)
            await expect(page.getByRole("tabpanel").filter({ visible: true }).first()).toBeVisible()
            const geometry = () =>
              nav.evaluate((el) => {
                const tools = el.children[0]!.getBoundingClientRect()
                const row = el.children[1]!
                const tabs = row.querySelector('[role="tablist"]')!
                const chip = tabs.firstElementChild!.getBoundingClientRect()
                const box = row.getBoundingClientRect()
                const panel = [...el.parentElement!.children]
                  .find((child) => child.matches('[role="tabpanel"]') && child.getBoundingClientRect().height > 0)!
                  .getBoundingClientRect()
                const rect = (r: DOMRect) => ({ x: r.x, y: r.y, width: r.width, height: r.height })
                return {
                  tools: rect(tools),
                  chip: rect(chip),
                  panel: rect(panel),
                  above: chip.top - tools.bottom,
                  below: box.bottom - 1 - chip.bottom
                }
              })
            await strip.evaluate((el) => {
              ;(el as HTMLElement).style.paddingTop = "16px"
            })
            const before = await geometry()
            if (name === "This chat") await nav.screenshot({ path: join(work, `${width}-${theme}-before.png`) })
            await strip.evaluate((el) => {
              ;(el as HTMLElement).style.removeProperty("padding-top")
            })
            const after = await geometry()
            expect(after.above).toBe(4)
            expect(after.below).toBe(4)
            expect(after.tools).toEqual(before.tools)
            expect(after.chip).toEqual({ ...before.chip, y: before.chip.y - 12 })
            expect(after.panel).toEqual({ ...before.panel, y: before.panel.y - 12, height: before.panel.height + 12 })
            if (name === "This chat") await nav.screenshot({ path: join(work, `${width}-${theme}-after.png`) })
            measurements.push({ name, before, after })
            await audit(`castgap-${name}`, scope)
          }
          writeFileSync(join(work, `geometry-${width}-${theme}.json`), JSON.stringify(measurements, null, 2))
          return
        }
        if (process.env.LAYOUT_AUDIT_PANELS_ONLY === "1") {
          await go("group-chat", `/chats/${chatId}`)
          for (const name of [
            "This chat",
            "Cast",
            "Model",
            "Prompt preset",
            "Notes",
            "Lorebooks",
            "Summaries",
            "Interface",
            "Snippets",
            "History edits"
          ]) {
            await openPanel(page, name)
            await audit(`panel-${name}`)
          }
          return
        }
        if (process.env.LAYOUT_AUDIT_HISTORY_ONLY === "1") {
          const fixture = await admin((api) =>
            Effect.gen(function* () {
              const chat = yield* api.CreateChat({ title: "Search and replace layout" })
              const sent = yield* api.SendMessage({
                chatId: chat.id,
                parentSlotId: null,
                branch: false,
                content: "Aria reads the garden ledger. Aria waves."
              })
              if (sent._tag !== "Posted") throw new Error("fixture queued")
              return { chat, entry: sent.entry }
            })
          )
          await level1(join(work, "data"), fixture.chat.id, [fixture.entry], "Aria reads the ledger.")
          await page.goto(`${server.url}/chats/${fixture.chat.id}?panel=history`)
          const panel = page.locator("[data-history-panel]")
          await expect(panel.getByRole("heading", { name: "Searches", exact: true })).toBeVisible()
          await audit("panel-search-replace-empty")
          await panel.getByRole("button", { name: "Add search and replace", exact: true }).click()
          await panel
            .getByRole("region", { name: "Search and replace 2", exact: true })
            .getByRole("textbox", { name: "Find", exact: true })
            .fill("Aria")
          await expect(
            panel.getByRole("region", { name: "Search and replace 2", exact: true }).getByRole("status")
          ).toContainText("2 in messages, 0 in swipes, 1 in summaries")
          await audit("panel-search-replace-boxes")
          await panel
            .getByRole("region", { name: "Search and replace 2", exact: true })
            .getByRole("button", { name: "Remove this search and replace", exact: true })
            .click()
          await panel.getByRole("textbox", { name: "Find", exact: true }).fill("Aria")
          await panel.getByRole("textbox", { name: "Replace with", exact: true }).fill("Ari")
          await panel.getByRole("button", { name: "Replace all", exact: true }).click()
          await expect(panel.getByRole("button", { name: "Undo all", exact: true })).toBeVisible()
          await audit("panel-search-replace-applied")
          return
        }
        if (process.env.LAYOUT_AUDIT_NOTES_ONLY === "1") {
          await go("group-chat", `/chats/${chatId}`)
          await openPanel(page, "Notes")
          await audit("panel-Notes")
          return
        }
        if (process.env.LAYOUT_AUDIT_PERSONA_TOGGLE_ONLY === "1") {
          const toggle = (scope: Page | Locator) => scope.getByRole("button", { name: "Include personas", exact: true })
          const checkRow = async (scope: Page | Locator) => {
            const button = toggle(scope)
            const direction = scope.getByRole("button", { name: /^Order:/ }).last()
            const a = (await button.boundingBox())!
            const b = (await direction.boundingBox())!
            expect(a.y).toBe(b.y)
            expect(a.width).toBe(b.width)
            expect(a.height).toBe(b.height)
            expect(a.x).toBeGreaterThan(b.x)
            await page.mouse.move(0, 0)
            await button.hover()
            const pressed = (await button.getAttribute("aria-pressed")) === "true"
            await expect(
              page.getByText(pressed ? "Click to hide personas" : "Click to show personas", { exact: true })
            ).toBeVisible()
            if (!pressed) {
              await expect(button).toHaveCSS("opacity", "1")
            }
            await page.mouse.move(0, 0)
          }
          await go("home-all", "/")
          const main = page.getByRole("main")
          await checkRow(main)
          await expect(toggle(main)).toHaveAttribute("aria-pressed", "false")
          await expect(toggle(main).locator("svg path")).toHaveCount(4)
          await toggle(main).click()
          await expect(toggle(main)).toHaveAttribute("aria-pressed", "true")
          await expect(toggle(main).locator("svg path")).toHaveCount(2)
          await audit("home-include-personas")
          await showAppNavigation(page)
          await page
            .getByRole("group", { name: "Left panel", exact: true })
            .getByRole("button", { name: "Characters", exact: true })
            .click()
          const sideToggle = page.getByRole("button", { name: "Include personas", exact: true }).first()
          // The sidebar's grid is the first browser in document order.
          await expect(sideToggle).toBeVisible()
          await checkRow(sideToggle.locator(".."))
          await audit("sidebar-Characters")
          await expect(sideToggle).toHaveAttribute("aria-pressed", "false")
          await expect(sideToggle.locator("svg path")).toHaveCount(4)
          await sideToggle.click()
          await expect(sideToggle).toHaveAttribute("aria-pressed", "true")
          await expect(sideToggle.locator("svg path")).toHaveCount(2)
          await audit("sidebar-include-personas")
          if (width === 1440) {
            const handle = page.getByRole("separator", { name: "Resize sidebar", exact: true })
            const box = (await handle.boundingBox())!
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
            await page.mouse.down()
            await page.mouse.move(0, box.y + box.height / 2, { steps: 10 })
            await page.mouse.up()
            await checkRow(sideToggle.locator(".."))
            await audit("sidebar-minimum-include-personas")
          }
          await hideAppNavigation(page)
          await go("group-chat", `/chats/${chatId}`)
          const cast = await openPanel(page, "Cast")
          const add = cast.getByRole("button", { name: "Add characters", exact: true })
          if ((await add.getAttribute("aria-expanded")) === "false") await add.click()
          const section = cast.getByRole("region", { name: "Add characters", exact: true })
          await checkRow(section)
          await audit("cast-add-characters")
          await expect(toggle(section)).toHaveAttribute("aria-pressed", "false")
          await expect(toggle(section).locator("svg path")).toHaveCount(4)
          await toggle(section).click()
          await expect(toggle(section)).toHaveAttribute("aria-pressed", "true")
          await expect(toggle(section).locator("svg path")).toHaveCount(2)
          await audit("cast-add-personas")
          return
        }
        if (process.env.LAYOUT_AUDIT_VIEWER_HEADER_ONLY === "1") {
          await page.goto(`${server.url}/chats/${chatId}`)
          const card = await openPanel(page, cardName)
          await card
            .getByRole("button", { name: /^View .*'s picture$/ })
            .first()
            .click()
          const header = page.locator("[data-portrait-column] [data-viewer-header]").first()
          await expect(header).toBeVisible()
          await header.screenshot({ path: join(work, `${width}-${theme}-viewer-header.png`) })
          await audit("viewer-header", "[data-portrait-column] [data-viewer-header]")
          await header.getByRole("button", { name: "Viewer options", exact: true }).click()
          await page
            .getByRole("menu", { name: "Viewer options", exact: true })
            .screenshot({ path: join(work, `${width}-${theme}-viewer-menu.png`) })
          await audit("viewer-menu", '[role="menu"]')
          return
        }
        if (process.env.LAYOUT_AUDIT_ICON_TOGGLES_ONLY === "1") {
          await go("group-chat", `/chats/${chatId}`)
          const versions = page.getByRole("button", { name: /choose a version$/ }).last()
          await versions.click()
          await expect(page.getByRole("dialog", { name: /^Versions of message/ })).toBeVisible()
          await audit("version-picker")
          await page.keyboard.press("Escape")
          for (const name of ["Cast", "Prompt preset", "Lorebooks", "Notes"]) {
            await openPanel(page, name)
            await audit(`panel-${name}`)
          }
          const card = await openPanel(page, cardName)
          const view = card.getByRole("button", { name: /^View .*'s picture$/ })
          if ((await view.count()) > 0) {
            await view.first().click()
            await expect(page.locator("[data-image-viewer]").first()).toBeVisible()
            await audit("portrait-viewer")
            await page.keyboard.press("Escape")
          }
          await closePanel(page)
          for (const [surface, path] of [
            ["library", "/library"],
            ["card-editor", `/library/${cardRef}`],
            ["preset-editor", `/library/${presetRef}`],
            ["lorebook-editor", `/library/${bookRef}`]
          ] as const) {
            await go(surface, path)
          }
          return
        }
        if (process.env.LAYOUT_AUDIT_HOME_ONLY === "1") {
          await go("home-all", "/")
          return
        }
        if (process.env.LAYOUT_AUDIT_CHAT_ROWS_ONLY === "1") {
          await go("home-pinned-chats", "/")
          for (const [scope, query] of [
            ["all", ""],
            ["character", `&character=${cardId}`],
            ["branches", `&character=${cardId}&forks=${chatId}`]
          ]) {
            await page.goto(`${server.url}/chats/${chatId}?side=chats${query}`)
            if (width === 390)
              await expect(page.getByRole("button", { name: "Chats and menu", exact: true })).toBeVisible()
            await showAppNavigation(page)
            const navigation =
              width === 390
                ? page.locator('[data-layout-overlay="Mobile navigation drawer covers the page"]')
                : page.getByRole("complementary", { name: "Sidebar", exact: true })
            await expect(navigation.locator("[data-chat-id]").first()).toBeVisible()
            await audit(`sidebar-scope-${scope}`)
            await hideAppNavigation(page)
          }
          return
        }
        if (process.env.LAYOUT_AUDIT_GRIDS_ONLY === "1") {
          await go("home-all", "/")
          await showAppNavigation(page)
          await page
            .getByRole("group", { name: "Left panel", exact: true })
            .getByRole("button", { name: "Characters", exact: true })
            .click()
          await audit("sidebar-Characters")
          await hideAppNavigation(page)
          await go("library-list", "/library")
          await page
            .getByRole("group", { name: "View", exact: true })
            .getByRole("button", { name: "Grid", exact: true })
            .click()
          await audit("library-grid")
          return
        }
        if (process.env.LAYOUT_AUDIT_FIXES_ONLY === "1") {
          await go("home-all", "/")
          await go("library", "/library")
          await go("settings-interface", "/settings/interface")
          await go("card-editor", `/library/${cardRef}`)
          for (const name of ["Greetings", "Metadata", "Lorebook", "Notes", "Extra"]) {
            await page.getByRole("main").getByRole("tab", { name, exact: true }).first().click()
            await audit(`card-editor-${name}`)
          }
          await go("group-chat", `/chats/${chatId}`)
          await openPanel(page, "Notes")
          await audit("panel-Notes")
          await closePanel(page)
          await page.getByRole("button", { name: "Chat actions", exact: true }).click()
          await page.getByRole("menuitem", { name: "Branches…", exact: true }).click()
          await expect(page.getByRole("dialog", { name: "Branches of this chat" })).toBeVisible()
          await audit("dialog-branches")
          return
        }
        await go("home-all", "/")
        for (const name of ["With chats", "Never used", "Favourites", "Personas", "Groups", "All"]) {
          await page
            .getByRole("main")
            .getByRole("group", { name: "Show", exact: true })
            .getByRole("button", { name, exact: true })
            .click()
          await audit(`home-${name}`)
        }
        // Personas mixed in, each marked "Persona" (personalists).
        if (selected.test("home-include-personas")) {
          const include = page.getByRole("main").getByRole("button", { name: "Include personas", exact: true })
          await include.click()
          await audit("home-include-personas")
          await include.click()
        }
        await showAppNavigation(page)
        for (const name of ["Characters", "Chats"]) {
          await page
            .getByRole("group", { name: "Left panel", exact: true })
            .getByRole("button", { name, exact: true })
            .click()
          await audit(`sidebar-${name}`)
        }
        await hideAppNavigation(page)
        for (const [scope, query] of [
          ["all", ""],
          ["character", `&character=${cardId}`],
          ["branches", `&character=${cardId}&forks=${chatId}`]
        ]) {
          await page.goto(`${server.url}/?side=chats${query}`)
          await expect(page.getByRole("main").getByRole("heading").first()).toBeVisible({ timeout: 30000 })
          await showAppNavigation(page)
          await expect(page.getByRole("group", { name: "Left panel", exact: true })).toBeVisible()
          await audit(`sidebar-scope-${scope}`)
          await hideAppNavigation(page)
        }
        await go("group-chat", `/chats/${chatId}`)
        await expect(page.getByLabel("Message", { exact: true })).toBeEditable()
        const sweep = async (suffix: string) => {
          for (const name of [
            "This chat",
            "Cast",
            "Model",
            "Prompt preset",
            "Notes",
            "Lorebooks",
            "Summaries",
            "Interface",
            "Snippets",
            "History edits"
          ]) {
            const panel = await openPanel(page, name)
            await expect(panel.getByText(/^(Loading|Still loading)/)).toHaveCount(0, { timeout: 30000 })
            await audit(`panel-${name}${suffix}`)
            if (name === "Notes") {
              const insets = await panel.getByRole("switch").evaluateAll((switches) =>
                switches.map((control) => {
                  const block = control.closest("section")!
                  return control.getBoundingClientRect().left - block.getBoundingClientRect().left - block.clientLeft
                })
              )
              expect.soft(insets.length, "both chat and character notes are present").toBeGreaterThanOrEqual(2)
              for (const inset of insets) expect.soft(inset, "note switch inset").toBeGreaterThanOrEqual(8)
              await info.attach(`Notes${suffix}`, { body: await panel.screenshot(), contentType: "image/png" })
            }
            if (name === "Summaries") {
              await expect(panel.locator("[data-summary]").first()).toBeVisible({ timeout: 30000 })
              await openSummarySettings(page)
              await audit(`panel-summary-settings${suffix}`)
            }
          }
          const card = await openPanel(page, cardName)
          for (const name of ["Definition", "Greetings", "Metadata", "Lorebook", "Notes", "Extra"]) {
            await card.getByRole("tab", { name, exact: true }).first().click()
            await audit(`panel-card-${name}${suffix}`)
          }
          // The card's picture: its whole image in the viewer, and the Picture dialog (portraitview).
          const view = card.getByRole("button", { name: /^View .*'s picture$/ })
          if (selected.test(`portrait-viewer${suffix}`) && (await view.count()) > 0) {
            await view.first().click()
            await expect(page.locator("[data-image-viewer]").first()).toBeVisible()
            await audit(`portrait-viewer${suffix}`)
            await page.keyboard.press("Escape")
            await expect(page.locator("[data-image-viewer]")).toHaveCount(0)
          }
          if (selected.test(`dialog-picture${suffix}`) && (await view.count()) > 0) {
            await card.getByRole("button", { name: "Picture", exact: true }).click()
            await expect(page.locator("[data-cutout-box]")).toBeVisible()
            await audit(`dialog-picture${suffix}`)
            await page.keyboard.press("Escape")
            await expect(page.locator("[data-cutout-box]")).toHaveCount(0)
          }
        }
        await sweep("")
        if (width >= 1024) {
          const hideSidebar = page.getByRole("button", { name: "Hide the sidebar", exact: true })
          if (await hideSidebar.isVisible()) await hideSidebar.click()
          const handle = page.getByRole("separator", { name: "Resize chat panel", exact: true })
          const box = (await handle.boundingBox())!
          const before = Number(await handle.getAttribute("aria-valuenow"))
          await page.mouse.move(box.x + box.width / 2, box.y + 200)
          await page.mouse.down()
          await page.mouse.move(box.x - width, box.y + 200, { steps: 12 })
          await page.mouse.up()
          await expect.poll(async () => Number(await handle.getAttribute("aria-valuenow"))).toBeGreaterThan(before)
          await sweep("-wide-drag")
        }
        await closePanel(page)
        const routes: Array<[string, string]> = [
          ["chats", "/chats"],
          ["library", "/library"],
          ["card", `/cards/${cardId}`],
          ["card-editor", `/library/${cardRef}`],
          ["preset-editor", `/library/${presetRef}`],
          ["lorebook-editor", `/library/${bookRef}`],
          ...[
            "connections",
            "connections/new",
            `connections/${connectionId}`,
            "keys",
            "network",
            "costs",
            "chats",
            "interface",
            "regex",
            "notifications",
            "account",
            "users",
            "status"
          ].map((section) => [`settings-${section}`, `/settings/${section}`] as [string, string]),
          ["import", "/import"],
          ["import-st", "/import/st"],
          ["bin", "/bin"],
          ["inspector", `/chats/${chatId}/context/${replyId}`]
        ]
        for (const [surface, path] of routes) {
          await go(surface, path)
          if (surface === "library") {
            for (const name of ["New card", "New prompt preset"]) {
              await page.getByRole("tab", { name: name === "New card" ? /^Cards/ : /^Presets/ }).click()
              await page.getByRole("main").getByRole("button", { name, exact: true }).click()
              await expect(page.getByRole("dialog", { name, exact: true })).toBeVisible()
              await audit(`dialog-${name}`)
              await page.keyboard.press("Escape")
            }
            for (const name of ["Cards", "Presets", "Lorebooks"]) {
              const tab = page.getByRole("main").getByRole("tab", { name: new RegExp(`^${name}`) })
              await tab.click()
              await audit(`library-${name}`)
            }
          }
          if (surface === "card-editor")
            for (const name of ["Greetings", "Metadata", "Lorebook", "Notes", "Extra"]) {
              await page.getByRole("main").getByRole("tab", { name, exact: true }).first().click()
              await audit(`card-editor-${name}`)
            }
        }
        await go("users-before-dialog", "/settings/users")
        await page.getByRole("button", { name: "New user", exact: true }).click()
        await expect(page.getByRole("dialog", { name: "New user" })).toBeVisible()
        await audit("dialog-new-user")
        await page.keyboard.press("Escape")
        await go("keys-before-dialog", "/settings/keys")
        await page.getByRole("button", { name: "Replace key", exact: true }).first().click()
        await expect(page.getByRole("dialog")).toBeVisible()
        await audit("dialog-replace-key")
        await page.keyboard.press("Escape")
        await go("chat-before-dialogs", `/chats/${chatId}`)
        await page.getByRole("button", { name: "Chat actions", exact: true }).click()
        await audit("menu-chat-actions")
        await page.getByRole("menuitem", { name: "Branches…", exact: true }).click()
        await expect(page.getByRole("dialog", { name: "Branches of this chat" })).toBeVisible()
        await audit("dialog-branches")
        await page.keyboard.press("Escape")
      })
    }
})

for (const width of [390, 1440])
  for (const theme of ["light", "dark"] as const)
    test(`new version notice ${width} ${theme}`, async ({ page }, info) => {
      test.skip(!!process.env.LAYOUT_AUDIT_CENTERHEADER_ONLY, "Focused center headers")
      const server = await startServer(withAdmin)
      try {
        await page.setViewportSize({ width, height: 900 })
        await page.emulateMedia({ colorScheme: theme })
        await apiLogin(page.request, server, ADMIN.handle, ADMIN.password)
        await page.route("**/healthz", async (route) => {
          const response = await route.fetch()
          await route.fulfill({ response, headers: { ...response.headers(), "x-client-build": "next-deployment" } })
        })
        await page.goto(`${server.url}/settings/status`)
        const notice = page.getByRole("status", { name: "New version" })
        await expect(notice).toBeVisible()
        await page.mouse.move(0, 0)
        const findings = (await layoutAudit(page)).filter(
          (v) => v.selector.includes("#client-version-notice") || v.related?.includes("#client-version-notice")
        )
        for (const [i, finding] of findings.entries()) {
          finding.crop = info.outputPath(`version-${width}-${theme}-${i}.png`)
          await page.screenshot({ path: finding.crop, clip: finding.box })
          await info.attach(`notice ${i}`, { path: finding.crop, contentType: "image/png" })
        }
        writeFileSync(info.outputPath("notice-measurements.json"), JSON.stringify(findings, null, 2))
        await info.attach("notice measurements", {
          body: JSON.stringify(findings, null, 2),
          contentType: "application/json"
        })
        await notice.screenshot({ path: info.outputPath(`version-${width}-${theme}.png`) })
        expect(findings).toEqual([])
      } finally {
        await page.unrouteAll({ behavior: "wait" })
        await page.close()
        await server.stop()
      }
    })

if (process.env.LAYOUT_AUDIT_CENTERHEADER_ONLY) centerHeaderTests()
// Fresh synthetic revisions exercise the production dialog without a development instance.
test.describe("revision dialogs", () => {
  test.skip(!!process.env.LAYOUT_AUDIT_CENTERHEADER_ONLY, "Focused center headers")
  let server: TestServer
  let cookie: string
  test.beforeAll(async () => {
    server = await startServer(withAdmin)
    cookie = await loginCookie(server, ADMIN.handle, ADMIN.password)
  })
  test.afterAll(async () => {
    await server?.stop()
  })
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"] as const)
      test(`revision dialogs ${width} ${theme}`, async ({ page }, info) => {
        const url = server.url
        await apiLogin(page.request, server, ADMIN.handle, ADMIN.password)
        await page.setViewportSize({ width, height: 960 })
        await page.emulateMedia({ colorScheme: theme })
        await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
        const findings: unknown[] = []
        const gaps: unknown[] = []
        const geometry: unknown[] = []
        const rowHeights: unknown[] = []
        for (const kind of ["note", "card"] as const) {
          const id = await withCookie(server, cookie, (api) =>
            Effect.gen(function* () {
              const ref =
                kind === "note"
                  ? yield* api.CreateSharedNote({ title: `Audit note ${width} ${theme}`, content: "A quiet harbor." })
                  : yield* api.CreateCard({
                      label: `Audit card ${width} ${theme}`,
                      name: `Audit card ${width} ${theme}`
                    })
              for (const [index, message] of [
                "Establish the harbor scene",
                "The lantern keeper records the harbor meeting and the travelers' promise to return after the evening bell. "
                  .repeat(4)
                  .trim()
              ].entries()) {
                const opened = yield* api.OpenEditor({ refId: ref.id })
                const field = textField([kind === "note" ? "content" : "description"])
                const draft = yield* api.SaveEditorDraft({
                  refId: ref.id,
                  field,
                  content: `The harbor scene, revision ${index + 2}.`,
                  draftId: null,
                  expectedRowVersion: null,
                  expectedSession: null,
                  baseRevisionId: opened.ref.headRevisionId
                })
                yield* api.CommitEditorDrafts({
                  refId: ref.id,
                  expectedRowVersion: opened.ref.rowVersion,
                  fields: [{ field, draftId: draft.id, expectedRowVersion: draft.rowVersion }],
                  message
                })
              }
              return ref.id
            })
          )
          await page.goto(`${url}/library/${id}`)
          await page.getByRole("button", { name: "History", exact: true }).click()
          const dialog = page.getByRole("dialog")
          const revisions = dialog.getByRole("list", { name: "Revisions" }).getByRole("listitem")
          await expect(revisions).toHaveCount(3)
          const audit = async (state: string) => {
            await page.mouse.move(0, 0)
            const surface = `${kind}-${state}-${width}-${theme}`
            const violations = await expectLayout(page, info, surface, { scope: '[role="dialog"]' })
            findings.push({ surface, violations })
            mkdirSync(work, { recursive: true })
            writeFileSync(join(work, `revisions-${width}-${theme}.json`), JSON.stringify(findings, null, 2))
            console.log(`${surface}: ${violations.length} violations`)
          }
          const measurePadding = async (state: string) => {
            const padding = await dialog.evaluate((el) => {
              const scroll = el.querySelector<HTMLElement>("[data-dialog-scroll]")!
              const content = el.querySelector<HTMLElement>("[data-dialog-content]")!
              const original = scroll.scrollTop
              scroll.scrollTop = 0
              const outer = el.getBoundingClientRect(),
                inner = content.getBoundingClientRect()
              scroll.scrollTop = scroll.scrollHeight
              const bottom = outer.bottom - content.getBoundingClientRect().bottom
              scroll.scrollTop = original
              return {
                left: inner.left - outer.left,
                right: outer.right - inner.right,
                top: inner.top - outer.top,
                bottom
              }
            })
            geometry.push({ kind, state, padding })
            mkdirSync(work, { recursive: true })
            writeFileSync(join(work, `geometry-${width}-${theme}.json`), JSON.stringify(geometry, null, 2))
            for (const value of Object.values(padding)) expect(value).toBeCloseTo(21, 1)
          }
          await expect(revisions.first().getByRole("button", { name: /^Restore to revision / })).toBeDisabled()
          await expect(revisions.nth(1).getByRole("button", { name: /^Restore to revision / })).toBeEnabled()
          await expect(dialog.getByText("Saved", { exact: true })).toHaveCount(0)
          await expect(
            revisions.last().getByRole("button", { name: "Add message to Revision 1", exact: true })
          ).toHaveText("Add message")
          const actions = revisions
            .nth(1)
            .getByRole("group", { name: "Revision 2 actions", exact: true })
            .getByRole("button")
          await expect(actions.nth(0)).toHaveText("Restore to revision 2")
          await expect(actions.nth(1)).toHaveText("Compare")
          const message = await revisions.nth(1).locator("[data-revision-message-row]").boundingBox()
          const restoreBox = await actions.nth(0).boundingBox()
          expect(message!.y + message!.height).toBeLessThanOrEqual(restoreBox!.y)
          if (kind === "card") {
            const titleGap = await page
              .locator("[data-card-name]")
              .first()
              .evaluate((el) => Number.parseFloat(getComputedStyle(el.parentElement!).columnGap))
            expect(titleGap).toBe(2)
            geometry.push({ kind, state: "title-pencil-gap", titleGap })
          }
          await measurePadding("list")
          await audit("list")
          await dialog.screenshot({
            path: info.outputPath(`${kind}-actions-${width}-${theme}.png`),
            animations: "disabled"
          })
          const measureRow = async (index: number, state: string) => {
            const metrics = await revisions
              .nth(index)
              .locator("[data-revision-message-row]")
              .evaluate((el) => {
                const field = el.querySelector("input")
                const text = el.querySelector(".truncate")
                const buttons = [...el.querySelectorAll("button")]
                const rect = (node: Element) => node.getBoundingClientRect()
                return {
                  height: rect(el).height,
                  ...(text ? { textPencilGap: rect(buttons[0]!).left - rect(text).right } : {}),
                  ...(field
                    ? {
                        inputConfirmGap: rect(buttons[0]!).left - rect(field).right,
                        confirmCancelGap: rect(buttons[1]!).left - rect(buttons[0]!).right
                      }
                    : {})
                }
              })
            rowHeights.push({ kind, state, ...metrics })
            writeFileSync(join(work, `message-rows-${width}-${theme}.json`), JSON.stringify(rowHeights, null, 2))
            expect(metrics.height).toBe(32)
            if (metrics.textPencilGap !== undefined) expect(metrics.textPencilGap).toBe(2)
            if (metrics.inputConfirmGap !== undefined) {
              expect(metrics.inputConfirmGap).toBe(4)
              expect(metrics.confirmCancelGap).toBe(4)
            }
          }
          for (const [index, state] of [
            [2, "none"],
            [1, "short"],
            [0, "long-collapsed"]
          ] as const) {
            await measureRow(index, state)
            await revisions.nth(index).screenshot({
              path: info.outputPath(`${kind}-message-${state}-${width}-${theme}.png`),
              animations: "disabled"
            })
          }
          await revisions.last().getByRole("button", { name: "Add message to Revision 1", exact: true }).click()
          await measureRow(2, "empty-editing")
          await revisions.last().screenshot({
            path: info.outputPath(`${kind}-message-empty-editing-${width}-${theme}.png`),
            animations: "disabled"
          })
          await dialog.getByRole("textbox", { name: "Message of Revision 1", exact: true }).press("Escape")
          const longText = revisions.first().locator("span.truncate")
          const fullMessage = await longText.innerText()
          await longText.hover()
          await expect(
            page
              .locator('[data-layout-overlay="Tooltip floats above the page"]')
              .getByText(fullMessage, { exact: true })
          ).toBeVisible()
          await page.mouse.move(0, 0)
          await revisions.first().getByRole("button", { name: "Expand message of Revision 3", exact: true }).click()
          await expect(
            revisions.first().getByRole("region", { name: "Full message of Revision 3", exact: true })
          ).toHaveText(fullMessage)
          await measureRow(0, "long-expanded")
          await audit("message-expanded")
          await revisions.first().screenshot({
            path: info.outputPath(`${kind}-message-long-expanded-${width}-${theme}.png`),
            animations: "disabled"
          })
          await revisions.first().getByRole("button", { name: "Collapse message of Revision 3", exact: true }).click()
          await revisions.first().getByRole("button", { name: "Edit message of Revision 3", exact: true }).click()
          await measureRow(0, "editing")
          await audit("message-inline-edit")
          await revisions.first().screenshot({
            path: info.outputPath(`${kind}-message-editing-${width}-${theme}.png`),
            animations: "disabled"
          })
          await dialog.getByRole("textbox", { name: "Message of Revision 3", exact: true }).press("Escape")
          const compare = revisions.nth(1).getByRole("button", { name: /^Revision \d+ / })
          const before = await compare.boundingBox()
          await compare.click()
          const after = await compare.boundingBox()
          expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(1)
          expect(Math.abs(after!.x - before!.x)).toBeLessThanOrEqual(1)
          await expect(
            revisions.nth(1).getByRole("button", { name: "Restore to revision 2", exact: true })
          ).toBeEnabled()
          const openDiff = async (beforeName: string, afterName: string) => {
            const field = dialog
              .locator("details")
              .filter({ has: page.locator("summary", { hasText: kind === "note" ? /^Content$/ : /^Description$/ }) })
            await field.locator("summary").click()
            if (width > 639) {
              await expect(field.getByRole("textbox", { name: beforeName, exact: true })).toBeVisible()
              await expect(field.getByRole("textbox", { name: afterName, exact: true })).toBeVisible()
            } else {
              await expect(field.getByRole("textbox", { name: "Changes", exact: true })).toBeVisible()
              await expect(field.getByText(`${beforeName} (−) → ${afterName} (+)`, { exact: true })).toBeVisible()
            }
          }
          await openDiff("Revision 1", "Revision 2")
          await expect(dialog.getByRole("button", { name: "Close comparison", exact: true })).toHaveCount(0)
          await expect(compare).toHaveAttribute("aria-pressed", "true")
          await expect(compare).toHaveAccessibleDescription("Click to hide this revision's comparison")
          const measureGaps = async (state: string) => {
            const measured = await dialog
              .getByRole("tablist", { name: "Revision comparison mode", exact: true })
              .evaluate((list) => {
                const section = list.closest('section[aria-label^="Comparison of revision"]')!
                const previous = section.previousElementSibling!.getBoundingClientRect()
                const tabs = list.getBoundingClientRect()
                const field = section.querySelector("details")!.getBoundingClientRect()
                return { above: tabs.top - previous.bottom, below: field.top - tabs.bottom }
              })
            expect(measured.above).toBeCloseTo(8, 1)
            expect(measured.below).toBeCloseTo(8, 1)
            gaps.push({ kind, state, ...measured })
            writeFileSync(join(work, `gaps-${width}-${theme}.json`), JSON.stringify(gaps, null, 2))
          }
          await measureGaps("previous")
          await measurePadding("comparison")
          await audit("comparison")
          await dialog.screenshot({
            path: info.outputPath(`${kind}-previous-${width}-${theme}.png`),
            animations: "disabled"
          })
          await dialog.getByRole("tab", { name: "Changes from current state", exact: true }).click()
          await expect(dialog.getByRole("tab", { name: "Changes from current state", exact: true })).toHaveAttribute(
            "aria-selected",
            "true"
          )
          await expect(
            revisions.nth(1).getByRole("button", { name: "Restore to revision 2", exact: true })
          ).toBeEnabled()
          await openDiff("Revision 2", "Current state")
          await measureGaps("current")
          await measurePadding("current-comparison")
          await audit("current-comparison")
          await dialog.screenshot({
            path: info.outputPath(`${kind}-current-${width}-${theme}.png`),
            animations: "disabled"
          })
          await revisions
            .last()
            .getByRole("button", { name: /^Revision \d+ / })
            .click()
          const firstTab = dialog.getByRole("tab", { name: "Changes from previous revision", exact: true })
          await expect(firstTab).toHaveAttribute("aria-selected", "true")
          await expect(dialog.getByText("Loading comparison…", { exact: true })).toHaveCount(0)
          await firstTab.hover()
          await expect(
            page.getByText("Shows this first revision's changes from an empty document", { exact: true })
          ).toBeVisible()
          await openDiff("Empty", "Revision 1")
          await measureGaps("first")
          await measurePadding("first-comparison")
          await audit("first-comparison")
          await dialog.screenshot({
            path: info.outputPath(`${kind}-empty-${width}-${theme}.png`),
            animations: "disabled"
          })
          const firstCompare = revisions.last().getByRole("button", { name: /^Revision \d+ / })
          await firstCompare.click()
          await expect(firstCompare).toHaveAttribute("aria-pressed", "false")
          await expect(firstCompare).toHaveAccessibleDescription("Click to compare this revision")
          await expect(dialog.getByRole("tablist")).toHaveCount(0)
          const latestCompare = revisions.first().getByRole("button", { name: /^Revision \d+ / })
          await latestCompare.click()
          await openDiff("Revision 2", "Revision 3")
          const fieldTitle = dialog.locator("details summary span").first()
          const titleOffset = await fieldTitle.evaluate(
            (el) => el.getBoundingClientRect().left - el.closest('[role="tabpanel"]')!.getBoundingClientRect().left
          )
          await dialog.getByRole("tab", { name: "Changes from current state", exact: true }).click()
          const empty = dialog
            .getByRole("tabpanel", { name: "Changes from current state", exact: true })
            .getByText("No fields differ.", { exact: true })
          await expect(empty).toBeVisible()
          const emptyOffset = await empty.evaluate(
            (el) => el.getBoundingClientRect().left - el.closest('[role="tabpanel"]')!.getBoundingClientRect().left
          )
          geometry.push({ kind, state: "no-fields", titleOffset, emptyOffset })
          expect(emptyOffset).toBeCloseTo(titleOffset, 1)
          await measurePadding("no-fields")
          await audit("no-fields")
          await dialog.screenshot({
            path: info.outputPath(`${kind}-no-fields-${width}-${theme}.png`),
            animations: "disabled"
          })
          await latestCompare.click()
          await revisions
            .first()
            .getByRole("button", { name: /^Edit message of/ })
            .click()
          await expect(dialog.getByRole("textbox", { name: /^Message of Revision/ })).toBeVisible()
          await audit("message")
        }
      })
})

// Focused footer review: only the four requested full-sidebar images.
for (const { width, height } of [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 }
]) {
  test(`split chats layout ${width}x${height} dark`, async ({ page }, info) => {
    const local = await startServer(withAdmin)
    try {
      const cookie = await loginCookie(local, ADMIN.handle, ADMIN.password)
      const seed = await withCookie(local, cookie, seedSplitChats)
      await withCookie(local, cookie, (api) => api.CreateChat({ title: "No splits" }))
      await apiLogin(page.request, local, ADMIN.handle, ADMIN.password)
      await page.setViewportSize({ width, height })
      await page.emulateMedia({ colorScheme: "dark" })
      const full = join(process.env.LAYOUT_AUDIT_WORK ?? info.outputDir, "full")
      mkdirSync(full, { recursive: true })
      writeFileSync(
        join(full, "index.md"),
        "# Sidebar review\n\n" +
          [
            "journeys-1440x1000-dark.png",
            "harbor-1440x1000-dark.png",
            "hills-1440x1000-dark.png",
            "journeys-390x844-dark.png"
          ]
            .map((file) => `- [${file}](${file})`)
            .join("\n") +
          "\n"
      )
      const measurements = []
      for (const [name, fork] of (width === 1440
        ? [
            ["journeys", seed.original],
            ["harbor", seed.market],
            ["hills", seed.hills]
          ]
        : [["journeys", seed.original]]) as Array<[string, typeof seed.original]>) {
        await page.goto(`${local.url}/chats/${seed.chatId}?fork=${fork}&side=chats`)
        if (width === 390) await expect(page.getByRole("button", { name: "Chats and menu", exact: true })).toBeVisible()
        await showAppNavigation(page)
        const column =
          width === 390
            ? page.locator('[data-layout-overlay="Mobile navigation drawer covers the page"]')
            : page.getByRole("complementary", { name: "Sidebar", exact: true })
        const branches = column.getByRole("region", { name: "Branches of the open chat", exact: true })
        await expect(branches).toHaveAttribute("aria-busy", "false")
        const splits = column.getByRole("region", { name: "Related chats", exact: true })
        await expect(splits).toHaveAttribute("aria-busy", "false")
        if (name === "hills") {
          // A source-only chat: one row under its caption, and no space below it.
          const source = splits.getByRole("group", { name: "This chat was split from", exact: true })
          await expect(source.locator("[data-fork-row]")).toHaveCount(1)
          await expect(splits.getByRole("group", { name: "Split off from this chat", exact: true })).toHaveCount(0)
          const body = splits.locator("[data-foot-body]")
          expect(await body.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1)
        }
        const measure = () =>
          column.evaluate((el) => {
            const list = el.querySelector<HTMLElement>("[data-shell-list]")!
            const third = list.querySelectorAll<HTMLElement>("[data-fork-row]")[2]!
            return {
              listHeight: list.clientHeight,
              threeRows: third.getBoundingClientRect().bottom - list.getBoundingClientRect().top + list.scrollTop,
              sections: [...el.querySelectorAll<HTMLElement>("[data-foot-section]")].map((section) => {
                const body = section.querySelector<HTMLElement>("[data-foot-body]")
                const open = body !== null && body.getAttribute("aria-hidden") !== "true"
                const box = body?.getBoundingClientRect()
                const visibleRows = open
                  ? [...body!.querySelectorAll<HTMLElement>("[data-fork-row]")].filter((row) => {
                      const r = row.getBoundingClientRect()
                      return r.top >= box!.top - 1 && r.bottom <= box!.bottom + 1
                    }).length
                  : 0
                return { name: section.ariaLabel, height: section.offsetHeight, open, visibleRows }
              })
            }
          })
        await expect
          .poll(async () => {
            const m = await measure()
            return m.listHeight - m.threeRows
          })
          .toBeGreaterThanOrEqual(-1)
        const m = await measure()
        for (const section of m.sections) if (section.open) expect(section.visibleRows).toBeGreaterThanOrEqual(1)
        if (name === "hills") expect(m.listHeight).toBeGreaterThan(measurements[0]!.listHeight)
        measurements.push({ name, ...m })
        await expectLayout(page, info, `split-${name}-${width}`, { scope: "[data-shell-list], [data-sidebar-feet]" })
        await column.screenshot({ path: join(full, `${name}-${width}x${height}-dark.png`) })
      }
      writeFileSync(join(full, `measurements-${width}x${height}-dark.json`), JSON.stringify(measurements, null, 2))
    } finally {
      await local.stop()
    }
  })
}

test("phone footer click overrides height collapse", async ({ page }, info) => {
  const local = await startServer(withAdmin)
  try {
    const cookie = await loginCookie(local, ADMIN.handle, ADMIN.password)
    const seed = await withCookie(local, cookie, seedSplitChats)
    await apiLogin(page.request, local, ADMIN.handle, ADMIN.password)
    await exercisePhoneFooters(page, info, `${local.url}/chats/${seed.chatId}?fork=${seed.original}&side=chats`, true)
  } finally {
    await local.stop()
  }
})

// The tiles' toggles over their pictures are audited at rest as well as hovered and focused
// (owner, 2026-11-06: the archive toggle showed on every tile, off its corner, its backing
// doubled), on the views a card can be archived from: Home's All and Archived, the sidebar's
// tiles, and a card's headers (its page; the full editor, archived or not).
for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`card archive surfaces: ${width} ${theme}`, async ({ page }, info) => {
      test.setTimeout(240_000)
      const local = await startServer(withAdmin)
      try {
        await seedCardArchive(local)
        await apiLogin(page.request, local, ADMIN.handle, ADMIN.password)
        await page.setViewportSize({ width, height: 900 })
        await page.emulateMedia({ colorScheme: theme })
        await page.goto(`${local.url}/`)
        const main = page.getByRole("main")
        // All: the favourite (Pilot 006, its star on) among ordinary tiles.
        await expect(main.getByRole("link", { name: "Open Pilot 006", exact: true })).toBeVisible()
        await expectLayout(page, info, `cardarchive-all-rest-${width}-${theme}`, { scope: "main" })
        await main.screenshot({ path: info.outputPath("all-rest.png") })
        await main.getByRole("link", { name: "Open Pilot 007", exact: true }).hover()
        await expectLayout(page, info, `cardarchive-all-hovered-${width}-${theme}`, { scope: "main", hovered: true })
        await main.getByRole("link", { name: "Open Pilot 006", exact: true }).focus()
        await expectLayout(page, info, `cardarchive-all-focused-${width}-${theme}`, { scope: "main" })
        await page.goto(`${local.url}/?show=archived&side=characters&sideShow=archived`)
        await expect(main.getByRole("link", { name: "Open Pilot 001", exact: true })).toBeVisible()
        await expectLayout(page, info, `cardarchive-home-${width}-${theme}`, { scope: "main" })
        await main.screenshot({ path: info.outputPath("home.png") })
        await main.getByRole("link", { name: "Open Pilot 002", exact: true }).hover()
        await expectLayout(page, info, `cardarchive-home-hovered-${width}-${theme}`, { scope: "main", hovered: true })
        await main.getByRole("button", { name: "Archive unused cards…", exact: true }).click()
        const dialog = page.getByRole("dialog", { name: "Archive unused cards", exact: true })
        await expect(dialog.getByRole("checkbox", { name: "Pilot 008", exact: true })).toBeVisible()
        await expectLayout(page, info, `cardarchive-dialog-${width}-${theme}`, { scope: '[role="dialog"]' })
        await dialog.screenshot({ path: info.outputPath("dialog.png") })
        await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
        await showAppNavigation(page)
        const list = page.locator("[data-shell-list]").filter({ visible: true })
        await expect(list.getByRole("link", { name: "Open Pilot 001", exact: true })).toBeVisible()
        await expectLayout(page, info, `cardarchive-sidebar-${width}-${theme}`, { scope: "[data-shell-list]" })
        await list.screenshot({ path: info.outputPath("sidebar.png") })
        await page.goto(`${local.url}/?side=characters&sideShow=all`)
        // Navigation's optional toggle helper must run after the new app has mounted.
        if (width === 390) await expect(page.getByRole("button", { name: "Chats and menu", exact: true })).toBeVisible()
        await showAppNavigation(page)
        await expect(list.getByRole("link", { name: "Open Pilot 006", exact: true })).toBeVisible()
        await expectLayout(page, info, `cardarchive-sidebar-all-${width}-${theme}`, { scope: "[data-shell-list]" })
        await list.screenshot({ path: info.outputPath("sidebar-all.png") })
        for (const [slug, path] of [
          ["page", "/cards/archive-e-006"],
          ["editor", "/library/archive-r-archive-e-006"],
          ["archived-editor", "/library/archive-r-archive-e-001"]
        ] as const) {
          await page.goto(`${local.url}${path}`)
          // The toggles sit in the center column's header, outside its main region.
          const header = page.locator("[data-center-header]").filter({ visible: true })
          await expect(header.getByRole("button", { name: /^(Unarchive|Archive) Pilot 00[16]$/ })).toBeVisible()
          await expect(header.getByRole("button", { name: /favourites$/ })).toBeVisible()
          await expectLayout(page, info, `cardarchive-header-${slug}-${width}-${theme}`, {
            scope: "[data-center-header]"
          })
          await page.screenshot({ path: info.outputPath(`header-${slug}.png`) })
        }
      } finally {
        await local.stop()
      }
    })

// Focus with --grep "Google connection"; the same surfaces as the provider gate.
test.describe("Google connection layout", googleConnectionTests)

// Focused audit for the two new text-search surfaces; no large import is needed.
test.describe("text search review layout", () => {
  let local: TestServer
  test.beforeAll(async () => {
    local = await startServer(withAdmin)
    const cookie = await loginCookie(local, ADMIN.handle, ADMIN.password)
    await withCookie(local, cookie, (api) =>
      Effect.gen(function* () {
        yield* api.CreateCard({
          label: "Lighthouse keeper",
          name: "Lighthouse keeper",
          description: "The lighthouse is lit."
        })
        const chat = yield* api.CreateChat({ title: "Harbour nights" })
        yield* api.SendMessage({
          chatId: chat.id,
          parentSlotId: null,
          branch: false,
          content: "The lighthouse is lit.",
          reply: false
        })
      })
    )
  })
  test.afterAll(async () => {
    await local?.stop()
  })
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"] as const)
      test(`${width} ${theme}`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 900 })
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
        await apiLogin(page.request, local, ADMIN.handle, ADMIN.password)
        await page.goto(`${local.url}/?side=chats&sideIn=messages&sideQ=lighthouse`)
        if (width === 390) await page.getByRole("button", { name: "Chats and menu", exact: true }).click()
        await expect(page.locator("[data-message-hit]:visible")).toHaveCount(1)
        await expectLayout(page, info, `message-search-review-${width}-${theme}`, {
          scope: width === 390 ? ".fixed.inset-0" : '[aria-label="Sidebar"]'
        })
        await page.goto(`${local.url}/library?replace=open&find=lighthouse`)
        const panel = page.getByRole("region", { name: "Search and replace across the library" })
        await panel.getByRole("textbox", { name: "Replace with", exact: true }).fill("beacon")
        await panel.getByRole("button", { name: "Find", exact: true }).click()
        await expect(panel.locator("[data-library-hit]")).toHaveCount(1)
        await expectLayout(page, info, `library-search-review-${width}-${theme}`, { scope: "main" })
      })
})

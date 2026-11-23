// A tab left open across a rebuild (staleBuild.tsx). The server serves a copy of the built
// client; the test swaps it under the open tab, as a deploy does: a new build id, and the old
// build's lazy chunks gone. A lazy panel then asks for a reload (never "the server can't be
// reached"), one app-wide notice says the app was updated, and with nothing typed the tab
// reloads by itself once. Synthetic card and chat.
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { layoutAudit } from "./support/layoutAudit.ts"
import { openPanel } from "./support/panel.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { expectTextBox } from "./support/textbox.ts"

const built = new URL("../dist/", import.meta.url).pathname
const dist = join(mkdtempSync(join(tmpdir(), "rp-stale-build-")), "dist")
cpSync(built, dist, { recursive: true })
const assets = join(dist, "assets")
const hidden = join(dist, "..", "hidden-assets")
const stampFile = join(dist, "build-id.json")
const originalStamp = readFileSync(stampFile, "utf8")

const server = serverPerFile({ ...withAdmin, CLIENT_DIST: dist })
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)

/**
 * As a deploy: the server now names another build, and the old build's lazy chunks are gone.
 * What the page itself names stays, so a reload still starts (here on the old entry, which
 * shows whether a reloaded tab loops).
 */
const deployNewBuild = () => {
  writeFileSync(stampFile, JSON.stringify({ buildId: "the-next-build" }))
  mkdirSync(hidden, { recursive: true })
  const page = readFileSync(join(dist, "index.html"), "utf8")
  for (const file of readdirSync(assets))
    if (file.endsWith(".js") && !page.includes(file)) renameSync(join(assets, file), join(hidden, file))
}
/** Back to the tab's own build (what the reload would have fetched, in a real deploy). */
const restoreBuild = () => {
  writeFileSync(stampFile, originalStamp)
  for (const file of readdirSync(hidden)) renameSync(join(hidden, file), join(assets, file))
}
test.afterEach(() => {
  mkdirSync(hidden, { recursive: true })
  restoreBuild()
})
test.afterAll(() => rmSync(join(dist, ".."), { recursive: true, force: true }))

const makeChat = (name: string) =>
  admin((api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title: name })
      return chat.id
    })
  )

const openChat = async (page: Page, chatId: string) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chatId}`)
  await expect(page.getByLabel("Message", { exact: true })).toBeEditable()
}

for (const width of [390, 1440]) {
  test(`a panel whose chunk is gone after a rebuild asks for a reload, with typed text kept ${width}`, async ({
    page
  }, info) => {
    await page.setViewportSize({ width, height: 900 })
    const chatId = await makeChat(`Stale ${width}`)
    await openChat(page, chatId)
    let reloads = 0
    // A full page load (the URL also changes in place as panels open, which isn't one).
    page.on("load", () => reloads++)
    const before = reloads
    // Typed text: the tab must not reload by itself.
    await page.getByLabel("Message", { exact: true }).fill("Half a sentence I am still writing")
    deployNewBuild()
    const panel = await openPanel(page, "Prompt preset")
    await expect(panel.getByText("This part needs a reload.", { exact: true })).toBeVisible({ timeout: 20_000 })
    await expect(panel.getByRole("button", { name: "Reload", exact: true })).toBeVisible()
    await expect(page.getByText("the server can't be reached", { exact: false })).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0)
    const notice = page.getByRole("status", { name: "App updated" })
    await expect(notice.getByText("The app was updated. Reload to continue.", { exact: true })).toBeVisible()
    await expect(notice).toHaveCount(1)
    // The Reload button explains itself on hover (the phone sheet covers the banner).
    await panel.getByRole("button", { name: "Reload", exact: true }).hover()
    await expect(page.locator('[data-layout-overlay="Tooltip floats above the page"]')).toContainText(
      "The app was updated while this tab was open."
    )
    expect(reloads).toBe(before)
    await expectTextBox(page.getByLabel("Message", { exact: true }), "Half a sentence I am still writing")
    await page.mouse.move(0, 0)
    await page.screenshot({ path: info.outputPath(`stale-${width}.png`) })
    const findings = (await layoutAudit(page)).filter(
      (v) =>
        v.selector.includes("#client-version-notice") ||
        v.related?.includes("#client-version-notice") ||
        v.selector.includes("data-stale-part") ||
        v.related?.includes("data-stale-part")
    )
    expect(findings).toEqual([])

    // Reload: the typed text is still there in the new build.
    restoreBuild()
    await panel.getByRole("button", { name: "Reload", exact: true }).click()
    await expectTextBox(page.getByLabel("Message", { exact: true }), "Half a sentence I am still writing", {
      timeout: 20_000
    })
    await expect(page.getByRole("status", { name: "App updated" })).toHaveCount(0)
  })
}

test("with nothing typed, a chunk lost to a rebuild reloads the tab once", async ({ page }) => {
  const chatId = await makeChat("Stale auto")
  await openChat(page, chatId)
  const reloaded = page.waitForEvent("load", { timeout: 20_000 })
  deployNewBuild()
  // The tab reloads while the panel opens, so the helper may not see its tabs.
  void openPanel(page, "Prompt preset").catch(() => undefined)
  await reloaded
  // Once per server build: the reloaded tab (still served the gone build here) doesn't loop.
  let loads = 0
  page.on("load", () => loads++)
  await expect(page.getByText("The app was updated. Reload to continue.", { exact: true })).toBeVisible({
    timeout: 20_000
  })
  await page.waitForTimeout(2000)
  expect(loads).toBe(0)
})

test("the notice shows early when the tab regains focus after a deploy", async ({ page }) => {
  const chatId = await makeChat("Stale focus")
  await openChat(page, chatId)
  writeFileSync(stampFile, JSON.stringify({ buildId: "the-next-build" }))
  await page.evaluate(() => window.dispatchEvent(new Event("focus")))
  await expect(page.getByText("The app was updated. Reload to continue.", { exact: true })).toBeVisible()
})

import { expect, type Page, test } from "@playwright/test"
import type { RefId } from "@rp/shared/library.ts"
import type { EntityId } from "@rp/shared/chat.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { openPanel } from "./support/panel.ts"
import { portraitPng } from "./support/portrait.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
test.setTimeout(180_000)
const seed = async (page: Page, name: string) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const response = await page.request.post(`${server().url}/library/import?name=gallery.json`, {
    headers: { "content-type": "application/octet-stream", origin: server().url },
    data: Buffer.from(
      JSON.stringify({
        spec: "chara_card_v3",
        spec_version: "3.0",
        data: { name, description: "Synthetic gallery card", extensions: {} }
      })
    )
  })
  expect(response.status()).toBe(200)
  return (await response.json()).library.ref as { id: RefId; entityId: EntityId }
}
const pick = async (page: Page, names: string[]) => {
  const chooser = page.waitForEvent("filechooser")
  await page.locator("[data-gallery]").getByRole("button", { name: "Add images", exact: true }).click()
  await (
    await chooser
  ).setFiles(names.map((name, i) => ({ name: `${name}.png`, mimeType: "image/png", buffer: portraitPng([], i) })))
  await expect(page.locator("[data-gallery-image]")).toHaveCount(names.length)
  await expect(page.getByRole("button", { name: "Add images", exact: true })).toBeEnabled()
}
const actions = async (page: Page, name: string) =>
  page.getByRole("button", { name: `Actions for ${name}`, exact: true }).click()

for (const width of [1440, 390])
  test(`Gallery add, rename, kind, viewer, remove and restore at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    const ref = await seed(page, `Gallery ${width}`)
    await page.goto(`${server().url}/library/${ref.id}?cardTab=Extra`)
    await page.getByRole("tab", { name: "Extra", exact: true }).click()
    await pick(page, ["Coat", "Map"])
    const transfer = await page.evaluateHandle((base64) => {
      const data = new DataTransfer()
      data.items.add(
        new File([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], "Dropped.png", { type: "image/png" })
      )
      return data
    }, portraitPng([], 4).toString("base64"))
    await page.locator("[data-gallery]").dispatchEvent("drop", { dataTransfer: transfer })
    await transfer.dispose()
    await expect(page.getByRole("button", { name: "View Dropped", exact: true })).toBeVisible()
    await expect(page.getByRole("button", { name: "Add images", exact: true })).toBeEnabled()

    await actions(page, "Map")
    await page.getByRole("menuitem", { name: "Rename", exact: true }).click()
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("Night map")
    await page.getByRole("button", { name: "Save name", exact: true }).click()
    await expect(page.getByRole("dialog", { name: "Rename image" })).toHaveCount(0)
    await expect(page.getByRole("button", { name: "View Night map", exact: true })).toBeVisible()
    await actions(page, "Coat")
    await page.getByRole("menuitem", { name: "Kind", exact: true }).click()
    await page.getByRole("menuitemradio", { name: "Portrait", exact: true }).click()
    await expect(page.getByRole("heading", { name: "Portraits", exact: true })).toBeVisible()
    await page.getByRole("button", { name: "View Night map", exact: true }).click()
    await expect(page.getByRole("dialog", { name: `Gallery ${width} · Night map`, exact: true })).toBeVisible()
    const dialog = page.getByRole("dialog", { name: `Gallery ${width} · Night map`, exact: true })
    await dialog.locator("[data-viewer-header]").click({ button: "right" })
    await expect(page.getByRole("menu")).toHaveCount(0)
    await dialog.getByRole("button", { name: "Close", exact: true }).click()
    await expect(page.getByRole("dialog", { name: `Gallery ${width} · Night map`, exact: true })).toHaveCount(0)
    await actions(page, "Night map")
    await page.getByRole("menuitem", { name: "Remove", exact: true }).click()
    await expect(page.getByRole("button", { name: "View Night map", exact: true })).toHaveCount(0)
    const item = await admin((api) => api.ListBin({ limit: 50, before: null }))
    const removed = item.find((i) => i.kind === "card_asset" && i.title === "Night map")!
    await admin((api) => api.RestoreBinItem({ itemId: removed.id }))
    await page.reload()
    await page.getByRole("tab", { name: "Extra", exact: true }).click()
    await expect(page.getByRole("button", { name: "View Night map", exact: true })).toBeVisible()
    await actions(page, "Coat")
    await page.getByRole("menuitem", { name: "Use as portrait", exact: true }).click()
    await expect(page.getByRole("button", { name: "View Coat", exact: true })).toHaveCount(0)
    await expect(page.locator("[data-card-header-portrait] img")).toHaveCount(1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })

for (const width of [1440, 1024])
  test(`gallery images toggle; headers reorder on release, by menu and keyboard; native context menu at ${width}`, async ({
    page
  }, info) => {
    await page.setViewportSize({ width, height: 900 })
    const ref = await seed(page, "Stack gallery")
    const started = await admin((api) =>
      api.StartChat({
        cards: [ref.entityId],
        persona: null,
        greeting: null,
        first: { _tag: "Send", content: "At the harbor.", speakerEntityId: null }
      })
    )
    await page.goto(`${server().url}/chats/${started.chat.id}`)
    const panel = await openPanel(page, "Stack gallery")
    await panel.getByRole("tab", { name: "Extra", exact: true }).click()
    await pick(page, ["First", "Second", "Third"])
    const grid = page.locator("[data-gallery]")
    for (const name of ["First", "Second", "Third"])
      await grid.getByRole("button", { name: `View ${name}`, exact: true }).click()
    const viewers = page.locator("[data-portrait-viewer]")
    const order = () => viewers.locator("h2").allTextContents()
    await expect.poll(order).toEqual(["Stack gallery · Third", "Stack gallery · Second", "Stack gallery · First"])
    await grid.getByRole("button", { name: "View Second", exact: true }).click()
    await expect(viewers).toHaveCount(2)
    await grid.getByRole("button", { name: "View Second", exact: true }).click()
    await expect.poll(order).toEqual(["Stack gallery · Second", "Stack gallery · Third", "Stack gallery · First"])
    const header = (name: string) =>
      page
        .locator("[data-viewer-header]")
        .filter({ has: page.getByRole("heading", { name: `Stack gallery · ${name}`, exact: true }) })
    await header("Second").focus()
    await page.keyboard.press("Alt+ArrowDown")
    await expect.poll(order).toEqual(["Stack gallery · Third", "Stack gallery · Second", "Stack gallery · First"])
    await header("First").click({ button: "right" })
    await expect(page.getByRole("menu")).toHaveCount(0)
    expect(
      await header("First").evaluate((node) =>
        node.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))
      )
    ).toBe(true)
    await header("Second").focus()
    await page.keyboard.press("Shift+F10")
    await expect(page.getByRole("menu")).toHaveCount(0)
    await header("First").getByRole("button", { name: "Viewer options", exact: true }).click()
    await expect(page.getByRole("menuitem", { name: "Move down", exact: true })).toBeDisabled()
    await expect(page.getByRole("menuitem", { name: "Move up", exact: true })).toBeEnabled()
    await page.getByRole("menuitem", { name: /Move to top/ }).click()
    await expect.poll(order).toEqual(["Stack gallery · First", "Stack gallery · Third", "Stack gallery · Second"])
    const from = (await header("First").boundingBox())!
    const to = (await viewers.last().boundingBox())!
    await page.mouse.move(from.x + 12, from.y + 15)
    await page.mouse.down()
    await page.mouse.move(from.x + 12, to.y + to.height / 2, { steps: 12 })
    await expect(page.locator("[data-viewer-drop-indicator]")).toBeVisible()
    await expect.poll(order).toEqual(["Stack gallery · First", "Stack gallery · Third", "Stack gallery · Second"])
    // Repeated moves over a destination leave both the panes and preview stable.
    const preview = await page.locator("[data-viewer-drop-indicator]").boundingBox()
    await page.mouse.move(from.x + 14, to.y + to.height / 2 + 2, { steps: 5 })
    expect(await page.locator("[data-viewer-drop-indicator]").boundingBox()).toEqual(preview)
    await page.mouse.up()
    await expect(page.locator("[data-viewer-drop-indicator]")).toHaveCount(0)
    await expect.poll(order).toEqual(["Stack gallery · Third", "Stack gallery · Second", "Stack gallery · First"])
    const column = page.locator("[data-portrait-column]")
    expect(await column.evaluate((node) => node.scrollHeight <= node.clientHeight + 1)).toBe(true)
    await page.reload()
    await expect.poll(order).toEqual(["Stack gallery · Third", "Stack gallery · Second", "Stack gallery · First"])
    const cancelFrom = (await header("Third").boundingBox())!
    const cancelTo = (await viewers.last().boundingBox())!
    await page.mouse.move(cancelFrom.x + 12, cancelFrom.y + 15)
    await page.mouse.down()
    await page.mouse.move(cancelFrom.x + 12, cancelTo.y + cancelTo.height / 2, { steps: 8 })
    await expect(page.locator("[data-viewer-drop-indicator]")).toBeVisible()
    await header("Third").dispatchEvent("pointercancel", { pointerId: 1 })
    await expect(page.locator("[data-viewer-drop-indicator]")).toHaveCount(0)
    await page.mouse.up()
    await expect.poll(order).toEqual(["Stack gallery · Third", "Stack gallery · Second", "Stack gallery · First"])
    await header("Third").getByRole("button", { name: "Viewer options", exact: true }).click()
    const keep = page.getByRole("menuitemcheckbox", { name: "Keep one image open", exact: true })
    await expect(keep).toHaveAttribute("aria-checked", "false")
    await expect(keep.locator("svg")).toHaveCount(1)
    await expect(page.getByRole("menuitem", { name: "Move up", exact: true })).toBeDisabled()
    await expect(page.getByRole("menuitem", { name: "Move to top", exact: true })).toBeDisabled()
    await expect(page.getByRole("menuitem", { name: "Move down", exact: true })).toBeEnabled()
    await page
      .getByRole("menu", { name: "Viewer options", exact: true })
      .screenshot({ path: info.outputPath(`menu-after-${width}.png`), animations: "disabled" })
    await keep.click()
    await expect(viewers).toHaveCount(1)
    await header("Third").getByRole("button", { name: "Viewer options", exact: true }).click()
    await expect(keep).toHaveAttribute("aria-checked", "true")
    await keep.click()
    const cdp = await page.context().newCDPSession(page)
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 })
    const touchHeader = (await header("Third").boundingBox())!
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: touchHeader.x + 12, y: touchHeader.y + 15 }]
    })
    await page.waitForTimeout(800)
    await expect(page.getByRole("menu")).toHaveCount(0)
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
    await expect(page.getByRole("menu")).toHaveCount(0)
    await header("Third").getByRole("button", { name: "Close the portrait", exact: true }).click()
    await expect(viewers).toHaveCount(0)
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false })
    await actions(page, "First")
    await page.getByRole("menuitem", { name: "Kind", exact: true }).click()
    await page.getByRole("menuitemradio", { name: "Portrait", exact: true }).click()
    await actions(page, "First")
    await page.getByRole("menuitem", { name: "Use as portrait", exact: true }).click()
    await expect(panel.getByRole("button", { name: "View Stack gallery's picture", exact: true })).toBeVisible()
  })

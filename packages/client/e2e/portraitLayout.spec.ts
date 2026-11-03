import { join } from "node:path"
import { openPanel, panelTab } from "./support/panel.ts"
import { expect, type Page, test } from "@playwright/test"
import { writeRealisticStFolder } from "../../server/test/support/stRealistic.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "60" })
test.setTimeout(240_000)
let lantern = ""
const openChat = async (page: Page, width: number) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  if (!lantern) {
    const folder = writeRealisticStFolder(join(server().dataDir, "st"))
    await page.goto(`${server().url}/import/st`)
    await page.getByLabel("Folder path").fill(folder)
    await page.getByRole("button", { name: "Look in this folder" }).click()
    await page.getByRole("button", { name: "Import", exact: true }).click()
    await expect(page.getByRole("list", { name: "Imported" })).toBeVisible({ timeout: 180_000 })
    await page.goto(`${server().url}/chats`)
    const chat = page
      .getByRole("main")
      .getByRole("link")
      .filter({ hasText: "The Lantern Inn" })
      .filter({ hasText: "380 messages" })
    lantern = (await chat.getAttribute("href"))!
  }
  await page.goto(`${server().url}${lantern}`)
  await expect(page.getByLabel("Message", { exact: true })).toBeEditable()
}
const shoot = async (page: Page, name: string) => {
  if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.SCREENSHOT_DIR, `${name}.png`) })
}

test("phone sheets close immediately and after changing image privacy", async ({ page }) => {
  await openChat(page, 390)
  await page.goto(`${server().url}${lantern}?panel=cast`)
  await expect(page.getByRole("dialog")).toBeVisible()
  await shoot(page, "cast-390")
  await page.getByRole("button", { name: "Close", exact: true }).click({ timeout: 3000 })
  await expect(page.getByRole("dialog")).toHaveCount(0)
  for (const mode of ["Blur", "Hide"]) {
    await openPanel(page, "This chat")
    const sheet = page.getByRole("dialog").first()
    const toggle = sheet.getByRole("button", { name: /^(Blur|Hide|Show) all images$/ })
    await toggle.click({ button: "right" })
    await page
      .getByRole("menuitemradio", {
        name: mode === "Blur" ? "Blur hidden images" : "Remove hidden images",
        exact: true
      })
      .click()
    if (mode === "Blur") await toggle.click()
    await page.mouse.move(0, 0)
    await toggle.hover()
    const tooltip = page.getByText(
      "Shows or hides images on this device (Alt+Shift+B). Right-click to choose blur or hide.",
      { exact: true }
    )
    await expect(tooltip).toBeVisible()
    await expect(tooltip).toHaveCSS("pointer-events", "none")
    const tip = (await tooltip.boundingBox())!
    const close = (await sheet.getByRole("button", { name: "Close", exact: true }).boundingBox())!
    expect(tip.y).toBeGreaterThanOrEqual(close.y + close.height)
    await shoot(page, `portrait-${mode.toLowerCase()}-390`)
    await sheet.getByRole("button", { name: "Close", exact: true }).click({ timeout: 3000 })
    await expect(page.getByRole("dialog")).toHaveCount(0)
  }
})

test("permitted sidebar widths keep a group composer and Send inside the chat", async ({ page }) => {
  await openChat(page, 1440)
  const message = page.getByLabel("Message", { exact: true })
  const draft = "Review draft: every action remains reachable."
  await message.fill(draft)
  await openPanel(page, "This chat")
  for (const [label, key] of [
    ["Resize sidebar", "ArrowRight"],
    ["Resize chat panel", "ArrowLeft"]
  ] as const) {
    await page.getByRole("separator", { name: label }).focus()
    for (let i = 0; i < 12; i++) await page.keyboard.press(`Shift+${key}`)
  }
  const check = async () => {
    const panel = (await page.getByRole("complementary", { name: "Chat panel" }).boundingBox())!
    const send = page.getByRole("button", { name: /^Send as / })
    const bounds = (await send.boundingBox())!
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(panel.x)
    expect((await message.boundingBox())!.width).toBeGreaterThanOrEqual(120)
    await send.click({ trial: true })
    await expect(message).toHaveValue(draft)
  }
  await check()
  await shoot(page, "max-resize-1440")
  await page.reload()
  await expect(message).toHaveValue(draft)
  await check()
  await shoot(page, "resize-reload-1440")
  await page.setViewportSize({ width: 1024, height: 900 })
  await expect.poll(async () => (await message.boundingBox())!.width).toBeGreaterThanOrEqual(120)
  await check()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole("button", { name: "Close", exact: true }).click()
  expect((await message.boundingBox())!.width).toBeGreaterThanOrEqual(120)
  await page.getByRole("button", { name: /^Send as / }).click({ trial: true })
  await expect(message).toHaveValue(draft)
  await shoot(page, "composer-390")
})

for (const width of [1440, 390]) {
  test(`the panel's tools fit one row at ${width}`, async ({ page }) => {
    await openChat(page, width)
    await openPanel(page, "This chat")
    const list = page.getByRole("tablist", { name: "Chat panel", exact: true })
    const bounds = (await list.boundingBox())!
    // One row: what doesn't fit is under More tools, the tab open always shown.
    expect(bounds.height).toBeLessThan(44)
    await expect(list.getByRole("tab", { name: "This chat", exact: true })).toHaveAttribute("aria-selected", "true")
    for (const tab of await list.getByRole("tab").all()) {
      const box = (await tab.boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(bounds.x)
      expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1)
      expect(box.y).toBeGreaterThanOrEqual(bounds.y - 1)
    }
    await shoot(page, `portrait-tabs-${width}`)
    await panelTab(page, "Summaries")
    await expect(page.getByRole("tab", { name: "Summaries", exact: true })).toHaveAttribute("aria-selected", "true")
    await shoot(page, `summaries-${width}`)
  })
}

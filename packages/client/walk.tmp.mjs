import { chromium } from "playwright"
const [base, stPath, out] = process.argv.slice(2)
const browser = await chromium.launch()
const shot = async (page, name) => {
  for (const [w, d] of [[1440, "desktop"], [390, "phone"]]) {
    await page.setViewportSize({ width: w, height: 900 })
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${out}/${name}-${d}.png`, fullPage: false })
  }
  await page.setViewportSize({ width: 1440, height: 900 })
}
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await page.goto(`${base}/import/st`)
await page.getByLabel("Folder path").fill(stPath)
await page.getByRole("button", { name: "Look in this folder" }).click()
await page.getByRole("button", { name: "Import", exact: true }).click()
await page.getByRole("list", { name: "Imported" }).waitFor({ timeout: 180000 })
await shot(page, "01-import-report")
await page.goto(`${base}/`); await page.waitForTimeout(1500); await shot(page, "02-home")
await page.goto(`${base}/chats`); await page.waitForTimeout(1500); await shot(page, "03-chats")
await page.goto(`${base}/library`); await page.waitForTimeout(1500); await shot(page, "04-library")
// The first chat in the list, then a group chat.
await page.goto(`${base}/chats`); await page.waitForTimeout(1000)
const links = page.locator("a[href^='/chats/']")
const hrefs = await links.evaluateAll((as) => as.map((a) => [a.getAttribute("href"), a.textContent]))
console.log(JSON.stringify(hrefs.slice(0, 40)))
const lantern = hrefs.find(([, t]) => /Lantern/i.test(t ?? "")) ?? hrefs[0]
await page.goto(`${base}${hrefs[0][0]}`); await page.waitForTimeout(2500); await shot(page, "05-chat-first")
await page.goto(`${base}${lantern[0]}`); await page.waitForTimeout(2500); await shot(page, "06-chat-group")
const settings = page.getByRole("button", { name: /settings/i }).first()
if (await settings.count()) { await settings.click(); await page.waitForTimeout(800); await shot(page, "07-chat-settings") }
await browser.close()

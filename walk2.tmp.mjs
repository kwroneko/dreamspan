// Continue and reasoning in the Lantern Inn (380 messages), against the slow mock provider.
import { chromium } from "playwright"
const [base, out] = process.argv.slice(2)
const browser = await chromium.launch()
const errors = []
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on("pageerror", (e) => errors.push(String(e)))
const shot = async (name, phone = false) => {
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${out}/${name}-desktop.png` })
  if (!phone) return
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(500)
  await page.screenshot({ path: `${out}/${name}-phone.png` })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.waitForTimeout(300)
}
const step = (what) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${what}`)

// The default model: the one that takes a prefill.
await page.goto(`${base}/settings/chats`)
await page.getByRole("combobox", { name: "Default model" }).click()
await page.getByRole("option", { name: /mock-prefill/ }).click()
await page.waitForTimeout(800)
step("default model set")

await page.goto(`${base}/chats`)
await page.waitForTimeout(1500)
const links = await page
  .getByRole("main")
  .locator("a[href^='/chats/']")
  .evaluateAll((as) => as.map((a) => [a.getAttribute("href"), a.textContent]))
const lantern = links.find(([, t]) => /Lantern Inn/.test(t ?? "") && /38[0-9] messages/.test(t ?? ""))
const chatUrl = `${base}${lantern[0]}`
await page.goto(chatUrl)
await page.waitForTimeout(2500)
step("chat open")

// A reply streams: reasoning first, open.
await page.getByRole("button", { name: /^Generate(?! another)/ }).last().click()
await page.waitForTimeout(1100)
await shot("w01-reasoning-streaming", true)
await page.waitForTimeout(2500)
await shot("w02-text-streaming")
// Stop it midway.
await page.getByRole("article").last().getByRole("button", { name: "Stop" }).click()
await page.waitForTimeout(800)
step("stopped")
const last = () => page.getByRole("article").last()
await last().hover()
await shot("w03-stopped-actions")
await last().getByRole("button", { name: /^Continue/ }).hover()
await page.waitForTimeout(700)
await shot("w04-continue-tooltip")
await last().getByRole("button", { name: /^Continue/ }).click()
await page.waitForTimeout(1500)
await shot("w05-continuing", true)
await last().getByText("Before the watch changes").waitFor({ timeout: 20000 })
await page.waitForTimeout(500)
step("continued")
await last().hover()
await shot("w06-continued")
await last().getByRole("button", { name: /choose a version/ }).click()
await page.waitForTimeout(500)
await shot("w07-version-picker")
await page.keyboard.press("Escape")

// Reasoning: folded once done; one click opens it; still there after a reload.
await last().getByRole("button", { name: /Reasoning/ }).click()
await shot("w08-reasoning-expanded", true)
await page.reload()
await page.waitForTimeout(3000)
await shot("w09-after-reload")
await last().getByRole("button", { name: /Reasoning/ }).click()
await shot("w10-after-reload-expanded", true)

// The inspector: the reply continued as the start of the next one.
await last().hover()
await last().getByRole("button", { name: "More actions" }).click()
await page.getByRole("menuitem", { name: "Context it was generated from" }).click()
await page.waitForTimeout(2000)
const toBottom = () =>
  page.evaluate(() => {
    for (const el of [document.scrollingElement, ...document.querySelectorAll("*")])
      if (el && el.scrollHeight > el.clientHeight + 10) el.scrollTop = el.scrollHeight
  })
for (let i = 0; i < 6; i++) {
  await toBottom()
  await page.waitForTimeout(400)
}
await page.getByText(/as it was, continued from its end/).last().waitFor({ timeout: 5000 })
await shot("w11-inspector")
await page.setViewportSize({ width: 390, height: 844 })
await page.waitForTimeout(500)
for (let i = 0; i < 6; i++) {
  await toBottom()
  await page.waitForTimeout(400)
}
await page.screenshot({ path: `${out}/w11-inspector-phone.png` })
await page.setViewportSize({ width: 1440, height: 900 })
await page.goBack()
await page.waitForTimeout(2500)

// Another model, which takes no prefill: Continue says why it isn't available.
const url = new URL(page.url())
url.searchParams.set("panel", "chat")
await page.goto(url.toString())
await page.waitForTimeout(2000)
await page.getByRole("combobox", { name: "Use in this chat" }).first().click()
await page.getByRole("option", { name: /mock-plain/ }).click()
await page.waitForTimeout(1500)
url.searchParams.delete("panel")
await page.goto(url.toString())
await page.waitForTimeout(2500)
await last().hover()
await last().getByRole("button", { name: /^Continue/ }).hover()
await page.waitForTimeout(700)
await shot("w12-unavailable-tooltip")
await last().getByRole("button", { name: /^Continue/ }).click()
await page.waitForTimeout(500)
await shot("w13-unavailable-explained")
await page.setViewportSize({ width: 390, height: 844 })
await page.waitForTimeout(800)
await last().locator("p").first().click()
await page.waitForTimeout(600)
await last().getByRole("button", { name: /^Continue/ }).click()
await page.waitForTimeout(600)
await page.screenshot({ path: `${out}/w13-unavailable-explained-phone.png` })
console.log(JSON.stringify({ chatUrl, errors }))
await browser.close()

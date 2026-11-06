import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { oversizedPortraitPng, writeLargeImageStFolder } from "../../server/test/support/stLargeImages.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { portraitView } from "./support/portrait.ts"
import { cardFieldsTab } from "./support/cardEditor.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "60" })
test.setTimeout(600_000)
let imported = false

for (const width of [1440, 390]) {
  test(`large library requests sized, lazy images and opens original portraits at ${width}`, async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width, height: width === 390 ? 844 : 900 },
      deviceScaleFactor: 2
    })
    try {
      const page = await context.newPage()
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      if (!imported) {
        const folder = writeLargeImageStFolder(join(server().dataDir, "st"))
        await page.goto(`${server().url}/import/st`)
        await page.getByLabel("Folder path").fill(folder)
        await page.getByRole("button", { name: "Look in this folder" }).click()
        await page.getByRole("button", { name: "Import", exact: true }).click()
        // The import makes each avatar's thumbnails as it stores it (ARCHITECTURE.md §14.5b).
        await expect(page.getByRole("list", { name: "Imported" })).toBeVisible({ timeout: 480_000 })
        imported = true
      }
      const requests: string[] = []
      page.on("request", (r) => {
        if (r.url().includes("/library/media?")) requests.push(r.url())
      })
      await page.goto(server().url)
      await expect(page.locator("main img")).toHaveCount(162)
      const tile = page.locator("main img").first()
      await expect(tile).toHaveAttribute("loading", "lazy")
      await expect(tile).toHaveAttribute("decoding", "async")
      await expect.poll(() => tile.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
      expect(requests.length).toBeGreaterThan(0)
      expect(requests.every((url) => /&w=(96|192|384|768)&crop=\w+$/.test(url))).toBeTruthy()
      const sizing = await tile.evaluate((img) => ({
        pixels: img.getBoundingClientRect().width * devicePixelRatio,
        url: (img as HTMLImageElement).currentSrc
      }))
      const snapped = [96, 192, 384, 768].find((w) => w >= sizing.pixels) ?? 768
      expect(Number(new URL(sizing.url).searchParams.get("w"))).toBe(snapped)
      // The real large fixture is still lazy: far-away tiles haven't been requested.
      expect(new Set(requests).size).toBeLessThan(150)
      await page
        .getByRole("main")
        .getByRole("link", { name: /^Open Synthetic 001(?: · .*)?$/ })
        .click()
      const portrait = page.locator("main img").first()
      await expect(portrait).toHaveAttribute("src", /&w=(96|192|384|768)&crop=\w+$/)
      // With no chat yet the tile opens a new one at its greeting; with one, its latest chat at
      // the card's tab, whose New chat with button starts another.
      const greeting = page.getByRole("article", { name: /^Greeting from / })
      const another = page.getByRole("link", { name: "New chat with Synthetic 001", exact: true })
      await expect(greeting.or(another).first()).toBeVisible()
      if (await another.isVisible()) await another.click()
      if (width === 390) await page.getByRole("button", { name: "Close", exact: true }).click()
      await page.getByLabel("Message", { exact: true }).fill("Hello from the image test.")
      await page.getByRole("button", { name: /^Send(?: as .+)?$/ }).click()
      await expect(page).toHaveURL(/\/chats\//)
      // A message portrait opens the original: beside the chat, or full-screen on a phone.
      await page.getByRole("button", { name: "View Synthetic 001's portrait" }).first().click()
      const full = portraitView(page, "Synthetic 001").getByRole("img", { name: "Synthetic 001's full portrait" })
      await expect(full).toHaveAttribute("src", /^\/library\/media\?id=[^&]+$/)
      await expect.poll(() => full.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBe(1024)
      await expect.poll(() => full.evaluate((img) => (img as HTMLImageElement).naturalHeight)).toBe(2048)
      if (process.env.SCREENSHOT_DIR)
        await page.screenshot({ path: join(process.env.SCREENSHOT_DIR, `large-full-${width}.png`) })
    } finally {
      await context.close()
    }
  })
}

for (const width of [1440, 390]) {
  test(`accepted 48MP avatars display through sized URLs at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const name = `Large avatar ${width}`
    const imported = await page.request.post(`${server().url}/library/import?name=large-${width}.json`, {
      data: Buffer.from(JSON.stringify({ spec: "chara_card_v2", spec_version: "2.0", data: { name } })),
      headers: { origin: server().url, "content-type": "application/octet-stream" }
    })
    expect(imported.ok()).toBeTruthy()
    await page.goto(`${server().url}/library`)
    await page.getByRole("link", { name: `Edit ${name}`, exact: true }).click()
    const bytes = await oversizedPortraitPng()
    const uploaded = page.waitForResponse((response) => response.url().includes("/library/avatar?"))
    await cardFieldsTab(page, "Metadata")
    await page.getByLabel("Choose an avatar, or drop it here").setInputFiles({
      name: "large.png",
      mimeType: "image/png",
      buffer: bytes
    })
    // A new picture goes through the cutout chooser (§14.5c); its default cutout is saved.
    await page
      .getByRole("dialog", { name: /new picture$/ })
      .getByRole("button", { name: "Save picture" })
      .click()
    expect((await uploaded).status()).toBe(200)
    const avatar = page.getByRole("img", { name: "The card's avatar" })
    await expect(avatar).toHaveAttribute("src", /&w=(96|192|384|768)&crop=\w+$/)
    await expect.poll(() => avatar.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBe(8000)
    await avatar.evaluate((img) => (img as HTMLImageElement).decode())
    if (process.env.SCREENSHOT_DIR)
      await page.screenshot({ path: join(process.env.SCREENSHOT_DIR, `large-avatar-${width}.png`) })
    await page.reload()
    await cardFieldsTab(page, "Metadata")
    await expect.poll(() => avatar.evaluate((img) => (img as HTMLImageElement).naturalHeight)).toBe(6000)
    await avatar.evaluate((img) => (img as HTMLImageElement).decode())
  })
}

import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { writeLargeImageStFolder } from "../../server/test/support/stLargeImages.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "60" })
test.setTimeout(240_000)
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
        await expect(page.getByRole("list", { name: "Imported" })).toBeVisible({ timeout: 180_000 })
        imported = true
      }
      const requests: string[] = []
      page.on("request", (r) => {
        if (r.url().includes("/library/media?")) requests.push(r.url())
      })
      await page.goto(server().url)
      await expect(page.locator("main img")).toHaveCount(173)
      const tile = page.locator("main img").first()
      await expect(tile).toHaveAttribute("loading", "lazy")
      await expect(tile).toHaveAttribute("decoding", "async")
      await expect.poll(() => tile.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
      expect(requests.length).toBeGreaterThan(0)
      expect(requests.every((url) => /&w=(96|192|384|768)$/.test(url))).toBeTruthy()
      const sizing = await tile.evaluate((img) => ({
        pixels: img.getBoundingClientRect().width * devicePixelRatio,
        url: (img as HTMLImageElement).currentSrc
      }))
      const snapped = [96, 192, 384, 768].find((w) => w >= sizing.pixels) ?? 768
      expect(Number(new URL(sizing.url).searchParams.get("w"))).toBe(snapped)
      // The real large fixture is still lazy: far-away tiles haven't been requested.
      expect(new Set(requests).size).toBeLessThan(150)
      await page.getByRole("link", { name: "Inspect Synthetic 001", exact: true }).click()
      const portrait = page.locator("main img").first()
      await expect(portrait).toHaveAttribute("src", /&w=(96|192|384|768)$/)
      await page.getByRole("main").getByRole("link", { name: "New chat", exact: true }).click()
      await page.getByLabel("Message", { exact: true }).fill("Hello from the image test.")
      await page.getByRole("button", { name: /^Send as / }).click()
      await expect(page).toHaveURL(/\/chats\//)
      // A message portrait opens the stock panel, including on phones.
      await page.getByRole("button", { name: "View Synthetic 001's portrait" }).first().click()
      const panelImage = page.getByRole("img", { name: "Synthetic 001's full portrait" })
      await expect(panelImage).toHaveAttribute("src", /&w=(384|768)$/)
      await page.getByRole("button", { name: "Open full size", exact: true }).click()
      const full = page.getByRole("dialog", { name: "Synthetic 001 — full size" }).getByRole("img")
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

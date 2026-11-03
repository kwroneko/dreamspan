// Synthetic cards with no chats: the greeting portrait must work before the first send,
// then keep the same viewer behaviour once saved. Small portraits must have no oval wrapper.
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, type Locator, type Page, test } from "@playwright/test"
import { openPanel } from "./support/panel.ts"
import { closePortrait, portraitView } from "./support/portrait.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { shapeCard } from "./support/shapes.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "200", FAKE_GENERATOR_TOKENS: "10" })
const shots = process.env.PORTRAIT_FIX_SHOTS

const captureHeader = async (page: Page, name: string) => {
  if (!shots) return
  mkdirSync(shots, { recursive: true })
  const header = page.locator("[data-chat-main] > header")
  await header.screenshot({ path: join(shots, `${name}.png`), animations: "disabled" })
  const face = header.locator("[data-portrait]").first()
  if (await face.isVisible()) {
    const box = (await face.boundingBox())!
    await page.screenshot({
      path: join(shots, `${name}-avatar.png`),
      animations: "disabled",
      clip: { x: box.x - 8, y: box.y - 8, width: box.width + 16, height: box.height + 16 }
    })
  }
}

const rectangularPortraits = async (portraits: Locator) => {
  // A tab can be visible while its lazy body still shows the loading fallback.
  await expect(portraits.filter({ visible: true }).first()).toBeVisible()
  const boxes = await portraits.evaluateAll((nodes) =>
    nodes
      .filter((node) => node.checkVisibility())
      .map((node) => {
        const rect = node.getBoundingClientRect()
        const style = getComputedStyle(node)
        return {
          width: rect.width,
          height: rect.height,
          radius: parseFloat(style.borderRadius),
          shadow: style.boxShadow
        }
      })
  )
  expect(boxes.length).toBeGreaterThan(0)
  for (const box of boxes) {
    expect(box.width / box.height).toBeCloseTo(2 / 3, 2)
    expect(box.radius).toBeLessThan(box.width / 2)
    expect(box.shadow).toBe("none")
  }
}

for (const width of [1440, 390]) {
  for (const theme of ["light", "dark"] as const) {
    test(`greeting and saved portraits, rectangular small avatars at ${width} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      // Exercise the Cast loading boundary even when its chunk is cached locally.
      let releaseCast!: () => void
      const castModule = new Promise<void>((resolve) => {
        releaseCast = resolve
      })
      await page.route(/\/assets\/CastTab-[^/]+\.js$/, async (route) => {
        await castModule
        await route.continue()
      })
      const name = `Fresh ${width} ${theme}`
      const imported = await page.request.post(`${server().url}/library/import?name=${name}.png`, {
        data: shapeCard({ name, width: 400, height: 600 }, 20),
        headers: { origin: server().url, "content-type": "application/octet-stream" }
      })
      expect(imported.ok()).toBeTruthy()
      await page.goto(`${server().url}/library`)
      await page.getByRole("link", { name: `Start a chat with ${name}`, exact: true }).click()
      const greeting = page.getByRole("article", { name: `Greeting from ${name}`, exact: true })
      const pendingPortrait = greeting.getByRole("button", { name: `View ${name}'s portrait`, exact: true })
      await expect(pendingPortrait.locator("img")).toBeVisible()
      await captureHeader(page, `${width}-${theme}-pending`)
      await pendingPortrait.click()
      const viewer = portraitView(page, name)
      await expect(viewer).toBeVisible()
      const image = viewer.getByRole("img", { name: `${name}'s full portrait`, exact: true })
      await expect(image).toHaveAttribute("src", /^\/library\/media\?id=[^&]+$/)
      const original = await image.getAttribute("src")
      if (width === 1440) await expect(viewer).toHaveRole("complementary")
      else await expect(viewer).toHaveRole("dialog")
      await closePortrait(page)
      await expect(greeting).toBeVisible()
      await expect(page).toHaveURL(/\/cards\/[^/]+\/chat/)

      await page.getByLabel("Message", { exact: true }).fill("Hello from a synthetic test.")
      await page.getByRole("button", { name: "Send", exact: true }).click()
      await expect(page).toHaveURL(/\/chats\/(?!new)[^/?]+/)
      await expect(page.getByText("generating", { exact: true })).toHaveCount(0)
      const savedPortrait = page
        .locator("article[data-slot]")
        .first()
        .getByRole("button", {
          name: `View ${name}'s portrait`,
          exact: true
        })
      await savedPortrait.click()
      await expect(viewer).toBeVisible()
      await expect(image).toHaveAttribute("src", original!)
      await closePortrait(page)
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      await captureHeader(page, `${width}-${theme}-saved`)
      await page.mouse.move(0, 0)
      await rectangularPortraits(page.locator("article[data-slot] [data-portrait]"))
      if (width === 1440) {
        const button = page
          .locator("[data-chat-main] > header")
          .getByRole("button", { name: `Show ${name}'s card`, exact: true })
        const portrait = button.locator("[data-portrait]")
        await rectangularPortraits(portrait)
        const outer = (await button.boundingBox())!
        const inner = (await portrait.boundingBox())!
        expect(outer.height).toBeCloseTo(inner.height, 1)
        expect(outer.width).toBeCloseTo(inner.width, 1)
        await expect(button).toHaveCSS(
          "border-radius",
          await portrait.evaluate((el) => getComputedStyle(el).borderRadius)
        )
        await expect(button).toHaveCSS("box-shadow", "none")
        await page.keyboard.press("Tab")
        await button.focus()
        await expect(button).not.toHaveCSS("box-shadow", "none")
      }
      const cast = await openPanel(page, "Cast")
      releaseCast()
      await rectangularPortraits(cast.locator("[data-portrait]"))
      await page.goto(`${server().url}/chats`)
      await expect(page.locator("main [data-portrait] img").first()).toBeVisible()
      await rectangularPortraits(page.locator("main [data-portrait]"))
    })
  }
}

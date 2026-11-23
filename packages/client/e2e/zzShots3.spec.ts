import { createServer } from "node:net"
import { expect, test } from "@playwright/test"
import { ADMIN, apiLogin, startServer, withAdmin } from "./support/server.ts"

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer()
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      probe.close(() => resolve(typeof address === "object" && address ? address.port : 0))
    })
  })

const out = "/tmp/dreamspan-shots/cardexfilters3"

for (const theme of ["light", "dark"] as const)
  for (const width of [1440, 390])
    test(`shots3 ${width} ${theme}`, async ({ page }) => {
      test.setTimeout(240_000)
      const port = await freePort()
      const server = await startServer({ ...withAdmin, FAKE_CARD_SOURCE: String(port) })
      const shot = async (name: string) => {
        await page.waitForTimeout(700)
        await page.screenshot({ path: `${out}/ours-${width}-${theme}${name}.png` })
      }
      const step = async (label: string, fn: () => Promise<void>) => {
        try {
          await fn()
        } catch (e) {
          console.log(`skip ${label}: ${String(e).split("\n")[0]}`)
          await page.keyboard.press("Escape")
        }
      }
      try {
        await apiLogin(page.request, server, ADMIN.handle, ADMIN.password)
        await page.setViewportSize({ width, height: 900 })
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
        await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
        await page.goto(server.url)
        const home = page.getByRole("main")
        await home.getByRole("button", { name: "cardex", exact: true }).click()
        await expect(home.locator("[data-remote-card]").first()).toBeVisible()
        await shot("")
        if (theme === "dark") return
        if (width === 1440) {
          const bar = home.locator("[data-filter-panels]")
          for (const [name, pattern] of [
            ["creators", /^Creators:/],
            ["sites", /^Sites:/],
            ["tokens", /^Tokens:/],
            ["added", /^Added:/]
          ] as const)
            await step(name, async () => {
              await bar.getByRole("button", { name: pattern }).click()
              await shot(`-${name}`)
              await page.keyboard.press("Escape")
            })
          await step("tags", async () => {
            const tags = bar.getByRole("textbox", { name: "Tags", exact: true })
            await tags.click()
            await shot("-tags")
            await tags.fill("fantasy")
            await tags.press("Enter")
            await tags.fill("ma")
            await page.waitForTimeout(600)
            await page.getByRole("button", { name: "Add tag magic as an alternative to fantasy", exact: true }).click()
            await tags.fill("-hor")
            await tags.press("Enter")
            await shot("-tags-chosen")
            await page.keyboard.press("Escape")
          })
        } else {
          await step("sheet", async () => {
            await home.getByRole("button", { name: /^Filters/ }).click()
            await shot("-sheet")
            const sheet = page.locator("[data-filter-sheet]")
            await sheet.getByRole("button", { name: /^Tokens:/ }).click()
            await shot("-sheet-tokens")
            await sheet.getByRole("button", { name: /^Tokens:/ }).click()
            await sheet.getByRole("button", { name: /^Creators:/ }).click()
            await shot("-sheet-creators")
          })
        }
      } finally {
        await server.stop()
      }
    })

import { writeFileSync } from "node:fs"
import { expect, test, type Locator } from "@playwright/test"
import { showAppNavigation } from "./support/appMenu.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { startServer } from "./support/server.ts"

const box = async (locator: Locator) => {
  const value = await locator.boundingBox()
  expect(value).not.toBeNull()
  return value!
}

for (const theme of ["light", "dark"] as const)
  test(`left search: ${theme}`, async ({ page }, info) => {
    const server = await startServer()
    const measurements = []
    try {
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      await page.goto(server.url)
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
        const switcher = page.getByRole("group", { name: "Left panel", exact: true }).filter({ visible: true })
        const column = switcher.locator(
          'xpath=ancestor::*[@aria-label="Sidebar" or contains(@class,"fixed inset-0")][1]'
        )
        for (const view of ["Chats", "Characters"] as const) {
          await switcher.getByRole("button", { name: view, exact: true }).click()
          const input = page
            .getByRole("textbox", { name: view === "Chats" ? "Find a chat" : "Find a character", exact: true })
            .filter({ visible: true })
          const before = { switcher: await box(switcher), input: await box(input) }
          if (!process.env.LEFTSEARCH_BEFORE) {
            const host = await box(switcher.locator("../.."))
            const oneRow = host.width >= 416
            expect(Math.abs(before.switcher.y - before.input.y) < 3).toBe(oneRow)
            if (oneRow) expect(before.input.width).toBeGreaterThanOrEqual(224)
            else {
              expect(before.input.y).toBeGreaterThan(before.switcher.y + before.switcher.height)
              expect(before.switcher.width).toBeCloseTo(before.input.width, 0)
            }
            const segments = await switcher.getByRole("button").all()
            expect((await box(segments[0]!)).width).toBeCloseTo((await box(segments[1]!)).width, 0)
            for (const control of [...segments, input]) {
              await control.hover()
              await control.focus()
              expect(await box(switcher)).toEqual(before.switcher)
              expect(await box(input)).toEqual(before.input)
            }
            await input.fill("Synthetic name")
            await expect(input).toHaveValue("Synthetic name")
            await input.fill("")
            await expectLayout(page, info, `leftsearch-${size}-${view}-${theme}`, {
              scope: size === "phone" ? ".fixed.inset-0" : '[aria-label="Sidebar"]'
            })
          }
          await page.mouse.move(1400, 850)
          await input.blur()
          await column.screenshot({ path: info.outputPath(`${size}-${view}-${theme}.png`) })
          measurements.push({ size, view, ...before })
        }
      }
      writeFileSync(info.outputPath("geometry.json"), JSON.stringify(measurements, null, 2))
    } finally {
      await server.stop()
    }
  })

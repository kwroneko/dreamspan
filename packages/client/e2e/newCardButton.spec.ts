// New card in the Characters page's header (owner, 2026-11-24: "an easily accessible, obvious yet
// not annoying 'create card' button"): right-aligned before the split icons, centred on the title
// in a header that keeps its height, and the Library's own dialog opening the card's editor.
// NEW_CARD_SHOTS=<folder> keeps a dark window screenshot at 1340 and 390 there.
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, type Locator, type Page, test } from "@playwright/test"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { hideAppNavigation } from "./support/appMenu.ts"

test.setTimeout(300_000)

const WIDTHS = [1440, 1340, 1024, 768, 600, 390] as const
const shots = process.env.NEW_CARD_SHOTS

const server = serverPerFile(withAdmin)
test.beforeAll(async () => {
  await asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.CreateCard({ label: "Mira", name: "Mira" }))
})

const box = async (locator: Locator) => {
  const b = await locator.boundingBox()
  expect(b, "laid out").not.toBeNull()
  return b!
}
const centre = (b: { y: number; height: number }) => b.y + b.height / 2

const header = (page: Page) => page.getByRole("main").locator("[data-center-header]").first()

for (const theme of ["light", "dark"] as const)
  test(`New card in the Characters header at every width: ${theme}`, async ({ page }, info) => {
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
    await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
    if (shots) mkdirSync(shots, { recursive: true })
    // The header's height on a page without the button, for comparison.
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`${server().url}/library`)
    const plainHeight = (await box(header(page))).height
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 })
      await page.goto(server().url)
      await hideAppNavigation(page)
      const row = header(page)
      const title = row.getByRole("heading", { name: "Characters", exact: true, level: 1 })
      const button = row.getByRole("button", { name: "New card", exact: true })
      await expect(title).toBeVisible()
      await expect(button).toBeVisible()
      await expect(button).toHaveAccessibleDescription("Opens a form to create a card.")
      await expect(page.getByRole("main").getByRole("button", { name: "New card", exact: true })).toHaveCount(1)
      const what = `${width} ${theme}`
      const [rowBox, titleBox, buttonBox] = [await box(row), await box(title), await box(button)]
      expect(rowBox.height, `${what}: header height`).toBeCloseTo(plainHeight, 0)
      // Centred on the header's line, as the title is.
      expect(Math.abs(centre(buttonBox) - centre(titleBox)), `${what}: centred on the title`).toBeLessThan(1)
      expect(buttonBox.x, `${what}: after the title`).toBeGreaterThan(titleBox.x + titleBox.width)
      // Right-aligned: the split icons after it at the header's gap, else its edge on the page's
      // 16 px gutter (the phone header's padding is 8 px; the button takes the other 8).
      const split = row.getByRole("button", { name: "Split right", exact: true })
      const end = await row.evaluate((node) => ({
        right: node.getBoundingClientRect().right,
        padding: 16,
        gap: parseFloat(getComputedStyle(node).columnGap)
      }))
      if (await split.isVisible()) {
        const splitBox = await box(split)
        expect(
          Math.abs(splitBox.x - (buttonBox.x + buttonBox.width) - end.gap),
          `${what}: gap to the icons`
        ).toBeLessThan(1)
        expect(Math.abs(centre(splitBox) - centre(buttonBox)), `${what}: centred with the icons`).toBeLessThan(1)
      } else {
        expect(Math.abs(end.right - end.padding - (buttonBox.x + buttonBox.width)), `${what}: at the end`).toBeLessThan(
          1
        )
      }
      await expectLayout(page, info, `characters-${width}-${theme}`)
      await expectLayout(page, info, `characters-header-${width}-${theme}`, { scope: "main [data-center-header]" })
      if (shots && theme === "dark" && (width === 1340 || width === 390))
        await page.screenshot({ path: join(shots, `characters-header-${width}-dark.png`) })
    }
  })

for (const width of [1440, 390] as const)
  test(`New card from the Characters header opens the new card's editor at ${width}`, async ({ page }, info) => {
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.setViewportSize({ width, height: 900 })
    await page.goto(server().url)
    await hideAppNavigation(page)
    const button = header(page).getByRole("button", { name: "New card", exact: true })
    await button.hover()
    await expect(page.getByText("Opens a form to create a card.", { exact: true }).last()).toBeVisible()
    await button.click()
    // The Library's dialog: the same title and fields.
    const dialog = page.getByRole("dialog", { name: "New card", exact: true })
    await expect(dialog).toBeVisible()
    await expectLayout(page, info, `new-card-dialog-${width}`)
    const name = `Header card ${width}`
    await dialog.getByRole("textbox", { name: "Display name", exact: true }).fill(name)
    await dialog.getByRole("button", { name: "Create", exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page).toHaveURL(/\/library\/[^/?]+/)
    await expect(page.getByRole("textbox", { name: "Description", exact: true })).toBeVisible()
    await expect(page.getByRole("main").getByText(name, { exact: true }).first()).toBeVisible()
  })

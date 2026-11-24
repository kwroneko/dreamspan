// New card in the Characters page's header (owner, 2026-11-24: "an easily accessible, obvious yet
// not annoying 'create card' button"): right after the title at the header's gap ("anchored to
// 'characters' on the other side, and also feature an icon before the words"), a plus before its
// words, centred on the title in a header that keeps its height, and the Library's own dialog
// opening the card's editor. A chip (owner, 2026-11-24: "too close to 'Characters', it's too large
// ... it needs to become more like a chip", and the plus "closer to the text than the border"):
// 24 px tall and pill-round, 14 px after the title, the plus's glyph as far from the left edge as
// from the words.
// NEW_CARD_SHOTS=<folder> keeps dark and light window screenshots and a 2x header crop there.
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, type Locator, type Page, test } from "@playwright/test"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { hideAppNavigation } from "./support/appMenu.ts"

test.setTimeout(300_000)

const WIDTHS = [2560, 1920, 1440, 1340, 1024, 768, 600, 390] as const
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
      // Anchored to the title, 12-16 px after it.
      const gap = buttonBox.x - (titleBox.x + titleBox.width)
      expect(gap, `${what}: gap after the title`).toBeGreaterThanOrEqual(12)
      expect(gap, `${what}: gap after the title`).toBeLessThanOrEqual(16)
      // A chip: compact and pill-round.
      expect(buttonBox.height, `${what}: chip height`).toBeGreaterThanOrEqual(22)
      expect(buttonBox.height, `${what}: chip height`).toBeLessThanOrEqual(28)
      expect(buttonBox.height, `${what}: smaller than the title line`).toBeLessThan(titleBox.height + 4)
      const radius = await button.evaluate((node) => parseFloat(getComputedStyle(node).borderTopLeftRadius))
      expect(radius, `${what}: pill-round`).toBeGreaterThanOrEqual(buttonBox.height / 2 - 0.5)
      // The title is whole, and the button inside the header's padding.
      expect(await title.evaluate((node) => node.scrollWidth <= node.clientWidth), `${what}: title whole`).toBe(true)
      const rowEnd = await row.evaluate(
        (node) => node.getBoundingClientRect().right - parseFloat(getComputedStyle(node).paddingRight)
      )
      expect(buttonBox.x + buttonBox.width, `${what}: inside the header`).toBeLessThanOrEqual(rowEnd + 0.5)
      // A plus before the words.
      const icon = button.locator("svg")
      await expect(icon).toHaveCount(1)
      const iconBox = await box(icon)
      expect(iconBox.width, `${what}: icon size`).toBeCloseTo(12, 0)
      // The drawn plus, not its box: edge-to-glyph equals glyph-to-words (±1 px), and the right
      // padding matches them as nearly.
      const spaces = await button.evaluate((node) => {
        const svg = node.querySelector("svg")!
        const own = svg.getBoundingClientRect()
        const drawn = svg.getBBox()
        const scale = own.width / svg.viewBox.baseVal.width
        const range = document.createRange()
        // React renders "New " and "card" as two text nodes: the words span both.
        const texts = [...node.childNodes].filter((child) => child.nodeType === Node.TEXT_NODE)
        range.setStartBefore(texts[0]!)
        range.setEndAfter(texts.at(-1)!)
        const words = range.getBoundingClientRect()
        const edge = node.getBoundingClientRect()
        const border = parseFloat(getComputedStyle(node).borderLeftWidth)
        return {
          left: own.x + drawn.x * scale - (edge.x + border),
          between: words.x - (own.x + (drawn.x + drawn.width) * scale),
          right: edge.right - border - words.right
        }
      })
      expect(spaces.between, `${what}: icon before the words`).toBeGreaterThan(0)
      expect(
        Math.abs(spaces.left - spaces.between),
        `${what}: plus centred in its space ${JSON.stringify(spaces)}`
      ).toBeLessThanOrEqual(1)
      expect(
        Math.abs(spaces.right - spaces.left),
        `${what}: right padding ${JSON.stringify(spaces)}`
      ).toBeLessThanOrEqual(2)
      info.annotations.push({ type: "spaces", description: `${what}: ${JSON.stringify(spaces)}` })
      expect(Math.abs(centre(iconBox) - centre(buttonBox)), `${what}: icon centred`).toBeLessThan(1)
      await expectLayout(page, info, `characters-${width}-${theme}`)
      await expectLayout(page, info, `characters-header-${width}-${theme}`, { scope: "main [data-center-header]" })
      if (shots && [2560, 1920, 1340, 390].includes(width)) {
        await page.screenshot({ path: join(shots, `characters-${width}-${theme}.png`) })
        const clip = {
          x: titleBox.x - 16,
          y: rowBox.y,
          width: buttonBox.x + buttonBox.width - titleBox.x + 32,
          height: rowBox.height
        }
        const zoom = await page
          .context()
          .browser()!
          .newContext({
            viewport: { width, height: 900 },
            deviceScaleFactor: 2,
            colorScheme: theme,
            reducedMotion: "reduce",
            storageState: await page.context().storageState()
          })
        const zoomed = await zoom.newPage()
        await zoomed.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
        await zoomed.goto(server().url)
        await hideAppNavigation(zoomed)
        await expect(header(zoomed).getByRole("button", { name: "New card", exact: true })).toBeVisible()
        await zoomed.screenshot({ path: join(shots, `characters-header-${width}-${theme}-2x.png`), clip })
        await zoom.close()
      }
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

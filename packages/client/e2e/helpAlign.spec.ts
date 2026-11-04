import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, type Locator, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { openPanel } from "./support/panel.ts"

test.use({ reducedMotion: "reduce" })
const server = serverPerFile(withAdmin)
const work = process.env.SCREENSHOT_DIR

async function geometry(page: Page, text: string, help: Locator, name: string) {
  await help.scrollIntoViewIfNeeded()
  await help.evaluate((el) => el.scrollIntoView({ block: "center", behavior: "instant" }))
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  )
  await expect(help).toBeVisible()
  const glyphs = await page.evaluate((text) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    let node: Node | null
    while ((node = walker.nextNode())) {
      if (node.textContent?.trim() !== text || !node.parentElement?.checkVisibility()) continue
      const start = node.textContent.indexOf(text)
      const range = document.createRange()
      range.setStart(node, start)
      range.setEnd(node, start + 1)
      const first = range.getBoundingClientRect().toJSON() as { y: number; height: number }
      range.setStart(node, start + text.length - 1)
      range.setEnd(node, start + text.length)
      const last = range.getBoundingClientRect().toJSON() as { y: number; height: number; right: number }
      return { first, last }
    }
    throw new Error(`No visible label: ${text}`)
  }, text)
  const box = (await help.boundingBox())!
  const measurements = {
    gap: box.x - glyphs.last.right,
    centre: box.y + box.height / 2 - glyphs.last.y - glyphs.last.height / 2,
    width: box.width,
    height: box.height,
    wrapped: glyphs.first.y !== glyphs.last.y
  }
  if (work) {
    mkdirSync(work, { recursive: true })
    writeFileSync(join(work, `${name}.json`), JSON.stringify(measurements, null, 2))
    const top = Math.min(glyphs.first.y, box.y) - 12
    await page.screenshot({
      path: join(work, `${name}.png`),
      clip: {
        x: Math.max(0, box.x - 340),
        y: Math.max(0, top),
        width: Math.min(390, page.viewportSize()!.width - Math.max(0, box.x - 340)),
        height: Math.max(90, box.y + box.height - top + 35)
      }
    })
  }
  expect(measurements.gap).toBeGreaterThanOrEqual(0)
  expect(measurements.gap).toBeLessThanOrEqual(8)
  expect(Math.abs(measurements.centre)).toBeLessThanOrEqual(2)
  expect(box.width).toBe(20)
  expect(box.height).toBe(20)
  return measurements
}

for (const width of [390, 1024, 1440]) {
  test(`inline label help at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const { chat, preset, card } = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
      Effect.gen(function* () {
        const chat = yield* api.CreateChat({ title: "Synthetic help alignment" })
        const preset = yield* api.CreatePreset({ label: `Help alignment ${width}` })
        const card = yield* api.CreateCard({ label: `Help card ${width}`, name: `Help card ${width}` })
        yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: card.entityId } })
        return { chat, preset, card }
      })
    )
    await page.goto(`${server().url}/chats/${chat.id}`)
    const cardPanel = await openPanel(page, `Help card ${width}`)
    await geometry(
      page,
      "Description",
      cardPanel.getByRole("button", { name: "About Description", exact: true }),
      `card-panel-${width}`
    )
    await page.goto(`${server().url}/library/${card.id}`)
    await geometry(
      page,
      "Description",
      page.getByRole("button", { name: "About Description", exact: true }),
      `card-full-${width}`
    )
    await page.goto(`${server().url}/chats/${chat.id}`)
    const tab = await openPanel(page, "Lorebooks")
    const help = tab.getByRole("button", { name: "Why below the history" })
    await geometry(page, "Force all lorebook entries below the history", help, `lorebooks-${width}`)
    if (width === 390) {
      await page.setViewportSize({ width: 320, height: 900 })
      const wrapped = await geometry(
        page,
        "Force all lorebook entries below the history",
        help,
        "lorebooks-wrapped-320"
      )
      expect(wrapped.wrapped).toBe(true)
      await page.setViewportSize({ width, height: 900 })
    }
    const toggle = tab.getByRole("switch", { name: "Force all lorebook entries below the history" })
    await expect(toggle).toBeChecked()
    await help.click()
    await expect(page.getByRole("dialog", { name: "Below the history" })).toBeVisible()
    await expect(toggle).toBeChecked()
    await page.keyboard.press("Escape")
    await page.goto(`${server().url}/library/${preset.id}`)
    const section = page.locator('[data-preset-section="reply-sections"]')
    await geometry(
      page,
      "Move tagged thinking into its own panel",
      section.getByRole("button", { name: "About Move tagged thinking into its own panel" }),
      `switch-${width}`
    )
    await geometry(
      page,
      "Opening tag",
      section.getByRole("button", { name: "About Opening tag" }).first(),
      `field-${width}`
    )
    const checkboxHelp = section.getByRole("button", { name: "About Match case" }).first()
    await geometry(page, "Match case", checkboxHelp, `checkbox-${width}`)
    const checkbox = section.getByRole("checkbox", { name: "Match case", exact: true }).first()
    const before = await checkbox.isChecked()
    await checkboxHelp.click()
    await expect(checkbox).toBeChecked({ checked: before })
    await section
      .locator("label")
      .filter({ hasText: /^Match case$/ })
      .first()
      .click()
    await expect(checkbox).toBeChecked({ checked: !before })
  })
}

import { expect, type Page, test } from "@playwright/test"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { openEntry, openSettings } from "./support/lorebook.ts"

const server = serverPerFile(withAdmin)
const upload = async (page: Page, name: string, data: unknown) => {
  const response = await page.request.post(`${server().url}/library/import?name=${encodeURIComponent(name)}`, {
    headers: { origin: server().url, "content-type": "application/octet-stream" },
    data: Buffer.from(JSON.stringify(data))
  })
  expect(response.status()).toBe(200)
  return (await response.json()).library.ref as { id: string }
}

for (const width of [1440, 390]) {
  test(`timing and character filter choices persist at ${width}`, async ({ page }, info) => {
    test.setTimeout(120000)
    page.setDefaultTimeout(15000)
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await upload(page, `alice-${width}.json`, {
      spec: "chara_card_v2",
      spec_version: "2.0",
      data: { name: `Alice ${width}`, tags: ["Mages"] }
    })
    const book = await upload(page, `timed-${width}.json`, {
      entries: { 0: { key: ["cat"], comment: "Timed entry", content: "Synthetic lore" } }
    })
    await page.goto(`${server().url}/library/${book.id}`)
    await openEntry(page, "Timed entry")
    const scope = page.getByRole("group", { name: "Lorebook entry 0", exact: true })
    await openSettings(scope)
    await scope.getByText("Timing, filters and automation", { exact: true }).click()
    await scope.getByRole("spinbutton", { name: /^Sticky\b/ }).fill("3")
    await scope.getByRole("spinbutton", { name: /^Cooldown\b/ }).fill("2")
    await scope.getByRole("spinbutton", { name: /^Cooldown\b/ }).blur()
    if (process.env.LORE_TIMING_LAYOUT) await expectLayout(page, info, "lorebook-timing")
    const characters = scope.getByLabel("Chosen characters", { exact: true })
    await characters.locator("[aria-haspopup]").click()
    if (process.env.LORE_TIMING_LAYOUT) await expectLayout(page, info, "lorebook-character-picker")
    await page.getByRole("option", { name: `Alice ${width}`, exact: true }).click()
    await page.keyboard.press("Escape")
    const tags = scope.getByLabel("Chosen tags", { exact: true })
    await tags.locator("[aria-haspopup]").click()
    if (process.env.LORE_TIMING_LAYOUT) await expectLayout(page, info, "lorebook-tag-picker")
    await page.getByRole("option", { name: "Mages", exact: true }).click()
    await page.keyboard.press("Escape")
    await expect(characters.getByRole("button", { name: `Remove Alice ${width}` })).toBeVisible()
    await expect(tags.getByRole("button", { name: "Remove Mages" })).toBeVisible()
    await expect(scope.getByText(/kept for export but have no effect/)).toHaveCount(0)
    await page.reload()
    await openEntry(page, "Timed entry")
    await openSettings(scope)
    const timing = scope.getByText("Timing, filters and automation", { exact: true })
    if (!(await scope.getByRole("spinbutton", { name: /^Sticky\b/ }).isVisible())) await timing.click()
    await expect(scope.getByRole("spinbutton", { name: /^Sticky\b/ })).toHaveValue("3")
    await expect(scope.getByRole("spinbutton", { name: /^Cooldown\b/ })).toHaveValue("2")
    await expect(characters.getByRole("button", { name: `Remove Alice ${width}` })).toBeVisible()
    await expect(tags.getByRole("button", { name: "Remove Mages" })).toBeVisible()
  })
}

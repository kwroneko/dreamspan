// A card source's filter bar: on a wide bar each panel is a button whose controls open in a
// popover; on a narrow one the Filters button opens a sheet where each panel is a folding row.
// These open a panel either way and give the locator its controls are in.
import { expect, type Locator, type Page } from "@playwright/test"

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** The panel's button on a wide bar (its name is "<title>: <what's chosen>", or the summary when it starts with the title). */
const panelTrigger = (scope: Locator, title: string) =>
  scope.locator("[data-filter-panels]").getByRole("button", { name: new RegExp(`^${escaped(title)}\\b`) })

/** The filters' sheet, on a narrow bar. */
const filterSheet = (page: Page) => page.locator("[data-filter-sheet]")

/** Whether the bar shows its panels in place (a wide bar) rather than in the sheet. */
const wideBar = async (scope: Locator) => scope.locator("[data-filter-panels]").isVisible()

/** Opens the sheet (narrow bars only). */
async function openSheet(page: Page, scope: Locator) {
  if (await filterSheet(page).isVisible()) return filterSheet(page)
  await scope.getByRole("button", { name: /^Filters/ }).click()
  await expect(filterSheet(page)).toBeVisible()
  return filterSheet(page)
}

/** Where the tag field and the checkboxes are: the bar, or the sheet. */
export async function filterControls(page: Page, scope: Locator): Promise<Locator> {
  return (await wideBar(scope)) ? scope.locator("[data-filter-bar]") : openSheet(page, scope)
}

/** The panel's row in the sheet. */
const sheetRow = (page: Page, title: string) =>
  filterSheet(page).getByRole("button", { name: new RegExp(`^${escaped(title)}\\b`) })

/** What a panel's button or row says (its accessible name). */
export async function panelSummary(page: Page, scope: Locator, title: string) {
  return (await wideBar(scope)) ? panelTrigger(scope, title) : sheetRow(page, title)
}

/** Opens a panel and returns where its controls are: its popover, or the sheet. */
export async function openPanel(page: Page, scope: Locator, title: string): Promise<Locator> {
  if (await wideBar(scope)) {
    await panelTrigger(scope, title).click()
    const popover = page.getByRole("dialog", { name: title, exact: true })
    await expect(popover).toBeVisible()
    return popover
  }
  const sheet = await openSheet(page, scope)
  const row = sheetRow(page, title)
  if ((await row.getAttribute("aria-expanded")) !== "true") await row.click()
  await expect(row).toHaveAttribute("aria-expanded", "true")
  return sheet
}

/** Closes a panel's popover, or the sheet. */
export async function closePanel(page: Page, title: string) {
  const popover = page.getByRole("dialog", { name: title, exact: true })
  if ((await popover.count()) > 0) {
    await popover.getByRole("button", { name: "Close", exact: true }).click()
    await expect(popover).toHaveCount(0)
    return
  }
  await closeSheet(page)
}

/** Closes the sheet if it's open. */
export async function closeSheet(page: Page) {
  if (!(await filterSheet(page).isVisible())) return
  await page
    .getByRole("dialog", { name: "Filters", exact: true })
    .getByRole("button", { name: "Close", exact: true })
    .click()
  await expect(filterSheet(page)).toHaveCount(0)
}

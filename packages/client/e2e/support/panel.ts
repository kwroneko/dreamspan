// The chat's side panel: beside the chat on a wide screen, a sheet over it on a phone.
import { expect, type Page } from "@playwright/test"

/** Opens the chat's side panel at a tab, from the header or from the panel's own tabs, and returns the tab. */
export const openPanel = async (page: Page, tab: string) => {
  const tabs = page.getByRole("tablist", { name: "Chat panel" })
  const toggles = page.getByRole("group", { name: "Chat panel" })
  const sheet = page.getByRole("button", { name: "Chat panel", exact: true })
  // Whichever the chat shows once it's loaded.
  await expect(tabs.or(toggles).or(sheet).first()).toBeVisible()
  if (!(await tabs.isVisible())) {
    if (await toggles.isVisible()) await toggles.getByRole("button", { name: tab, exact: true }).click()
    else await sheet.click()
  }
  await tabs.getByRole("tab", { name: tab, exact: true }).click()
  return page.getByRole("tabpanel", { name: tab })
}

/** Closes the chat's side panel, or a phone's sheet. */
export const closePanel = async (page: Page) => {
  const sheet = page.getByRole("dialog").filter({ has: page.getByRole("tablist", { name: "Chat panel" }) })
  if (await sheet.isVisible()) await sheet.getByRole("button", { name: "Close", exact: true }).click()
  else await page.getByRole("button", { name: "Close the panel" }).click()
  await expect(page.getByRole("tablist", { name: "Chat panel" })).toHaveCount(0)
}

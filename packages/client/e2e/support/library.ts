// The library page's item menus, for specs that set a card up through the UI.
import { expect, type Page } from "@playwright/test"

/** Puts a card in the persona folder from its library item's menu. */
export const markPersona = async (page: Page, name: string) => {
  const row = page
    .getByRole("list", { name: "Cards", exact: true })
    .locator(":scope > li")
    .filter({ has: page.getByText(name, { exact: true }) })
  await row.getByRole("button", { name: /^More actions for / }).click()
  const box = page.getByRole("menuitemcheckbox", { name: "Persona", exact: true })
  await expect(box).not.toBeChecked()
  await box.click()
  await expect(row.getByText("Persona", { exact: true })).toBeVisible()
}

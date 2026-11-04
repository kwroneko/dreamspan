// The app's own navigation: the sidebar on a wide screen, the menu sheet on a phone. In a
// phone's chat the chat header takes the app bar's place, and its ← opens that menu.
import type { Page } from "@playwright/test"

/** Shows the app's navigation (Characters, Library, Settings…, image toggle) if it's hidden. */
export const showAppNavigation = async (page: Page) => {
  if (await page.getByRole("button", { name: "Close the menu", exact: true }).isVisible()) return
  const menu = page.getByRole("button", { name: "Chats and menu", exact: true }).filter({ visible: true })
  if ((await menu.count()) > 0) await menu.first().click()
}

/** Closes a phone's menu sheet if it's open. */
export const hideAppNavigation = async (page: Page) => {
  const close = page.getByRole("button", { name: "Close the menu", exact: true })
  if (await close.isVisible()) await close.click()
}

/** Log out through the Account card, including while an editor has unsaved text. */
export const logoutFromSettings = async (page: Page) => {
  if (!(await page.locator("[data-account-page]").isVisible())) {
    await showAppNavigation(page)
    await page
      .getByRole("navigation", { name: "Main", exact: true })
      .filter({ visible: true })
      .getByRole("link", { name: "Settings", exact: true })
      .click()
    await page
      .getByRole("navigation", { name: "Settings", exact: true })
      .getByRole("link", { name: "Account", exact: true })
      .click()
  }
  await page.locator("[data-account-page]").getByRole("button", { name: "Log out", exact: true }).click()
}

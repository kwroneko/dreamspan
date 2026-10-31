// The app's own navigation: the sidebar on a wide screen, the menu sheet on a phone. In a
// phone's chat the chat header takes the app bar's place, and its ← opens that menu.
import type { Page } from "@playwright/test"

/** Shows the app's navigation (Characters, Library, Settings…, image settings) if it's hidden. */
export const showAppNavigation = async (page: Page) => {
  const menu = page.getByRole("button", { name: "Chats and menu", exact: true }).filter({ visible: true })
  if ((await menu.count()) > 0) await menu.first().click()
}

/** Closes a phone's menu sheet if it's open. */
export const hideAppNavigation = async (page: Page) => {
  const close = page.getByRole("button", { name: "Close the menu", exact: true })
  if (await close.isVisible()) await close.click()
}

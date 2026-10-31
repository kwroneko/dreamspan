// A message's actions, as a user reaches them: on a wide screen they show on hover, on a
// narrow one after a tap on the message; the less used ones are in its "More actions" menu.
import type { Locator } from "@playwright/test"

/** Shows the actions of `message` (an `article`). */
export const showActions = async (message: Locator) => {
  const width = message.page().viewportSize()?.width ?? 1280
  if (width < 640) {
    if ((await message.getByRole("toolbar", { name: "Message actions" }).count()) === 0) {
      await message.locator(".markdown").first().click()
    }
  } else await message.hover()
}

/** Picks `name` from the "More actions" menu of `message`. */
export const messageMenu = async (message: Locator, name: string | RegExp) => {
  await showActions(message)
  await message.getByRole("button", { name: "More actions" }).click()
  await message.page().getByRole("menuitem", { name }).click()
}

/** Picks `name` from the History menu of the editor open in `message`. */
export const editHistory = async (message: Locator, name: string | RegExp) => {
  await message.getByRole("button", { name: "History of this edit" }).click()
  await message.page().getByRole("menuitem", { name }).click()
}

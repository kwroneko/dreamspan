// The Cast tab's Add characters section: opened if it's closed, a search, a tile.
import { expect, type Page } from "@playwright/test"

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Opens Add characters in the open Cast tab, if it's closed, and returns the section. */
export const openCastAdd = async (page: Page) => {
  const tab = page.getByRole("tabpanel", { name: "Cast" })
  const toggle = tab.getByRole("button", { name: "Add characters", exact: true })
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click()
  await expect(toggle).toHaveAttribute("aria-expanded", "true")
  return tab.getByRole("region", { name: "Add characters", exact: true })
}

/** Adds the character (or persona-folder card) whose name starts with `name`, found by searching for it. */
export const addToCast = async (page: Page, name: string) => {
  const section = await openCastAdd(page)
  await section.getByRole("searchbox", { name: "Find a character to add" }).fill(name)
  await section.getByRole("button", { name: new RegExp(`^Add ${escape(name)}.* to this chat$`) }).click()
  await expect(section.getByRole("button", { name: new RegExp(`^${escape(name)}.*: in this chat$`) })).toBeVisible()
  await section.getByRole("searchbox", { name: "Find a character to add" }).fill("")
}

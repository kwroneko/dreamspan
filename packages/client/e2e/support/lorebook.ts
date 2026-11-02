// The lorebook table's entries (LorebookTable.tsx): which are open is remembered per book in
// this browser, so a reload can keep one open; an opened entry's settings open from the
// settings button in its header.
import { expect, type Locator, type Page } from "@playwright/test"

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Opens an entry by its title, unless it's open already. */
export const openEntry = async (scope: Page | Locator, title: string) => {
  const toggle = scope.getByRole("button", { name: new RegExp(`^(?:Open|Close) ${escape(title)}$`) })
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click()
  await expect(toggle).toHaveAttribute("aria-expanded", "true")
}

/** Opens an opened entry's settings (everything but its title, keys and text), unless open already. */
export const openSettings = async (entry: Locator) => {
  const toggle = entry.getByRole("button", { name: /^Settings of / })
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click()
  await expect(toggle).toHaveAttribute("aria-expanded", "true")
}

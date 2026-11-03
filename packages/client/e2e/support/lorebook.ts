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

/** Opens an opened entry's settings (everything but its title, keys and text) and every section of them. */
export const openSettings = async (entry: Locator) => {
  const toggle = entry.getByRole("button", { name: /^Settings of / })
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click()
  await expect(toggle).toHaveAttribute("aria-expanded", "true")
  // In the side panel and on a narrow screen its sections are accordions, closed: open them all.
  const closed = entry
    .getByRole("region", { name: "Entry settings" })
    .locator("[data-section-toggle][aria-expanded=false]")
  while ((await closed.count()) > 0) await closed.first().click()
}

/** Enable all or Disable all, from the ⋯ in the entry list's header. */
export const switchAll = async (scope: Page | Locator, item: "Enable all" | "Disable all") => {
  await scope.getByRole("button", { name: "More for all entries", exact: true }).click()
  const page = "page" in scope ? scope.page() : scope
  await page.getByRole("menuitem", { name: item }).click()
}

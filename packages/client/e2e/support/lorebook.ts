// The lorebook table's entries (LorebookTable.tsx): which are open is remembered per book in
// this browser, so a reload can keep one open; an opened entry's settings fold under Settings.
import { expect, type Locator, type Page } from "@playwright/test"

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Opens an entry by its title, unless it's open already. */
export const openEntry = async (scope: Page | Locator, title: string) => {
  const toggle = scope.getByRole("button", { name: new RegExp(`^(?:Open|Close) ${escape(title)}$`) })
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click()
  await expect(toggle).toHaveAttribute("aria-expanded", "true")
}

/** Opens an opened entry's Settings (everything but its text and primary keys), unless open already. */
export const openSettings = async (entry: Locator) => {
  const details = entry.locator("details").filter({
    has: entry
      .page()
      .locator("summary")
      .filter({ hasText: /^Settings/ })
  })
  const summary = details.locator("summary").filter({ hasText: /^Settings/ })
  if (!(await details.evaluate((element) => (element as HTMLDetailsElement).open))) await summary.click()
  await expect(details).toHaveJSProperty("open", true)
}

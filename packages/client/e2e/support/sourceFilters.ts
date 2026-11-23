// A card source's filter bar: a section opens as a popover on a wide bar and folds open in
// place on a narrow one. These open one either way and give the locator its controls are in.
import { expect, type Locator, type Page } from "@playwright/test"

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** The section's button or row: its name is "<label>: <what's chosen>". */
export const sectionTrigger = (panel: Locator, label: string) =>
  panel.getByRole("button", { name: new RegExp(`^${escaped(label)}: `) })

/** Opens a section (if it isn't) and returns where its controls are: its popover, or the panel. */
export async function openSection(page: Page, panel: Locator, label: string): Promise<Locator> {
  const trigger = sectionTrigger(panel, label)
  if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click()
  await expect(trigger).toHaveAttribute("aria-expanded", "true")
  const popover = page.getByRole("dialog", { name: label, exact: true })
  return (await popover.count()) > 0 ? popover : panel
}

/** Closes a section's popover; a folded-open row stays as it is. */
export async function closeSection(page: Page, label: string) {
  const popover = page.getByRole("dialog", { name: label, exact: true })
  if ((await popover.count()) === 0) return
  await popover.getByRole("button", { name: "Close", exact: true }).click()
  await expect(popover).toHaveCount(0)
}

/** Shows More filters (if it isn't) and returns the panel, where they are. */
export async function openMore(panel: Locator): Promise<Locator> {
  const more = panel.getByRole("button", { name: /^More filters/ })
  if ((await more.getAttribute("aria-expanded")) !== "true") await more.click()
  await expect(more).toHaveAttribute("aria-expanded", "true")
  return panel
}

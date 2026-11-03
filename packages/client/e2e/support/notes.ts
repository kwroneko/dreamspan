// A note as a block (ARCHITECTURE §12 Notes): its region, its header's toggle, its text box and its
// folded Settings, each opened only when closed (each block remembers its state in the browser).
import { expect, type Locator, type Page } from "@playwright/test"

/** The note's block, by its title. */
export const noteBlock = (scope: Page | Locator, title: string) => scope.getByRole("region", { name: `Note ${title}` })

/** The header's button that opens or closes it: its name and the line under it ("End of tail · always"). */
export const noteToggle = (scope: Page | Locator, title: string) =>
  scope.getByRole("button", { name: new RegExp(`^(Expand|Collapse) ${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) })

/** Opens a note's block when it's closed, and returns its text box. */
export const openNoteBlock = async (block: Locator, title: string) => {
  const toggle = noteToggle(block, title)
  await expect(toggle).toBeVisible()
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click()
  await expect(toggle).toHaveAttribute("aria-expanded", "true")
  return block.getByRole("textbox", { name: `Text of ${title}` })
}

/** Closes a note's block when it's open. */
export const closeNoteBlock = async (block: Locator, title: string) => {
  const toggle = noteToggle(block, title)
  if ((await toggle.getAttribute("aria-expanded")) === "true") await toggle.click()
  await expect(toggle).toHaveAttribute("aria-expanded", "false")
}

/** Opens a note's block, then its Settings section, when they're closed. */
export const openNoteSettings = async (block: Locator, title: string) => {
  await openNoteBlock(block, title)
  const settings = block.getByRole("button", { name: `Settings of ${title}`, exact: true })
  if ((await settings.getAttribute("aria-expanded")) !== "true") await settings.click()
  await expect(settings).toHaveAttribute("aria-expanded", "true")
  return block
}

/** The note's text box, opening the note when it's closed. */
export const noteText = (scope: Page | Locator, title: string) => openNoteBlock(noteBlock(scope, title), title)

/** Opens the note, then its Settings section, when they're closed; returns the block. */
export const noteSettings = (scope: Page | Locator, title: string) => openNoteSettings(noteBlock(scope, title), title)

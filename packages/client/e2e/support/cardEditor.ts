// The card editor's tabs and its name header (CardEditor.tsx, CardNameHeader.tsx), the same in
// the chat's character tab and the full editor.
import { expect, type Locator, type Page } from "@playwright/test"

/** Opens one of the card's tabs (Definition, Greetings, Metadata, Lorebook, Notes, Extra). */
export const cardFieldsTab = async (scope: Page | Locator, name: string) => {
  const tab = scope.getByRole("tablist", { name: "Card fields" }).getByRole("tab", { name, exact: true })
  await tab.click()
  await expect(tab).toHaveAttribute("aria-selected", "true")
  return scope.getByRole("tabpanel", { name, exact: true })
}

const NAMES = {
  display: { which: "the display name", field: "Display name" },
  version: { which: "the version", field: "Version" },
  nickname: { which: "the chat name", field: "Chat name (nickname)" }
} as const

/**
 * Renames one of the card's names with its pencil and confirms with Enter. A change of the name
 * chats use asks about past messages: the caller answers that dialog.
 */
export const renameCard = async (scope: Page | Locator, name: keyof typeof NAMES, value: string) => {
  const { which, field } = NAMES[name]
  await scope.getByRole("button", { name: `Rename ${which}`, exact: true }).click()
  const box = scope.getByRole("textbox", { name: field, exact: true })
  await box.fill(value)
  await box.press("Enter")
}

/** The nickname line under the title: "In chat: <name>", or "Add a chat name". */
export const chatNameLine = (scope: Page | Locator, nickname: string) =>
  scope.getByText(nickname ? `In chat: ${nickname}` : "Add a chat name", { exact: true })

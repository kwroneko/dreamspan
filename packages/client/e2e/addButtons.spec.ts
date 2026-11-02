// Direct add actions in notes at desktop/phone widths in both themes.
// All fixture content is synthetic. Screenshots are written outside the repository.
import { mkdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import type { Locator, Page } from "@playwright/test"
import { test, expect } from "@playwright/test"
import { serverPerFile, withAdmin, ADMIN, apiLogin } from "./support/server.ts"
import { asUser } from "./support/rpc.ts"
import { openPanel } from "./support/panel.ts"
import { cardFieldsTab } from "./support/cardEditor.ts"
const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
const shots = resolve(process.env.SCREENSHOT_DIR ?? join(tmpdir(), "rp-add-buttons-screenshots"))
mkdirSync(shots, { recursive: true })

const checkNotes = async (page: Page, scope: Locator) => {
  const create = scope.getByRole("button", { name: "New note", exact: true })
  const pick = scope.getByRole("button", { name: "Pick a shared note", exact: true })
  await create.scrollIntoViewIfNeeded()
  const a = (await create.boundingBox())!
  const b = (await pick.boundingBox())!
  expect([a.width, a.height, b.width, b.height]).toEqual([32, 32, 32, 32])
  expect(b.x - a.x - a.width).toBe(4)
  expect(a.y).toBe(b.y)
  await create.focus()
  await page.keyboard.press("Shift+Tab")
  await page.keyboard.press("Tab")
  await expect(page.getByText("An empty note of its own here.", { exact: true })).toBeVisible()
  await page.keyboard.press("Tab")
  await expect(pick).toBeFocused()
  await expect(
    page.getByText("A note that shows a shared note's text: editing it changes it everywhere it's used.", {
      exact: true
    })
  ).toBeVisible()
  await page.keyboard.press("Enter")
  const dialog = page.getByRole("dialog", { name: "Pick a shared note", exact: true })
  await expect(dialog).toBeVisible()
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
  await create.click()
  await expect(scope.getByRole("textbox", { name: "Text of Note", exact: true }).last()).toBeVisible()
}

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`${width} ${theme}`, async ({ page }) => {
      test.setTimeout(180_000)
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const card = await admin((api) => api.CreateCard({ label: "Mira", name: "Mira" }))
      const chat = await admin((api) => api.CreateChat({ title: "Harbour scene" }))
      await admin((api) =>
        api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: card.entityId } })
      )
      const shoot = async (name: string) => {
        await page.mouse.move(1, 1)
        await page.screenshot({ path: join(shots, `${name}-${width}-${theme}.png`), animations: "disabled" })
      }
      await page.goto(`${server().url}/chats/${chat.id}`)
      const notes = await openPanel(page, "Notes")
      await expect(notes.getByRole("region", { name: "Mira's notes" })).toBeVisible()
      await shoot("chat-notes")
      await checkNotes(page, notes.getByRole("region", { name: "This chat's notes" }))
      await checkNotes(page, notes.getByRole("region", { name: "Mira's notes" }))
      await page.goto(`${server().url}/chats/${chat.id}?panel=card:${card.entityId}`)
      const cardPanel = page.getByRole("tabpanel", { name: "Mira", exact: true })
      await cardFieldsTab(cardPanel, "Notes")
      await expect(cardPanel.getByRole("list", { name: "The card's notes" })).toBeVisible()
      await shoot("card-tab-notes")
      await checkNotes(page, cardPanel.getByRole("tabpanel", { name: "Notes", exact: true }))
      await page.goto(`${server().url}/library/${card.id}`)
      const fullNotes = await cardFieldsTab(page, "Notes")
      await expect(fullNotes.getByRole("list", { name: "The card's notes" })).toBeVisible()
      await shoot("card-editor-notes")
      await checkNotes(page, fullNotes)
    })

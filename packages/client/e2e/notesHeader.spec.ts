// The Notes panel's section headers and a note's header (owner, 2026-11-02; DESIGN §4.1): Add
// note and Link shared note in each section's header row, a new note scrolled into view and
// flashed, the header's settings button (a closed note opens with its settings), Revert always
// shown and greyed out until something changed, and the rename pencil and save cluster on the
// title's line. At 1440 and 390 wide. The cards and notes are made up.
import { expect, type Locator, type Page, test } from "@playwright/test"
import type { RefId } from "@rp/shared/library.ts"
import { Effect } from "effect"
import { openPanel } from "./support/panel.ts"
import { asUser } from "./support/rpc.ts"
import { saveCluster } from "./support/saveRevision.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { cardFieldsTab } from "./support/cardEditor.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)

/** A chat with Mira and enough notes of its own that the list runs past the panel. */
const setUp = async (page: Page, shared?: string) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  // One session for all of it: the server limits logins.
  return admin((api) =>
    Effect.gen(function* () {
      const card = yield* api.CreateCard({ label: "Mira", name: "Mira" })
      yield* api.CreateCardNote({ cardRefId: card.id as RefId, title: "Outfit" })
      const chat = yield* api.CreateChat({ title: "Harbour scene" })
      yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: card.entityId } })
      for (const title of ["Tide", "Weather", "Lanterns", "Gulls", "Rope", "Fog", "Bells"])
        yield* api.CreateChatNote({ chatId: chat.id, title })
      if (shared) yield* api.CreateSharedNote({ title: shared, content: "Rain off the sea." })
      return { card, chat }
    })
  )
}

/** Whole-window evidence, when SCREENSHOT_DIR names a folder outside the checkout. */
const shoot = async (page: Page, name: string) => {
  if (!process.env.SCREENSHOT_DIR) return
  await page.mouse.move(1, 1)
  await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/notes-header-${name}.png` })
}

const centre = (box: { y: number; height: number }) => box.y + box.height / 2

/** The note's title line (its name's text), its pencil, and its header's buttons share one centre line. */
const expectAligned = async (block: Locator, title: string) => {
  const name = block.getByRole("button", { name: new RegExp(`^(Expand|Collapse) ${title}$`) }).getByText(title, {
    exact: true
  })
  const line = (await name.boundingBox())!
  const pencil = (await block.getByRole("button", { name: `Rename ${title}`, exact: true }).boundingBox())!
  const menu = (await block.getByRole("button", { name: `Actions for ${title}`, exact: true }).boundingBox())!
  const settings = (await block.getByRole("button", { name: `Settings of ${title}`, exact: true }).boundingBox())!
  expect(Math.abs(centre(pencil) - centre(line))).toBeLessThanOrEqual(1)
  expect(Math.abs(centre(menu) - centre(line))).toBeLessThanOrEqual(1)
  expect(Math.abs(centre(settings) - centre(line))).toBeLessThanOrEqual(1)
  // The pencil follows the name on its line.
  expect(pencil.x).toBeGreaterThanOrEqual(line.x + line.width - 1)
}

for (const width of [1440, 390])
  test.describe(`${width}`, () => {
    test.use({ viewport: { width, height: width === 390 ? 844 : 900 } })

    test("the section header adds a note, scrolled into view and flashed, and links a shared note", async ({
      page
    }) => {
      const { chat } = await setUp(page, `Harbor weather ${width}`)
      await page.goto(`${server().url}/chats/${chat.id}`)
      const tab = await openPanel(page, "Notes")
      const own = tab.getByRole("region", { name: "This chat's notes" })
      await expect(own.getByRole("region", { name: "Note Bells" })).toBeVisible()
      const header = own.locator("[data-note-section-header]")
      await expect(header.getByRole("heading", { name: "This chat" })).toBeVisible()
      const add = header.getByRole("button", { name: "Add note", exact: true })
      const link = header.getByRole("button", { name: "Link shared note", exact: true })
      // Both on the header's row, at its right end, after the name; no buttons under the notes.
      const name = (await header.getByRole("heading").boundingBox())!
      const addBox = (await add.boundingBox())!
      expect(Math.abs(centre(addBox) - centre(name))).toBeLessThanOrEqual(1)
      expect(addBox.x).toBeGreaterThan(name.x)
      await expect(own.getByRole("button", { name: "Add note" })).toHaveCount(1)
      await add.hover()
      await expect(page.getByText("Adds a new note to this chat.").filter({ visible: true })).toBeVisible()
      await tab.getByRole("region", { name: "Mira's notes" }).getByRole("button", { name: "Add note" }).hover()
      await expect(page.getByText("Adds a new note to Mira.").filter({ visible: true })).toBeVisible()

      const before = await own.getByRole("region", { name: /^Note / }).count()
      await add.click()
      await expect(own.getByRole("region", { name: /^Note / })).toHaveCount(before + 1)
      const made = own.getByRole("region", { name: "Note Note" })
      await expect(made).toHaveAttribute("data-revealed")
      await expect(made).toBeInViewport({ ratio: 1 })
      await expect(made.getByRole("textbox", { name: "Text of Note" })).toBeVisible()
      await shoot(page, `added-${width}`)
      await expect(made).not.toHaveAttribute("data-revealed", { timeout: 5_000 })

      await link.scrollIntoViewIfNeeded()
      await link.hover()
      await expect(
        page.getByText("Adds a shared note here. Editing it changes it everywhere it's used.").filter({ visible: true })
      ).toBeVisible()
      await link.click()
      const picker = page.getByRole("dialog", { name: "Pick a shared note" })
      await picker.getByRole("button", { name: new RegExp(`Harbor weather ${width}`) }).click()
      const linked = own.getByRole("region", { name: `Note Harbor weather ${width}` })
      await expect(linked).toBeInViewport({ ratio: 1 })
      await expect(linked.getByText(`Shared note “Harbor weather ${width}”`, { exact: false })).toBeVisible()
    })

    test("the header's settings button opens a closed note with its settings, and Revert waits for a change", async ({
      page
    }) => {
      const { chat } = await setUp(page)
      await page.goto(`${server().url}/chats/${chat.id}`)
      const tab = await openPanel(page, "Notes")
      const block = tab.getByRole("region", { name: "Note Tide" })
      // Seven notes: closed by default, the summary still under the name.
      const toggle = block.getByRole("button", { name: /^(Expand|Collapse) Tide$/ })
      await expect(toggle).toHaveAttribute("aria-expanded", "false")
      await expect(toggle).toContainText("as system")
      await expectAligned(block, "Tide")

      const settings = block.getByRole("button", { name: "Settings of Tide", exact: true })
      await settings.click()
      await expect(toggle).toHaveAttribute("aria-expanded", "true")
      await expect(settings).toHaveAttribute("aria-expanded", "true")
      await expect(block.getByRole("combobox").first()).toBeVisible()
      await expect(block.getByRole("textbox", { name: "Text of Tide" })).toBeVisible()
      await shoot(page, `settings-${width}`)
      // Opening the note didn't move the button under the pointer.
      await expectAligned(block, "Tide")
      // The corner X closes them, the note staying open.
      await block.getByRole("button", { name: "Close these settings", exact: true }).click()
      await expect(settings).toHaveAttribute("aria-expanded", "false")
      await expect(block.getByRole("combobox")).toHaveCount(0)
      await expect(toggle).toHaveAttribute("aria-expanded", "true")

      // Revert: shown, greyed out, until something changed.
      const cluster = saveCluster(block)
      const revert = cluster.getByRole("button", { name: "Revert to the last save", exact: true })
      await expect(revert).toBeVisible()
      await expect(revert).toBeDisabled()
      const menu = (await block.getByRole("button", { name: "Actions for Tide" }).boundingBox())!
      const clusterBox = (await cluster.boundingBox())!
      // The cluster sits at the end, before the settings button and ⋯, with even 4 px gaps.
      const settingsBox = (await settings.boundingBox())!
      expect(Math.round(settingsBox.x - (clusterBox.x + clusterBox.width))).toBe(4)
      expect(Math.round(menu.x - (settingsBox.x + settingsBox.width))).toBe(4)
      expect(Math.abs(centre(clusterBox) - centre(menu))).toBeLessThanOrEqual(1)
      await block.getByRole("textbox", { name: "Text of Tide" }).fill("High water at dusk.")
      await expect(cluster).toHaveAttribute("data-save-state", "unsaved", { timeout: 30_000 })
      await expect(revert).toBeEnabled()
      await revert.click()
      await expect(revert).toBeDisabled()
      await shoot(page, `reverted-${width}`)
    })

    test("the card's Notes tab has the same header row", async ({ page }) => {
      const { card, chat } = await setUp(page)
      await page.goto(`${server().url}/chats/${chat.id}?panel=card:${card.entityId}`)
      const panel = page.getByRole("tabpanel", { name: "Mira", exact: true })
      const notes = await cardFieldsTab(panel, "Notes")
      const header = notes.locator("[data-note-section-header]")
      await expect(header.getByRole("heading", { name: "Mira" })).toBeVisible()
      await header.getByRole("button", { name: "Add note", exact: true }).click()
      const made = notes.getByRole("region", { name: "Note Note" })
      await expect(made).toBeInViewport({ ratio: 1 })
      await expectAligned(made, "Note")
      await expectAligned(notes.getByRole("region", { name: "Note Outfit" }), "Outfit")
      await shoot(page, `card-tab-${width}`)
    })
  })

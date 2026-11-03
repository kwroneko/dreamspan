// Synthetic cards and notes only. A note's condition names several characters (DESIGN §4.1):
// in a chat's Notes tab the user picks several from the cast with the search a long cast gets,
// removes one, a card no longer in the chat among them, saves, and a reload shows the choice.
// Each choice explains itself. At desktop and phone widths, light and dark.
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import type { EntityId } from "@rp/shared/chat.ts"
import { valueField } from "@rp/shared/editing.ts"
import { Effect } from "effect"
import { asUser } from "./support/rpc.ts"
import { noteBlock, noteSettings } from "./support/notes.ts"
import { saveRevision } from "./support/saveRevision.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const shots = process.env.SCREENSHOT_DIR
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
const shoot = async (page: Page, name: string) => {
  if (!shots) return
  mkdirSync(shots, { recursive: true })
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme })
    await page.screenshot({ animations: "disabled", path: join(shots, `${name}-${colorScheme}.png`) })
  }
  await page.emulateMedia({ colorScheme: "light" })
}

const CAST = ["Ethan", "Mira", "Oren", "Tobin", "Wren", "Ash", "Bryn", "Cato", "Dara"]

for (const width of [1440, 390]) {
  test(`a note's condition names several characters, one removed, kept on reload at ${width}`, async ({ page }) => {
    test.setTimeout(180_000)
    await page.setViewportSize({ width, height: 1000 })
    const { chatId, slotId, noteId, ids } = await admin((api) =>
      Effect.gen(function* () {
        const cards = []
        for (const name of [...CAST, "Pell"]) cards.push(yield* api.CreateCard({ label: `${name} ${width}`, name }))
        const ids = Object.fromEntries(cards.map((card, i) => [[...CAST, "Pell"][i]!, card.entityId as EntityId]))
        // Pell isn't in the chat: a note can still name it, from before it left.
        const start = yield* api.StartChat({
          cards: cards.slice(0, CAST.length).map((card) => card.entityId),
          persona: null,
          greeting: null,
          first: { _tag: "Send", content: "At the quay.", speakerEntityId: null }
        })
        const note = yield* api.CreateChatNote({ chatId: start.chat.id, title: "Outfit" })
        const opened = yield* api.OpenEditor({ refId: note.id })
        const draft = yield* api.SaveEditorDraft({
          refId: note.id,
          field: valueField(["condition"]),
          draftId: null,
          content: JSON.stringify({ when: "turn", cards: [ids["Ethan"], ids["Pell"]] }),
          expectedRowVersion: null,
          expectedSession: null,
          baseRevisionId: opened.ref.headRevisionId
        })
        yield* api.CommitEditorDrafts({
          refId: note.id,
          expectedRowVersion: opened.ref.rowVersion,
          fields: [{ field: draft.key.field, draftId: draft.id, expectedRowVersion: draft.rowVersion }],
          message: null
        })
        return { chatId: start.chat.id, slotId: start.entry.slotId, noteId: note.id, ids }
      })
    )
    const stored = async () =>
      (await admin((api) => api.ListChatNotes({ chatId, slotId }))).find((note) => note.ref.id === noteId)!.doc[
        "condition"
      ]
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/chats/${chatId}?panel=notes`)
    const row = noteBlock(page, "Outfit").locator("header")
    // The header names only the cast's cards: Pell never counts here.
    await expect(row).toContainText("Ethan's turn")
    const note = await noteSettings(page, "Outfit")
    await expect(note.getByRole("combobox", { name: "When it applies" })).toContainText("On a chosen character's turn")
    const chips = note.getByRole("toolbar", { name: "Chosen characters" })
    await expect(chips.getByText("Ethan", { exact: true })).toBeVisible()
    await expect(chips.getByText("A card not in this chat", { exact: true })).toBeVisible()

    // Each "When it applies" choice says what it means.
    await note.getByRole("combobox", { name: "When it applies" }).click()
    await expect(
      page.getByRole("option", { name: "While a chosen character isn't muted" })
    ).toHaveAccessibleDescription(/at least one of the chosen characters is in the chat and not muted/)
    await shoot(page, `note-condition-when-${width}`)
    await page.keyboard.press("Escape")

    // A long cast gets a search; each character explains what choosing it means.
    await note.getByRole("combobox", { name: "Characters" }).click()
    const search = page.getByRole("dialog", { name: "Choose characters" }).getByPlaceholder("Search")
    await expect(search).toBeVisible()
    await expect(page.getByRole("option", { name: "Mira" })).toHaveAccessibleDescription(
      "Sent when Mira writes the message."
    )
    if (width === 1440) {
      await page.getByRole("option", { name: "Oren" }).hover()
      await expect(page.locator("[data-explanation]")).toHaveText("Sent when Oren writes the message.")
    } else {
      // No hover on a phone: the explanation is under each name.
      await expect(page.getByRole("option", { name: "Oren" })).toContainText("Sent when Oren writes the message.")
    }
    await search.fill("mi")
    await expect(page.getByRole("option")).toHaveCount(1)
    await page.getByRole("option", { name: "Mira" }).click()
    await search.fill("or")
    await page.getByRole("option", { name: "Oren" }).click()
    await shoot(page, `note-condition-picking-${width}`)
    await page.keyboard.press("Escape")
    await expect(chips.getByText("Mira", { exact: true })).toBeVisible()
    await expect(chips.getByText("Oren", { exact: true })).toBeVisible()

    // The card no longer in the chat is removed with its chip's button.
    await chips.getByRole("button", { name: "Remove A card not in this chat" }).click()
    await expect(chips.getByText("A card not in this chat", { exact: true })).toHaveCount(0)
    await shoot(page, `note-condition-chosen-${width}`)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)

    await saveRevision(note)
    await expect.poll(stored).toEqual({ when: "turn", cards: [ids["Ethan"], ids["Mira"], ids["Oren"]] })
    await expect(row).toContainText("Ethan's, Mira's or Oren's turn")

    // A reload shows the same three.
    await page.reload()
    // The note and its settings stay open: each remembers.
    await noteSettings(page, "Outfit")
    const reloaded = page
      .getByRole("region", { name: "Note Outfit" })
      .getByRole("toolbar", { name: "Chosen characters" })
    for (const name of ["Ethan", "Mira", "Oren"]) await expect(reloaded.getByText(name, { exact: true })).toBeVisible()
    await expect(reloaded.getByText("A card not in this chat", { exact: true })).toHaveCount(0)

    // At least one stays: the last chip has no remove button; Always drops the condition.
    for (const name of ["Mira", "Oren"]) await reloaded.getByRole("button", { name: `Remove ${name}` }).click()
    await expect(reloaded.getByRole("button", { name: /^Remove/ })).toHaveCount(0)
    await expect(reloaded.getByText("Ethan", { exact: true })).toBeVisible()
    await shoot(page, `note-condition-last-${width}`)
  })
}

// Synthetic notes only. A chat's notes have no author's note (owner, 2026-11-01): a note named
// "Author's Note", as an ST import names the chat's, is an ordinary note, with no mark, no
// button to make one the author's note and no place relative to one, at desktop and phone
// widths in both themes.
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { noteSettings, noteToggle } from "./support/notes.ts"
import { asUser } from "./support/rpc.ts"

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

for (const width of [1440, 390]) {
  test(`a chat's notes show no author's note controls at ${width}`, async ({ page }) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width, height: 1000 })
    const { chat } = await admin((api) =>
      Effect.gen(function* () {
        const card = yield* api.CreateCard({ label: `Anchor ${width}`, name: "Wren" })
        const start = yield* api.StartChat({
          cards: [card.entityId],
          persona: null,
          greeting: null,
          first: { _tag: "Send", content: "At the quay.", speakerEntityId: null }
        })
        yield* api.CreateChatNote({ chatId: start.chat.id, title: "Author's Note" })
        yield* api.CreateChatNote({ chatId: start.chat.id, title: "Mood" })
        return { chat: start.chat }
      })
    )
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/chats/${chat.id}?panel=notes`)
    const row = (title: string) => noteToggle(page, title)
    await expect(row("Author's Note")).toBeVisible()
    await expect(row("Mood")).toBeVisible()
    await shoot(page, `notes-no-author-note-${width}`)

    for (const title of ["Author's Note", "Mood"]) {
      const note = await noteSettings(page, title)
      await expect(note).toBeVisible()
      // No mark on the row, and nothing to make it, or stop it being, the author's note.
      await expect(row(title).getByText("author's note", { exact: true })).toHaveCount(0)
      await expect(page.getByRole("button", { name: /as (the )?author's note/i })).toHaveCount(0)
      // Its places are concrete ones: none is relative to an author's note.
      await note.getByRole("combobox", { name: "Position" }).click()
      await expect(page.getByRole("option").first()).toBeVisible()
      await expect(page.getByRole("option", { name: /author's note/i })).toHaveCount(0)
      if (title === "Author's Note") await shoot(page, `notes-no-author-note-positions-${width}`)
      await page.keyboard.press("Escape")
    }
  })
}

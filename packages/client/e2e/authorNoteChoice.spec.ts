// Synthetic notes only. The user chooses which chat note is the author's note, from its row in
// the chat's Notes tab, at desktop and phone widths in both themes.
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
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
  test(`a chat note is chosen as the author's note, replaced and cleared at ${width}`, async ({ page }) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width, height: 1000 })
    const { chat, leaf } = await admin((api) =>
      Effect.gen(function* () {
        const card = yield* api.CreateCard({ label: `Anchor ${width}`, name: "Wren" })
        const start = yield* api.StartChat({
          cards: [card.entityId],
          persona: null,
          greeting: null,
          first: { _tag: "Send", content: "At the quay.", speakerEntityId: null }
        })
        yield* api.CreateChatNote({ chatId: start.chat.id, title: "Scene" })
        yield* api.CreateChatNote({ chatId: start.chat.id, title: "Mood" })
        return { chat: start.chat, leaf: start.entry.slotId }
      })
    )
    const chosen = async () =>
      (await admin((api) => api.ListChatNotes({ chatId: chat.id, slotId: leaf })))
        .filter((note) => note.authorNote)
        .map((note) => note.ref.label)
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/chats/${chat.id}?panel=notes`)
    const row = (title: string) => page.getByRole("button", { name: new RegExp(`^${title}`) })
    await expect(row("Scene")).not.toContainText("author's note")

    await row("Scene").click()
    await page.getByRole("button", { name: "Use as author's note", exact: true }).click()
    await expect(row("Scene")).toContainText("author's note")
    await expect(page.getByText("This is the chat's author's note")).toBeVisible()
    await expect.poll(chosen).toEqual(["Scene"])
    await shoot(page, `author-note-${width}`)

    // Choosing another moves it.
    await row("Mood").click()
    await page.getByRole("button", { name: "Use as author's note", exact: true }).click()
    await expect(row("Mood")).toContainText("author's note")
    await expect(row("Scene")).not.toContainText("author's note")
    await expect.poll(chosen).toEqual(["Mood"])

    // And it can be cleared, which a reload keeps.
    await page.getByRole("button", { name: "Stop using as author's note", exact: true }).click()
    await expect(row("Mood")).not.toContainText("author's note")
    await expect.poll(chosen).toEqual([])
    await page.reload()
    await expect(row("Mood")).toBeVisible()
    await expect(page.getByText("author's note", { exact: true })).toHaveCount(0)
  })
}

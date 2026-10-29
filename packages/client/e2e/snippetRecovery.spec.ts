// Synthetic text only. A snippet's visible Undo and earlier text come from the server's
// history, so they work after a reload, at desktop and phone widths in both themes.
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { asUser } from "./support/rpc.ts"
import { openPanel } from "./support/panel.ts"

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
  test(`a snippet's earlier text survives a reload and comes back with Undo or Earlier text at ${width}`, async ({
    page
  }) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width, height: 1000 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const chat = await admin((api) => api.CreateChat({ title: `Scene fragments ${width}` }))
    const original = "The lighthouse keeper counts the gulls at dawn."
    await admin((api) =>
      api.CreateSnippet({ chatId: chat.id, forkId: null, title: `Fragments ${width}`, content: original })
    )
    const content = async () => (await admin((api) => api.ListSnippets({ chatId: chat.id, forkId: null })))[0]?.content
    await page.goto(`${server().url}/chats/${chat.id}`)
    let panel = await openPanel(page, "Snippets")
    const editor = () => panel.getByRole("textbox", { name: "Snippet text" })
    await expect(editor()).toHaveText(original)
    await editor().fill("Replaced.")
    await expect.poll(content).toBe("Replaced.")

    // A reload loses the editor's own undo; the visible Undo still goes back.
    await page.reload()
    panel = await openPanel(page, "Snippets")
    await expect(editor()).toHaveText("Replaced.")
    await shoot(page, `snippet-undo-${width}`)
    await panel.getByRole("button", { name: `Undo Fragments ${width}`, exact: true }).click()
    await expect(editor()).toHaveText(original)
    await expect.poll(content).toBe(original)

    // Earlier text lists the replaced text too, since restoring keeps it.
    await page.reload()
    panel = await openPanel(page, "Snippets")
    await panel.getByRole("button", { name: `Earlier text of Fragments ${width}`, exact: true }).click()
    const dialog = page.getByRole("dialog", { name: `Earlier text of Fragments ${width}` })
    const states = dialog.getByRole("list", { name: "Earlier texts" }).getByRole("listitem")
    await expect(states.filter({ hasText: "9 characters" })).toHaveCount(1)
    await shoot(page, `snippet-history-${width}`)
    await states.filter({ hasText: "9 characters" }).getByRole("button", { name: "Restore" }).click()
    await expect(dialog).toHaveCount(0)
    await expect(editor()).toHaveText("Replaced.")
    await expect.poll(content).toBe("Replaced.")
  })
}

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
  test(`an inherited snippet's first edit is undoable after reload and promotion at ${width}`, async ({ page }) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width, height: 1000 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const chat = await admin((api) => api.CreateChat({ title: `Inherited snippet ${width}` }))
    const original = "The harbour is quiet before dawn."
    const made = await admin((api) =>
      api.CreateSnippet({ chatId: chat.id, forkId: chat.currentForkId, title: `Inherited ${width}`, content: original })
    )
    try {
      const child = await admin((api) =>
        api.CreateFork({ chatId: chat.id, fromForkId: chat.currentForkId, atSlotId: null })
      )
      const scope = { chatId: chat.id, forkId: child.fork.id }
      await page.goto(`${server().url}/chats/${chat.id}`)
      let panel = await openPanel(page, "Snippets")
      const select = () =>
        panel
          .getByRole("list", { name: "Snippets" })
          .getByRole("button", { name: new RegExp(`^Inherited ${width}`) })
          .click()
      await select()
      const editor = () => panel.getByRole("textbox", { name: "Snippet text" })
      await expect(editor()).toHaveText(original)
      await editor().fill("Replacement.")
      await expect.poll(async () => (await admin((api) => api.ListSnippets(scope)))[0]?.content).toBe("Replacement.")
      await page.reload()
      panel = await openPanel(page, "Snippets")
      await select()
      await panel.getByRole("button", { name: `Undo Inherited ${width}`, exact: true }).click()
      await expect(editor()).toHaveText(original)
      await panel.getByRole("button", { name: "Make global", exact: true }).click()
      await expect(panel.getByRole("button", { name: "Make global", exact: true })).toHaveCount(0)
      await page.reload()
      panel = await openPanel(page, "Snippets")
      await select()
      await panel.getByRole("button", { name: `Earlier text of Inherited ${width}`, exact: true }).click()
      const dialog = page.getByRole("dialog", { name: `Earlier text of Inherited ${width}` })
      const replacement = dialog.getByRole("listitem").filter({ hasText: "12 characters" })
      await expect(replacement).toHaveCount(1)
      await shoot(page, `snippet-promoted-history-${width}`)
      await replacement.getByRole("button", { name: "Restore" }).click()
      await expect(editor()).toHaveText("Replacement.")
      const parent = (await admin((api) => api.ListSnippets({ chatId: chat.id, forkId: chat.currentForkId })))[0]!
      expect(parent.global).toBe(true)
      expect(parent.content).toBe("Replacement.")
    } finally {
      await admin((api) => api.DeleteNote({ noteRefId: made.ref.id }))
    }
  })

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

for (const width of [1440, 390]) {
  test(`a snippet is deleted to the bin with Undo, and a shared one says what shows it at ${width}`, async ({
    page
  }) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width, height: 1000 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const chat = await admin((api) => api.CreateChat({ title: `Snippet tidy ${width}` }))
    const scope = { chatId: chat.id, forkId: null }
    await admin((api) => api.CreateSnippet({ ...scope, title: `Empty ${width}`, content: "" }))
    const linked = await admin((api) => api.CreateSnippet({ ...scope, title: `Shown ${width}`, content: "Fog." }))
    await admin((api) =>
      api.CreateChatNote({ chatId: chat.id, forkId: chat.currentForkId, title: "Weather", link: linked.ref.entityId })
    )
    const titles = async () =>
      (await admin((api) => api.ListSnippets(scope))).map((item) => item.title).filter((t) => t.endsWith(`${width}`))
    await page.goto(`${server().url}/chats/${chat.id}`)
    const panel = await openPanel(page, "Snippets")
    const list = panel.getByRole("list", { name: "Snippets" })

    // An unused snippet goes straight to the bin; the toast's Undo brings it back.
    await list.getByRole("button", { name: new RegExp(`^Empty ${width}`) }).click()
    await panel.getByRole("button", { name: `Delete Empty ${width}`, exact: true }).click()
    await expect(page.getByText(`Deleted: Empty ${width}`)).toBeVisible()
    await expect(list.getByRole("button", { name: new RegExp(`^Empty ${width}`) })).toHaveCount(0)
    await expect.poll(titles).toEqual([`Shown ${width}`])
    await shoot(page, `snippet-deleted-${width}`)
    await page.getByRole("button", { name: "Undo", exact: true }).click()
    await expect(list.getByRole("button", { name: new RegExp(`^Empty ${width}`) })).toBeVisible()
    await expect.poll(titles).toEqual([`Empty ${width}`, `Shown ${width}`])

    // A snippet a chat note shows asks first, and says so.
    await list.getByRole("button", { name: new RegExp(`^Shown ${width}`) }).click()
    await panel.getByRole("button", { name: `Delete Shown ${width}`, exact: true }).click()
    const confirm = page.getByRole("alertdialog", { name: `Delete Shown ${width}?` })
    await expect(confirm).toContainText("1 note in a card or chat shows it")
    await shoot(page, `snippet-delete-shared-${width}`)
    await confirm.getByRole("button", { name: "Cancel" }).click()
    await expect.poll(titles).toEqual([`Empty ${width}`, `Shown ${width}`])
    await panel.getByRole("button", { name: `Delete Shown ${width}`, exact: true }).click()
    await confirm.getByRole("button", { name: "Delete snippet" }).click()
    await expect(page.getByText(`Deleted: Shown ${width}`)).toBeVisible()
    await expect.poll(titles).toEqual([`Empty ${width}`])
    const bin = await admin((api) => api.ListBin({ limit: 50, before: null }))
    expect(bin.some((item) => item.kind === "entity" && item.title === `Shown ${width}`)).toBe(true)
  })
}

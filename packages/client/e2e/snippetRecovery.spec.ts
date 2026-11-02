// Synthetic text only. A snippet's earlier texts come from its edit history on the server, so
// they're there after a reload; Delete goes to the bin with Undo, and says first what shows a
// shared one. At desktop and phone widths in both themes.
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, type Locator, type Page, test } from "@playwright/test"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { asUser } from "./support/rpc.ts"
import { openPanel } from "./support/panel.ts"
import { expectTextBox } from "./support/textbox.ts"

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

/** A snippet's block, open: its text box. */
const openSnippet = async (panel: Locator, title: string) => {
  const block = panel.getByRole("region", { name: `Snippet ${title}` })
  const toggle = block.getByRole("button", { name: new RegExp(`^(Expand|Collapse) ${title}$`) })
  await expect(toggle).toBeVisible()
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click()
  return { block, text: block.getByRole("textbox", { name: `Text of ${title}` }) }
}

for (const width of [1440, 390]) {
  test(`a snippet's earlier text survives a reload and comes back from its edit history at ${width}`, async ({
    page
  }) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width, height: 1000 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const chat = await admin((api) => api.CreateChat({ title: `Scene fragments ${width}` }))
    const title = `Fragments ${width}`
    const original = "The lighthouse keeper counts the gulls at dawn."
    const made = await admin((api) => api.CreateSnippet({ chatId: chat.id, title, content: original }))
    const content = async () => (await admin((api) => api.ListSnippets({ chatId: chat.id })))[0]?.content
    await page.goto(`${server().url}/chats/${chat.id}`)
    let panel = await openPanel(page, "Snippets")
    let { text } = await openSnippet(panel, title)
    await expectTextBox(text, original)
    await text.fill("Replaced.")
    await expect.poll(content).toBe("Replaced.")
    // Typing makes no revision: Save does.
    expect(await admin((api) => api.ListRevisions({ refId: made.ref.id, limit: 10 }))).toHaveLength(1)

    // A reload loses the box's own undo; its edit history still has the text before.
    await page.reload()
    panel = await openPanel(page, "Snippets")
    ;({ text } = await openSnippet(panel, title))
    await expectTextBox(text, "Replaced.")
    await panel.getByRole("button", { name: `Edit history of Text of ${title}`, exact: true }).click()
    const dialog = page.getByRole("dialog", { name: `Edit history: Text of ${title}` })
    const earlier = dialog.getByRole("list", { name: "Earlier states" }).getByRole("button", { name: /characters/ })
    await earlier
      .filter({ hasText: `${original.length} characters` })
      .first()
      .click()
    await expect(dialog.getByLabel("Text of the state")).toHaveText(original)
    await shoot(page, `snippet-edit-history-${width}`)
    await dialog.getByRole("button", { name: "Put this text in the box" }).click()
    await expect(dialog).toHaveCount(0)
    await expectTextBox(text, original)
    await expect.poll(content).toBe(original)
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
    const scope = { chatId: chat.id }
    await admin((api) => api.CreateSnippet({ ...scope, title: `Empty ${width}`, content: "" }))
    const linked = await admin((api) => api.CreateSnippet({ ...scope, title: `Shown ${width}`, content: "Fog." }))
    await admin((api) =>
      api.CreateChatNote({ chatId: chat.id, forkId: chat.currentForkId, title: "Weather", link: linked.ref.entityId })
    )
    const titles = async () =>
      (await admin((api) => api.ListSnippets(scope))).map((item) => item.title).filter((t) => t.endsWith(`${width}`))
    await page.goto(`${server().url}/chats/${chat.id}`)
    const panel = await openPanel(page, "Snippets")
    const block = (title: string) => panel.getByRole("region", { name: `Snippet ${title}` })

    // An unused snippet goes straight to the bin; the toast's Undo brings it back.
    await openSnippet(panel, `Empty ${width}`)
    await panel.getByRole("button", { name: `Delete Empty ${width}`, exact: true }).click()
    await expect(page.getByText(`Empty ${width} moved to the bin.`)).toBeVisible()
    await expect(block(`Empty ${width}`)).toHaveCount(0)
    await expect.poll(titles).toEqual([`Shown ${width}`])
    await shoot(page, `snippet-deleted-${width}`)
    await page.getByRole("button", { name: "Undo", exact: true }).click()
    await expect(block(`Empty ${width}`)).toBeVisible()
    await expect.poll(titles).toEqual([`Empty ${width}`, `Shown ${width}`])

    // A snippet a chat note shows asks first, and says so.
    await openSnippet(panel, `Shown ${width}`)
    await panel.getByRole("button", { name: `Delete Shown ${width}`, exact: true }).click()
    const confirm = page.getByRole("alertdialog", { name: `Delete Shown ${width}?` })
    await expect(confirm).toContainText("This snippet is shared by 1 note in a card or chat.")
    await shoot(page, `snippet-delete-shared-${width}`)
    await confirm.getByRole("button", { name: "Cancel" }).click()
    await expect.poll(titles).toEqual([`Empty ${width}`, `Shown ${width}`])
    await panel.getByRole("button", { name: `Delete Shown ${width}`, exact: true }).click()
    await confirm.getByRole("button", { name: "Delete snippet" }).click()
    await expect(page.getByText(`Shown ${width} moved to the bin.`)).toBeVisible()
    await expect.poll(titles).toEqual([`Empty ${width}`])
    const bin = await admin((api) => api.ListBin({ limit: 50, before: null }))
    expect(bin.some((item) => item.kind === "entity" && item.title === `Shown ${width}`)).toBe(true)
  })
}

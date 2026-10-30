import { join } from "node:path"
import { mkdir } from "node:fs/promises"
import { expect, test, type Page } from "@playwright/test"
import { Effect } from "effect"
import type { LorebookDoc } from "@rp/shared/docs/lorebook.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { expectTextBox } from "./support/textbox.ts"
import { openPanel } from "./support/panel.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
const save = async (page: Page) => {
  await page.getByRole("button", { name: /^Save \(/ }).click()
  const dialog = page.getByRole("dialog", { name: "Save a revision" })
  await dialog.getByRole("button", { name: "Save revision" }).click()
  await expect(page.getByRole("status").filter({ hasText: "Everything is saved." })).toBeVisible()
}

// A synthetic ST world info file; nothing here comes from a real book.
const worldInfo = (name: string) => ({
  name,
  entries: {
    0: { uid: 0, key: ["harbour", "quay"], comment: "Harbour", content: "Boats rock at the quay.", order: 10 },
    1: { uid: 1, key: ["lamp", "lantern"], comment: "Lamp", content: "The lamp burns blue at night.", order: 20 },
    2: { uid: 2, key: ["fog"], comment: "Fog", content: "Fog rolls in at dusk.", order: 30, disable: true }
  }
})

for (const width of [1440, 390]) {
  test(`a standalone lorebook lists, filters, edits, saves, restores and exports its entries at ${width}`, async ({
    page
  }) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width, height: 1000 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const response = await page.request.post(`${server().url}/library/import?name=Saltmarsh ${width}.json`, {
      headers: { "content-type": "application/octet-stream", origin: server().url },
      data: Buffer.from(JSON.stringify(worldInfo(`Saltmarsh ${width}`)))
    })
    expect(response.status()).toBe(200)
    const {
      library: { ref }
    } = await response.json()
    const chat = await admin((api) =>
      Effect.gen(function* () {
        const made = yield* api.CreateChat({ title: `Lorebook links ${width}` })
        yield* api.ChangeCast({
          chatId: made.id,
          slotId: null,
          change: { _tag: "Lorebook", ref: ref.id, active: true }
        })
        return made
      })
    )
    await page.goto(`${server().url}/chats/${chat.id}`)
    const panel = await openPanel(page, "Lorebooks")
    await panel.getByRole("link", { name: `Open Saltmarsh ${width}`, exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/library/${ref.id}$`))
    await expect(page.getByText("Lorebooks can't be edited here yet")).toHaveCount(0)
    await expect(page.getByRole("switch", { name: /Use in every chat/ })).toBeVisible()
    // The first entry opens; the others show their keys and the start of their text.
    const harbour = page.getByRole("group", { name: "Lorebook entry 0", exact: true })
    await expectTextBox(harbour.getByRole("textbox", { name: "Entry content" }), "Boats rock at the quay.")
    const lamp = page.locator("summary").filter({ hasText: /^Lamp/ })
    await expect(lamp).toContainText("lamp, lantern")
    await expect(lamp).toContainText("The lamp burns blue at night.")
    await expect(page.locator("summary").filter({ hasText: /^Fog/ })).toContainText("Off · fog")

    // The filter narrows by title, key or text.
    const filter = page.getByRole("searchbox", { name: "Filter entries" })
    await filter.fill("lantern")
    await expect(page.locator("summary").filter({ hasText: /^(Harbour|Lamp|Fog)/ })).toHaveCount(1)
    await expect(page.getByText("1 of 3 entries match.")).toBeVisible()
    await filter.fill("")

    // Edits are drafts that survive a reload, then a saved revision.
    await harbour.getByRole("textbox", { name: "Entry content" }).fill("Boats rock at the old quay.")
    await harbour.getByRole("textbox", { name: "Primary keys" }).fill("harbour\nquay\npier")
    await harbour.getByRole("textbox", { name: "Primary keys" }).blur()
    await expect
      .poll(
        async () =>
          (await admin((api) => api.OpenEditor({ refId: ref.id }))).drafts.filter((d) => d.status === "active").length
      )
      .toBe(2)
    await page.reload()
    await expectTextBox(harbour.getByRole("textbox", { name: "Entry content" }), "Boats rock at the old quay.")
    await save(page)
    const book = async () => (await admin((api) => api.OpenEditor({ refId: ref.id }))).doc as unknown as LorebookDoc
    expect((await book()).entries[0]).toMatchObject({
      uid: 0,
      content: "Boats rock at the old quay.",
      keys: ["harbour", "quay", "pier"]
    })
    const firstRevision = (await admin((api) => api.OpenEditor({ refId: ref.id }))).ref.headRevisionId

    // Remove one entry and add another.
    await harbour.getByRole("button", { name: "Remove entry", exact: true }).click()
    await expect(harbour).toHaveCount(0)
    await page.getByRole("button", { name: "Add lorebook entry", exact: true }).click()
    const added = page.getByRole("group", { name: /^Lorebook entry/ }).last()
    await added.getByRole("textbox", { name: "Entry title" }).fill("Gulls")
    await added.getByRole("textbox", { name: "Primary keys" }).fill("gull")
    await added.getByRole("textbox", { name: "Entry content" }).fill("Gulls gather on the roofs.")
    await save(page)
    expect((await book()).entries.map((e) => e.comment)).toEqual(["Lamp", "Fog", "Gulls"])

    // Search and replace reaches closed entries and their keys.
    await page.getByRole("button", { name: "Search", exact: true }).click()
    const dialog = page.getByRole("dialog", { name: "Search and replace" })
    await dialog.getByRole("textbox", { name: "Find", exact: true }).fill("lamp")
    await dialog.getByRole("textbox", { name: "Replace with", exact: true }).fill("torch")
    await dialog.getByRole("button", { name: "Find", exact: true }).click()
    await expect(dialog.getByRole("status")).toHaveText("3 matches.")
    await dialog.getByRole("button", { name: "Replace all", exact: true }).click()
    await dialog.press("Escape")
    await save(page)
    expect((await book()).entries[0]).toMatchObject({ comment: "torch", keys: ["torch", "lantern"] })

    // Export keeps working from the saved revision.
    const exported = await page.request.post(`${server().url}/library/export`, {
      headers: { origin: server().url },
      data: { refId: ref.id, format: "st-world-info" }
    })
    expect(exported.status()).toBe(200)
    expect(JSON.stringify(await exported.json())).toContain("Gulls gather on the roofs.")

    // An earlier revision brings the removed entry back.
    await admin((api) =>
      Effect.gen(function* () {
        const opened = yield* api.OpenEditor({ refId: ref.id })
        yield* api.RestoreRevision({
          refId: ref.id,
          revisionId: firstRevision,
          expectedRowVersion: opened.ref.rowVersion
        })
      })
    )
    await page.reload()
    await expectTextBox(harbour.getByRole("textbox", { name: "Entry content" }), "Boats rock at the old quay.")

    const dir = process.env.SCREENSHOT_DIR
    if (dir) {
      await mkdir(dir, { recursive: true })
      for (const colorScheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme })
        await page.getByRole("heading", { name: "Entries", exact: true }).scrollIntoViewIfNeeded()
        await page.screenshot({ animations: "disabled", path: join(dir, `lorebook-${width}-${colorScheme}.png`) })
        await page.locator("summary").filter({ hasText: /^Lamp/ }).scrollIntoViewIfNeeded()
        await page.screenshot({ animations: "disabled", path: join(dir, `lorebook-list-${width}-${colorScheme}.png`) })
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
      }
    }
  })
}

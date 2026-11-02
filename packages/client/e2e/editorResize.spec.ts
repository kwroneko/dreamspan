// The large editor must survive the breakpoint that turns the chat panel into a modal
// phone sheet. All fixtures are synthetic; the lorebook has forty entries expanded.
import { readFileSync } from "node:fs"
import type { LibraryRef } from "@rp/shared/library.ts"
import { expect, type Locator, type Page, test } from "@playwright/test"
import { openPanel } from "./support/panel.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
const preset = JSON.parse(
  readFileSync(new URL("../../server/test/fixtures/presets/default.json", import.meta.url), "utf8")
) as Record<string, unknown>

const upload = async (page: Page, name: string, doc: unknown) => {
  const response = await page.request.post(`${server().url}/library/import?name=${encodeURIComponent(name)}.json`, {
    headers: { origin: server().url, "content-type": "application/octet-stream" },
    data: Buffer.from(JSON.stringify(doc))
  })
  expect(response.status()).toBe(200)
  return ((await response.json()) as { library: { ref: LibraryRef } }).library.ref
}

const book = {
  name: "Resize book",
  entries: Object.fromEntries(
    Array.from({ length: 40 }, (_, uid) => [
      uid,
      {
        uid,
        key: [`place${uid}`, "harbour"],
        comment: `Place ${uid}`,
        content: Array.from({ length: 1 + (uid % 4) }, () =>
          "The quay is quiet. A lighthouse stands above the harbour. ".repeat(4 + (uid % 8))
        ).join("\n\n"),
        order: uid
      }
    ])
  )
}

/** Includes the viewport change, rendered frames, and a real pointer/keyboard action. */
const resizeAndUse = async (page: Page, editor: Locator, use: () => Promise<void>) => {
  await test.step(
    "resize and use the editor within fifteen seconds",
    async () => {
      await page.setViewportSize({ width: 390, height: 844 })
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      )
      // A second, modal dialog would cover the editor and mark its ancestor inert.
      await expect(page.getByRole("dialog")).toHaveCount(1)
      await expect(editor).toBeVisible()
      await use()
    },
    { timeout: 15_000 }
  )
}

for (const kind of ["lorebook", "preset", "card"] as const) {
  test(`the ${kind} editor stays interactive when an open desktop panel becomes a phone sheet`, async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const ref = await upload(
      page,
      kind === "lorebook" ? "Resize book" : `Resize ${kind}`,
      kind === "lorebook"
        ? book
        : kind === "preset"
          ? preset
          : {
              spec: "chara_card_v2",
              spec_version: "2.0",
              data: { name: "Resize card", description: "A harbour pilot.", first_mes: "The bell rings." }
            }
    )
    const chat = await admin((api) => api.CreateChat({ title: `Resize ${kind}` }))
    if (kind === "lorebook") {
      await admin((api) =>
        api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Lorebook", ref: ref.id, active: true } })
      )
    } else if (kind === "preset") {
      await admin((api) => api.ChangeGenerationDefaults({ change: { preset: ref.id } }))
    } else {
      await admin((api) =>
        api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: ref.entityId } })
      )
    }
    await page.goto(`${server().url}/chats/${chat.id}`)
    const tab = kind === "lorebook" ? "Lorebooks" : kind === "preset" ? "Prompt preset" : "Resize card"
    const panel = await openPanel(page, tab)
    if (kind === "lorebook") {
      await panel
        .getByRole("button", { name: /^Resize book/ })
        .first()
        .click()
      await panel.getByRole("button", { name: "Expand all", exact: true }).click()
      await panel.getByRole("button", { name: "Large editor", exact: true }).click()
    } else {
      await panel
        .getByRole("button", {
          name: kind === "preset" ? "Open the preset in the large editor" : "Open Resize card in the full editor",
          exact: true
        })
        .click()
    }
    const editor = page.getByRole("dialog", {
      name: kind === "lorebook" ? "Lorebook editor" : kind === "preset" ? "Preset editor" : "Card editor",
      exact: true
    })
    await expect(editor).toBeVisible()
    // This is the coexistence that fails at the breakpoint: both surfaces mounted at 1024.
    await expect(panel).toBeVisible()
    const field = editor
      .getByRole("textbox", {
        name: kind === "lorebook" ? "Entry content" : kind === "preset" ? "Prompt: Main Prompt" : "Description",
        exact: true
      })
      .first()
    await expect(field).toBeVisible()
    if (kind === "lorebook") {
      // Expand all persists all forty, even though only a window of rows is mounted.
      expect(
        await page.evaluate((id) => JSON.parse(localStorage.getItem(`rp.lorebookOpen:${id}:`) ?? "[]").length, ref.id)
      ).toBe(40)
    }
    await resizeAndUse(page, editor, async () => {
      await field.fill("Edited after resizing.")
      await expect(field).toHaveText("Edited after resizing.")
      if (kind === "lorebook") {
        await editor.getByRole("searchbox", { name: "Filter by titles, keys and content" }).fill("place0")
        await expect(editor.getByRole("textbox", { name: "Title of Place 0", exact: true })).toBeVisible()
      }
    })
    // Closing the editor returns to a usable chat, with no invisible modal trapping focus.
    await editor
      .getByRole("button", { name: kind === "preset" ? "Close preset editor" : "Back to the chat", exact: true })
      .click()
    await expect(editor).toHaveCount(0)
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeEditable()
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("The chat still works.")
    await expect(await openPanel(page, tab)).toBeVisible()
  })
}

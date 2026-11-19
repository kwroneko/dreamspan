// ⋯ Export (ARCHITECTURE.md §13b): the branch shown as SillyTavern's .jsonl with every
// version of a message, and every branch as a .zip, at both widths and themes. Synthetic chat.
import { readFileSync } from "node:fs"
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`exports a branch with its versions, and every branch as a zip: ${width} ${theme}`, async ({ page }, info) => {
      const title = `Synthetic export ${width} ${theme}`
      const chat = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        Effect.gen(function* () {
          const chat = yield* api.CreateChat({ title })
          const first = yield* api.SendMessage({
            chatId: chat.id,
            parentSlotId: null,
            branch: false,
            content: "First take."
          })
          if (first._tag !== "Posted") return yield* Effect.die("unexpected queue")
          yield* api.WriteVersion({
            slotId: first.entry.slotId,
            content: "Second take.",
            expectedRowVersion: first.entry.rowVersion
          })
          const reply = yield* api.SendMessage({
            chatId: chat.id,
            parentSlotId: first.entry.slotId,
            branch: false,
            content: "A reply."
          })
          if (reply._tag !== "Posted") return yield* Effect.die("unexpected queue")
          // A second branch from the first message, which becomes the one the chat opens on.
          yield* api.CreateFork({ chatId: chat.id, fromForkId: null, atSlotId: first.entry.slotId })
          return chat
        })
      )
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/chats/${chat.id}`)
      await expect(page.getByTestId("composer")).toBeVisible()

      const open = async () => {
        await page.getByRole("button", { name: "Chat actions", exact: true }).click()
        await page.getByRole("menuitem", { name: "Export…", exact: true }).click()
        return page.getByRole("dialog", { name: "Export this chat", exact: true })
      }
      let dialog = await open()
      const exportUrl = page.url()
      await expect(dialog.getByRole("button", { name: "SillyTavern (.jsonl)", exact: true })).toHaveAttribute(
        "aria-pressed",
        "true"
      )
      await expect(dialog.getByRole("button", { name: "This branch", exact: true })).toHaveAttribute(
        "aria-pressed",
        "true"
      )
      await expect(dialog.getByText(/Not in the file: pictures/)).toBeVisible()
      await expectLayout(page, info, "chat-export", { scope: '[role="dialog"]' })
      await page.screenshot({ path: info.outputPath("chat-export.png"), animations: "disabled" })
      let download = page.waitForEvent("download")
      await dialog.getByRole("button", { name: "Export", exact: true }).click()
      const branch = await download
      expect(branch.suggestedFilename()).toBe(`${title}.jsonl`)
      const lines = readFileSync(await branch.path(), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      expect(lines[0]).toMatchObject({ chat_metadata: {} })
      expect(lines[1]).toMatchObject({ mes: "Second take.", swipe_id: 1, swipes: ["First take.", "Second take."] })
      await expect(dialog).toHaveCount(0)

      dialog = await open()
      await dialog.getByRole("button", { name: "Every branch", exact: true }).click()
      await expect(dialog.getByText(/Separate contexts and away periods/)).toBeVisible()
      await expectLayout(page, info, "chat-export-all", { scope: '[role="dialog"]' })
      await page.screenshot({ path: info.outputPath("chat-export-all.png"), animations: "disabled" })
      download = page.waitForEvent("download")
      await dialog.getByRole("button", { name: "Export", exact: true }).click()
      const zip = await download
      expect(zip.suggestedFilename()).toBe(`${title}.zip`)
      expect(
        readFileSync(await zip.path())
          .subarray(0, 2)
          .toString()
      ).toBe("PK")
      await expect(dialog).toHaveCount(0)
      expect(page.url()).toBe(exportUrl)
    })

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`exports the whole library as a zip: ${width} ${theme}`, async ({ page }, info) => {
      await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        Effect.gen(function* () {
          const chat = yield* api.CreateChat({ title: `Synthetic library ${width} ${theme}` })
          yield* api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "Kept." })
        })
      )
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/import`)
      await expect(page.getByRole("heading", { name: "Export the whole library", exact: true })).toBeVisible()
      await expectLayout(page, info, "library-archive")
      await page.screenshot({ path: info.outputPath("library-archive.png"), animations: "disabled" })
      const download = page.waitForEvent("download")
      await page.getByRole("button", { name: "Export everything", exact: true }).click()
      const zip = await download
      expect(page.url()).toBe(`${server().url}/import`)
      expect(zip.suggestedFilename()).toMatch(/^Library \d{4}-\d{2}-\d{2}\.zip$/)
      expect(
        readFileSync(await zip.path())
          .subarray(0, 2)
          .toString()
      ).toBe("PK")
    })

// The file manager (spec/FILES-AND-ENVIRONMENT.md §8.1, track B1) in the browser: the workshop's
// Files tab (beside the chat at 1440, the phone's sheet at 390) browses folders with the full path,
// opens text and images, uploads files (with the batch's Keep both) and a folder, makes a folder and
// a file, refreshes when a file is added elsewhere, renames from a row's ⋯ menu, moves with Move to…,
// downloads a folder as a zip, deletes to the bin from its context menu with Undo, restores from the
// bin page; the Files page shows the folder
// tree beside the list and opens a file as a tab of its own. All against the real server and its
// file routes (`files/routes.ts`), the files seeded and checked over the same HTTP routes. Light and
// dark, layout audit under LAYOUT_AUDIT=1, screenshots under SCREENSHOT_DIR. Synthetic files only.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { expectLayout } from "./support/layoutAudit.ts"
import { filesOf, PIXEL } from "./support/files.ts"
import { openPanel } from "./support/panel.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const shots = process.env.SCREENSHOT_DIR
const audit = !!process.env.LAYOUT_AUDIT

const seed = async (page: Page, url: string) => {
  const files = filesOf(page.request, url)
  await files.clear()
  await files.put("/files/readme.txt", "A synthetic readme.")
  await files.put("/files/thesis/notes.md", "# Chapter one\n\nSynthetic notes about lighthouses.")
  await files.put("/files/thesis/figure.png", PIXEL)
  await files.put("/files/Attachments/report.pdf", "%PDF-1.4 synthetic")
  return files
}

test.describe("files", () => {
  const server = serverPerFile(withAdmin)

  for (const width of [1440, 390])
    for (const theme of ["light", "dark"] as const)
      test(`browse, open, upload, rename and delete at ${width} ${theme}`, async ({ page }, info) => {
        test.setTimeout(120_000)
        const phone = width === 390
        const workshop = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
          api.CreateWorkshop({ title: `Files ${width} ${theme}` })
        )
        await page.setViewportSize({ width, height: phone ? 844 : 900 })
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
        await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
        await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
        const files = await seed(page, server().url)
        const scope = phone ? '[role="dialog"]' : 'aside[aria-label="Chat panel"]'
        const check = async (name: string, where = scope) => {
          if (shots) {
            mkdirSync(shots, { recursive: true })
            await page.waitForTimeout(150)
            await page.screenshot({ path: resolve(shots, `files-${name}-${width}-${theme}.png`) })
          }
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
          if (audit) await expectLayout(page, info, `files-${name}-${width}-${theme}`, { scope: where })
        }

        await page.goto(`${server().url}/chats/${workshop.id}`)
        const panel = await openPanel(page, "Files")
        const list = panel.locator("[data-files-list]")
        const row = (name: string) => list.locator(`[data-file-row="${name}"]`)
        const open = (name: string) =>
          row(name).getByRole("button", { name: new RegExp(`^${name.replace(/[.()]/g, "\\$&")},`) })

        // The top of Files: folders first, with their path; Attachments is a folder like any other.
        await expect(panel.locator("[data-files-path]")).toHaveAttribute("data-files-path", "/files")
        await expect(list.locator("[data-file-row]")).toHaveText([/Attachments/, /thesis/, /readme\.txt/])
        await expect(panel.getByRole("button", { name: "Upload files" })).toHaveAccessibleDescription(
          "Uploads files from this device into “Files”. You can also drop files and folders here."
        )
        await check("top")

        // Into a folder; a text file opens in place, and Back returns to the list.
        await open("thesis").click()
        await expect(panel.locator("[data-files-path]")).toHaveAttribute("data-files-path", "/files/thesis")
        await open("notes.md").click()
        await expect(panel.locator("[data-file-open]")).toHaveAttribute("data-file-open", "/files/thesis/notes.md")
        await expect(panel.getByText("Synthetic notes about lighthouses.")).toBeVisible()
        await check("text")
        await panel.getByRole("button", { name: "Back", exact: true }).click()
        await open("figure.png").click()
        await expect(panel.locator("[data-file-open] img")).toBeVisible()
        await check("image")
        await panel.getByRole("button", { name: "Back", exact: true }).click()

        // Upload: a new file, then the same name again, kept as both.
        const input = panel.getByLabel("Files to upload")
        await input.setInputFiles({
          name: "draft.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("Synthetic draft.")
        })
        await expect(row("draft.txt")).toBeVisible()
        await input.setInputFiles({ name: "notes.md", mimeType: "text/markdown", buffer: Buffer.from("Another.") })
        const conflict = page.getByRole("dialog", { name: "A name is taken" })
        await expect(conflict).toBeVisible()
        await check("conflict", '[role="dialog"]')
        await conflict.getByRole("button", { name: "Keep both" }).click()
        await expect(row("notes (2).md")).toBeVisible()
        expect(await files.text("/files/thesis/notes (2).md")).toBe("Another.")
        expect(await files.text("/files/thesis/notes.md")).toContain("lighthouses")

        // A folder from the picker keeps its own name and subfolders.
        const local = mkdtempSync(join(tmpdir(), "files-e2e-"))
        mkdirSync(join(local, "sources", "deep"), { recursive: true })
        writeFileSync(join(local, "sources", "a.txt"), "Synthetic a.")
        writeFileSync(join(local, "sources", "deep", "b.txt"), "Synthetic b.")
        await panel.getByLabel("Folder to upload").setInputFiles(join(local, "sources"))
        await expect(row("sources")).toBeVisible()
        expect(await files.text("/files/thesis/sources/deep/b.txt")).toBe("Synthetic b.")

        // A dropped file uploads into the folder shown.
        await dropFile(page, "[data-files-browser]", "dropped.txt", "Synthetic drop.")
        await expect(row("dropped.txt")).toBeVisible()

        // New folder.
        await panel.getByRole("button", { name: "New folder" }).click()
        const name = panel.getByLabel("Name of the new folder")
        await expect(name).toHaveValue("New folder")
        await name.fill("chapters")
        await panel.getByRole("button", { name: "Make folder" }).click()
        await expect(row("chapters")).toBeVisible()
        expect(await files.has("/files/thesis/chapters")).toBe(true)
        // Its Undo takes it back.
        await page
          .locator("[data-toast]")
          .filter({ hasText: "Made the folder “chapters”" })
          .getByRole("button", { name: "Undo" })
          .click()
        await expect(row("chapters")).toHaveCount(0)
        expect(await files.has("/files/thesis/chapters")).toBe(false)

        // New file: an empty file under the name typed.
        await panel.getByRole("button", { name: "New file" }).click()
        const fileName = panel.getByLabel("Name of the new file")
        await expect(fileName).toHaveValue("Untitled.txt")
        await fileName.fill("todo.md")
        await panel.getByRole("button", { name: "Make file" }).click()
        await expect(row("todo.md")).toBeVisible()
        expect(await files.text("/files/thesis/todo.md")).toBe("")

        // Live refresh: a file added elsewhere (here over the routes, as another tab would) shows up
        // without Refresh.
        await files.put("/files/thesis/elsewhere.txt", "Synthetic, from elsewhere.")
        await expect(row("elsewhere.txt")).toBeVisible()
        // The toasts so far are dismissed, so none covers a row below.
        const shown = page.locator("[data-toast]").filter({ visible: true })
        for (let left = 8; left > 0 && (await shown.count()) > 0; left--)
          await shown
            .first()
            .getByRole("button", { name: "Dismiss" })
            .click({ timeout: 2000 })
            .catch(() => undefined)
        await expect(shown).toHaveCount(0, { timeout: 20_000 })

        // Rename from the row's ⋯ menu, every action listed there with its explanation.
        await row("draft.txt").getByRole("button", { name: "Actions for draft.txt" }).click()
        const menu = page.getByRole("menu", { name: "Actions for draft.txt" })
        await expect(menu.getByRole("menuitem")).toHaveText([
          /^Open/,
          /^Download/,
          /^Attach to message/,
          /^Copy path/,
          /^Versions…/,
          /^Rename/,
          /^Move to…/,
          /^Delete/
        ])
        await expect(menu.getByRole("menuitem").first()).toContainText("Shows the file here.")
        await check("menu", "body")
        await menu.getByRole("menuitem", { name: "Rename" }).click()
        const field = panel.getByLabel("New name for draft.txt")
        await field.fill("final.txt")
        await panel.getByRole("button", { name: "Rename", exact: true }).click()
        await expect(row("final.txt")).toBeVisible()
        await expect(row("draft.txt")).toHaveCount(0)
        expect(await files.text("/files/thesis/final.txt")).toBe("Synthetic draft.")

        // Move to…: a folder picked from the tree; Undo moves it back.
        await row("todo.md").getByRole("button", { name: "Actions for todo.md" }).click()
        await page
          .getByRole("menu", { name: "Actions for todo.md" })
          .getByRole("menuitem", { name: "Move to…" })
          .click()
        const mover = page.getByRole("dialog", { name: "Move “todo.md” to…" })
        await expect(mover.getByRole("button", { name: "Move here" })).toBeDisabled()
        await mover.getByRole("button", { name: "sources", exact: true }).click()
        await expect(mover.getByText("/files/thesis/sources", { exact: true })).toBeVisible()
        await check("move", '[role="dialog"]')
        await mover.getByRole("button", { name: "Move here" }).click()
        await expect(row("todo.md")).toHaveCount(0)
        expect(await files.has("/files/thesis/sources/todo.md")).toBe(true)
        await page
          .locator("[data-toast]")
          .filter({ hasText: "Moved “todo.md” to “sources”" })
          .getByRole("button", { name: "Undo" })
          .click()
        await expect(row("todo.md")).toBeVisible()

        // A folder downloads as one zip.
        await row("sources").getByRole("button", { name: "Actions for sources" }).click()
        const zipped = page.waitForEvent("download")
        await page
          .getByRole("menu", { name: "Actions for sources" })
          .getByRole("menuitem", { name: "Download as zip" })
          .click()
        expect((await zipped).suggestedFilename()).toBe("sources.zip")

        // Delete from the context menu (a right click; a long press on a phone): to the bin at once,
        // with Undo.
        const deleteFinal = async () => {
          if (phone) await row("final.txt").getByRole("button", { name: "Actions for final.txt" }).click()
          else await open("final.txt").click({ button: "right" })
          await page
            .getByRole("menu", { name: "Actions for final.txt" })
            .getByRole("menuitem", { name: "Delete" })
            .click()
          await expect(row("final.txt")).toHaveCount(0)
          expect(await files.has("/files/thesis/final.txt")).toBe(false)
        }
        await deleteFinal()
        const binned = page.locator("[data-toast]").filter({ hasText: "“final.txt” moved to the bin." })
        await expect(binned.getByRole("button", { name: "Open the bin" })).toBeVisible()
        await binned.getByRole("button", { name: "Undo" }).click()
        await expect(row("final.txt")).toBeVisible()
        expect(await files.text("/files/thesis/final.txt")).toBe("Synthetic draft.")
        await deleteFinal()

        // The breadcrumb goes back up.
        await panel.locator("[data-files-path]").getByRole("button", { name: "Files" }).click()
        await expect(panel.locator("[data-files-path]")).toHaveAttribute("data-files-path", "/files")
        await check("after")

        // The bin lists it; Restore puts it back, and Open it shows its folder.
        await page.goto(`${server().url}/bin`)
        const item = page.getByRole("listitem", { name: "final.txt" })
        await expect(item.getByText("File", { exact: true })).toBeVisible()
        await expect(item.getByText("/files/thesis/final.txt")).toBeVisible()
        await check("bin", "main")
        await item.getByRole("button", { name: "Restore" }).click()
        await expect(item.getByText("Restored.")).toBeVisible()
        expect(await files.text("/files/thesis/final.txt")).toBe("Synthetic draft.")
        await item.getByRole("link", { name: "Open it" }).click()
        await expect(page).toHaveURL(/\/files\?path=%2Ffiles%2Fthesis$/)

        // The Files page: the tree beside the list where there's room; a file opens as its own tab.
        await page.goto(`${server().url}/files?path=/files/thesis`)
        const page$ = page.locator("[data-files-browser]")
        await expect(page$.locator("[data-files-path]")).toHaveAttribute("data-files-path", "/files/thesis")
        await expect(page.getByRole("tree", { name: "Folders" })).toBeVisible({ visible: !phone })
        await check("page", "main")
        await page$.locator('[data-file-row="notes.md"] button').first().click()
        await expect(page).toHaveURL(/\/files\?path=%2Ffiles%2Fthesis&file=notes\.md$/)
        await expect(page.getByText("Synthetic notes about lighthouses.")).toBeVisible()
        await check("page-text", "main")
      })

  test("offers Replace when a file fits only with credit for the old file", async ({ page }) => {
    const mib = 1024 ** 2
    const password = "quota-replacement-password"
    const handle = "replacement"
    const account = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
      api.CreateUser({ handle, displayName: "Replacement", role: "user", password })
    )
    await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
      api.SetFilesQuota({ userId: account.id, quotaBytes: 24 * mib })
    )
    await apiLogin(page.request, server(), handle, password)
    const files = filesOf(page.request, server().url)
    await files.put("/files/archive.bin", Buffer.alloc(20 * mib))
    await page.goto(`${server().url}/files`)
    const browser = page.locator("[data-files-browser]")
    await expect(browser.locator("[data-files-usage]")).toHaveText(/^.+ of 24 MB used$/)
    await browser.getByLabel("Files to upload").setInputFiles({
      name: "archive.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.alloc(8 * mib, 1)
    })
    const conflict = page.getByRole("dialog", { name: "A name is taken" })
    await conflict.getByRole("button", { name: "Replace" }).click()
    await expect
      .poll(async () => (await files.list("/files")).entries.find((file) => file.name === "archive.bin")?.size)
      .toBe(8 * mib)
  })

  // The storage line on the Files page, its details and Reset, and an upload that doesn't fit.
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"] as const)
      test(`storage usage and a refused upload at ${width} ${theme}`, async ({ page }, info) => {
        const handle = `quota${width}${theme}`
        const password = "quota-password-1"
        const account = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
          api.CreateUser({ handle, displayName: "Quota", role: "user", password })
        )
        // 64 KB: a tiny quota, so a 100 KB file doesn't fit.
        await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
          api.SetFilesQuota({ userId: account.id, quotaBytes: 64 * 1024 })
        )
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
        await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
        await apiLogin(page.request, server(), handle, password)
        const files = filesOf(page.request, server().url)
        await files.put("/files/small.txt", "A synthetic note.")

        await page.goto(`${server().url}/files`)
        const browser = page.locator("[data-files-browser]")
        const line = browser.locator("[data-files-usage]")
        await expect(line).toHaveText(/^.+ of 64 KB used$/)
        await expect(line).not.toHaveAttribute("data-warn")
        if (audit) await expectLayout(page, info, `files-usage-${width}-${theme}`, { scope: "main" })
        // The line opens what makes it up, and Reset the home folder.
        await line.click()
        const details = page.locator("[data-files-usage-details]")
        await expect(details.getByText("Earlier versions")).toBeVisible()
        await expect(details.getByText("Assistant's home folder")).toBeVisible()
        await expect(page.getByText(/^Commands used .+ of internet since/)).toBeVisible()
        if (audit) await expectLayout(page, info, `files-usage-details-${width}-${theme}`)
        await page.getByRole("button", { name: "Reset the home folder" }).click()
        const confirm = page.getByRole("alertdialog")
        await expect(confirm.getByText("Reset the assistant's home folder?")).toBeVisible()
        await confirm.getByRole("button", { name: "Reset" }).click()
        await expect(confirm).toBeHidden()
        await page.keyboard.press("Escape")
        await expect(details).toBeHidden()

        await browser.getByLabel("Files to upload").setInputFiles({
          name: "big.bin",
          mimeType: "application/octet-stream",
          buffer: Buffer.alloc(100 * 1024)
        })
        await expect(browser.getByText(/^This file needs 100 KB; .+ is free\.$/)).toBeVisible()
        expect(await files.has("/files/big.bin")).toBe(false)
        if (shots) await page.screenshot({ path: resolve(shots, `files-quota-${width}-${theme}.png`) })
        if (audit) await expectLayout(page, info, `files-quota-${width}-${theme}`, { scope: "main" })

        // Near the quota the line turns to a warning, after the Refresh button.
        await files.put("/files/most.bin", Buffer.alloc(60 * 1024))
        await browser.getByRole("button", { name: "Refresh" }).click()
        await expect(line).toHaveAttribute("data-warn", "")
      })
})

/** Drops a file on the element as the browser would from outside the page. */
const dropFile = async (page: Page, selector: string, name: string, content: string) => {
  const data = await page.evaluateHandle(
    ([fileName, text]) => {
      const transfer = new DataTransfer()
      transfer.items.add(new File([text], fileName, { type: "text/plain" }))
      return transfer
    },
    [name, content] as const
  )
  for (const type of ["dragenter", "dragover", "drop"]) await page.dispatchEvent(selector, type, { dataTransfer: data })
}

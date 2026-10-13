// Importing an ST data folder by its path (ARCHITECTURE.md §13): the folder is on the
// machine the app runs on, so the page names it and the app reads it from disk. Every file
// here is made up.
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { writeStFolder } from "./support/stFiles.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)

let root = ""
test.beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "rp-st-path-"))
})
test.afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

test("import an ST folder by typing its path", async ({ page }) => {
  const st = writeStFolder(root, ["Bob - bridge", "Bob - river"])
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/import`)
  await page.getByRole("link", { name: "Import a SillyTavern folder" }).click()

  await page.getByLabel("Folder path").fill(join(root, "missing"))
  await page.getByRole("button", { name: "Look in this folder" }).click()
  await expect(page.getByText("There's no folder at that path, or it can't be read.")).toBeVisible()

  await page.getByLabel("Folder path").fill(st)
  await page.getByRole("button", { name: "Look in this folder" }).click()
  await expect(page.getByText("3 files to import")).toBeVisible()
  await page.getByRole("button", { name: "Import", exact: true }).click()

  const imported = page.getByRole("list", { name: "Imported" })
  await expect(imported).toContainText("Cards: 1 added")
  await expect(imported).toContainText("Chats: 2 added")
  await expect(page.getByRole("list", { name: "Hidden runs" })).toContainText("12 messages hidden")

  await page.goto(`${server().url}/chats`)
  await expect(page.getByRole("link", { name: "Bob - bridge" })).toBeVisible()
  await expect(page.getByRole("link", { name: "Bob - river" })).toBeVisible()
})

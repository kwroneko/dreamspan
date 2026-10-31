// Importing an ST data folder by its path (ARCHITECTURE.md §13): the folder is on the
// machine the app runs on, so the page names it and the app reads it from disk. Every file
// here is made up.
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
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

/** At phone and desktop width: nothing scrolls sideways, and with SCREENSHOT_DIR set, saved there. */
const shoot = async (page: Page, name: string) => {
  for (const [width, device] of [
    [390, "phone"],
    [1280, "desktop"]
  ] as const) {
    await page.setViewportSize({ width, height: 844 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
    const dir = process.env.SCREENSHOT_DIR
    if (dir) await page.screenshot({ path: join(dir, `st-import-path-${name}-${device}.png`), fullPage: true })
  }
}

test("import an ST folder by browsing to it or typing its path", async ({ page }) => {
  const st = writeStFolder(root, ["Bob - bridge", "Bob - river"])
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/import`)
  // The ST folder is the import page's first card.
  await page.getByRole("link", { name: "Choose the folder" }).click()

  await page.getByLabel("Folder path").fill(join(root, "missing"))
  await page.getByRole("button", { name: "Look in this folder" }).click()
  await expect(page.getByText("There's no folder at that path, or it can't be read.")).toBeVisible()

  // Browse to it: the folder browser fills the field as folders are opened.
  await page.getByLabel("Folder path").fill(root)
  await page.getByRole("button", { name: "Look in this folder" }).click()
  // ST's folder is found inside the one looked in.
  await expect(page.getByText("3 files (")).toBeVisible()
  const folders = page.getByRole("navigation", { name: "Folders" })
  await folders.getByRole("button", { name: "ST", exact: true }).click()
  await expect(page.getByLabel("Folder path")).toHaveValue(st)
  // What was found in the other folder is gone.
  await expect(page.getByText("3 files (")).toHaveCount(0)
  // ST's data folder is marked.
  await folders.getByRole("button", { name: "data SillyTavern" }).click()
  await expect(page.getByLabel("Folder path")).toHaveValue(join(st, "data"))
  await shoot(page, "browsing")
  await page.getByRole("button", { name: "Look in this folder" }).click()
  await expect(page.getByText("3 files (")).toBeVisible()
  await page.getByRole("button", { name: "Import", exact: true }).click()

  const imported = page.getByRole("list", { name: "Imported" })
  await expect(imported).toContainText("Cards: 1 added")
  await expect(imported).toContainText("Chats: 2 added")
  await expect(page.getByRole("list", { name: "Hidden runs" })).toContainText("12 messages hidden")

  // The report ends with where to go next.
  await expect(page.getByRole("link", { name: "Open your characters" })).toBeVisible()
  await expect(page.getByRole("link", { name: /^Continue your latest chat/ })).toBeVisible()

  // Coming back starts at the folder last looked in, and a re-scan says it's all here.
  await page.goto(`${server().url}/`)
  await page.goto(`${server().url}/import/st`)
  await expect(page.getByLabel("Folder path")).toHaveValue(join(st, "data"))
  await expect(
    page.getByRole("navigation", { name: "Folders" }).getByRole("button", { name: "default-user SillyTavern" })
  ).toBeVisible()
  await page.getByRole("button", { name: "Look in this folder" }).click()
  const preview = page.getByRole("table", { name: "What's in the folder" })
  await expect(preview.getByRole("row", { name: /^Cards/ })).toHaveText(/Cards\s*1\s*0\s*1/)
  await expect(preview.getByRole("row", { name: /^Chats/ })).toHaveText(/Chats\s*2\s*0\s*2/)
  await expect(page.getByText("Everything here is already imported.", { exact: false })).toBeVisible()
  await shoot(page, "rescan")

  await page.goto(`${server().url}/chats`)
  await expect(page.getByRole("link", { name: "Bob - bridge" })).toBeVisible()
  await expect(page.getByRole("link", { name: "Bob - river" })).toBeVisible()
})

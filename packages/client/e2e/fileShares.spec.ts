// Sharing a folder and a file's versions (spec/FILES-AND-ENVIRONMENT.md §1.3, §1.4, track B3) in
// the browser against the real server: the owner shares a folder from its row menu with an account
// by name, Can view, and the row says Shared; the other account, in its own browser, finds it under
// Shared/<owner>/<folder>, opens a file, and can change nothing; Can edit lets it save. The owner's
// Versions dialog lists the earlier content with who replaced it, and Restore puts it back with
// Undo in the toast. Layout audit at 1440 and 390, light and dark. Synthetic files only.
import { expect, type Page, test } from "@playwright/test"
import { expectLayout } from "./support/layoutAudit.ts"
import { filesOf } from "./support/files.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)

const audit = async (page: Page, info: Parameters<typeof expectLayout>[1], name: string, scope: string) => {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  if (!process.env.LAYOUT_AUDIT) return
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme })
    await expectLayout(page, info, `${name}-${colorScheme}`, { scope })
  }
  await page.emulateMedia({ colorScheme: "light" })
}

for (const width of [1440, 390])
  test(`sharing a folder and a file's versions at ${width}px`, async ({ page, browser }, info) => {
    test.setTimeout(180_000)
    const size = { width, height: width === 390 ? 844 : 900 }
    await page.setViewportSize(size)
    const handle = `keeper${width}`
    const password = "keeper-password-1"
    await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
      api.CreateUser({ handle, displayName: `Keeper ${width}`, role: "user", password })
    )
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const files = filesOf(page.request, server().url)
    // Each width has its own folder: the two run at once on one server.
    const name = `beacon${width}`
    await files.put(`/files/${name}/log.txt`, "First entry.")
    await files.put(`/files/${name}/log.txt`, "Second entry.")

    // Share… from the folder's row menu, by the account's name.
    await page.goto(`${server().url}/files?${new URLSearchParams({ path: "/files" })}`)
    const row = page.locator(`[data-file-row="${name}"]`)
    await row.getByRole("button", { name: `Actions for ${name}` }).click()
    await page.getByRole("menuitem", { name: "Share…" }).click()
    const dialog = page.getByRole("dialog", { name: `Share “${name}”` })
    await expect(dialog.getByText("Nobody yet.")).toBeVisible()
    await dialog.getByRole("textbox", { name: "Account name" }).fill("nobody-here")
    await dialog.getByRole("button", { name: "Share", exact: true }).click()
    await expect(dialog.getByRole("alert")).toHaveText("No other account is called “nobody-here”.")
    await dialog.getByRole("textbox", { name: "Account name" }).fill(handle)
    await dialog.getByRole("button", { name: "Share", exact: true }).click()
    const shared = dialog.locator(`[data-share-row="${handle}"]`)
    await expect(shared).toContainText(`Keeper ${width}`)
    await audit(page, info, `share-dialog-${width}`, "[role=dialog]")
    await dialog.getByRole("button", { name: "Done" }).click()
    await expect(row.getByText("Shared", { exact: true })).toBeVisible()

    // The other account, in its own browser, finds it under Shared and can only look.
    const theirs = await browser.newContext({ viewport: size })
    const other = await theirs.newPage()
    await apiLogin(other.request, server(), handle, password)
    await other.goto(`${server().url}/files?${new URLSearchParams({ path: "/files" })}`)
    await other
      .locator('[data-file-row="Shared"]')
      .getByRole("button", { name: /^Shared,/ })
      .click()
    await other
      .locator(`[data-file-row="${ADMIN.handle}"]`)
      .getByRole("button", { name: new RegExp(`^${ADMIN.handle},`) })
      .click()
    await other
      .locator(`[data-file-row="${name}"]`)
      .getByRole("button", { name: new RegExp(`^${name},`) })
      .click()
    await expect(other.getByText("Shared with you to view: you can open and download, not change.")).toBeVisible()
    await expect(other.getByRole("button", { name: "Upload files" })).toBeDisabled()
    await audit(other, info, `shared-view-${width}`, "main")
    await other.goto(
      `${server().url}/files?${new URLSearchParams({ path: `/files/Shared/${ADMIN.handle}/${name}`, file: "log.txt" })}`
    )
    const box = other.getByRole("textbox", { name: "Contents of log.txt" })
    await expect(box).toContainText("Second entry.")
    await expect(box).toHaveAttribute("aria-readonly", "true")

    // Can edit: the other account's save lands in the owner's file.
    await page.goto(`${server().url}/files?${new URLSearchParams({ path: "/files" })}`)
    await row.getByRole("button", { name: `Actions for ${name}` }).click()
    await page.getByRole("menuitem", { name: "Share…" }).click()
    await shared.getByRole("button", { name: "Can edit" }).click()
    await expect(shared.getByRole("button", { name: "Can edit" })).toHaveAttribute("aria-pressed", "true")
    await dialog.getByRole("button", { name: "Done" }).click()
    const theirFiles = filesOf(other.request, server().url)
    await theirFiles.put(`/files/Shared/${ADMIN.handle}/${name}/log.txt`, "Third entry, by the keeper.")
    expect(await files.text(`/files/${name}/log.txt`)).toBe("Third entry, by the keeper.")
    await theirs.close()

    // Versions: newest first, who replaced it named; Restore puts it back, Undo in the toast.
    await page.goto(`${server().url}/files?${new URLSearchParams({ path: `/files/${name}`, file: "log.txt" })}`)
    await page.getByRole("button", { name: "Versions", exact: true }).click()
    const versions = page.getByRole("dialog", { name: "Versions of “log.txt”" })
    const listed = versions.locator("[data-file-version]")
    await expect(listed).toHaveCount(2)
    await expect(listed.first()).toContainText(`Before an upload by Keeper ${width}`)
    await expect(listed.nth(1)).toContainText("Before an upload")
    await audit(page, info, `file-versions-${width}`, "[role=dialog]")
    await listed.nth(1).getByRole("button", { name: "Restore" }).click()
    await expect(page.getByText(/^Restored “log\.txt” from /)).toBeVisible()
    await expect.poll(() => files.text(`/files/${name}/log.txt`)).toBe("First entry.")
    await expect(listed).toHaveCount(3)
    await expect(listed.first()).toContainText("Before a restore")
    await page.getByRole("button", { name: "Undo" }).click()
    await expect.poll(() => files.text(`/files/${name}/log.txt`)).toBe("Third entry, by the keeper.")
  })

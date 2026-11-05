// A chat's branches from the left panel (owner, 2026-11-01): each chat once, "⑂ 3" at its
// row's end listing its branches in the panel, the open chat's branches at the panel's foot,
// and every branch named the same way there and in the header's Branch ▾: by where it splits
// off (time first), never by an ST file's name. Imported from a synthetic ST folder: a group
// whose `chat_id` names its first branch, a solo card whose `chat` does too, though the second
// branch of each has the latest message. With BRANCH_LIST_SHOTS set, screenshots go there.
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { writeStBranchFamilies } from "./support/stFiles.ts"

const server = serverPerFile(withAdmin)
// Dates as the owner reads them: day before month, a 24-hour clock.
test.use({ locale: "en-GB", timezoneId: "UTC" })

let root = ""
test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "rp-branch-list-"))
  const st = writeStBranchFamilies(root)
  await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const { importId } = yield* api.StartStPathImport({ path: join(st, "data", "default-user"), prefix: "" })
      for (let i = 0; i < 600; i++) {
        const detail = yield* api.GetStImport({ importId })
        if (detail.job.status !== "running") return
        yield* Effect.sleep(50)
      }
      throw new Error("the import didn't finish")
    })
  )
})
test.afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const shot = async (page: Page, name: string, width: number) => {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
  const dir = process.env.BRANCH_LIST_SHOTS
  if (dir) await page.screenshot({ path: join(dir, `${name}-${width}.png`) })
}

for (const width of [1440, 390]) {
  test(`chat rows list their branches, and the open chat's branches sit at the panel's foot at ${width}`, async ({
    page
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/`)
    const phone = width === 390
    const openLeft = async () => {
      if (phone) await page.getByRole("button", { name: "Chats and menu" }).click()
    }
    // On a phone the panel is a sheet over the page.
    const panel = () => (phone ? page : page.getByRole("complementary").first())
    await openLeft()
    const chats = panel().getByRole("region", { name: "Chats", exact: true })
    // Each chat once, named by its group or card, never by a branch file; its branches counted.
    const group = chats.getByRole("button", { name: "Open chat Mika and Kuro", exact: true })
    await expect(group).toBeVisible()
    await expect(chats.getByText(/Branch #4/)).toHaveCount(0)
    const count = chats.getByRole("button", { name: "3 branches of Mika and Kuro: list them", exact: true })
    await expect(count).toHaveText("3")
    await shot(page, "all-chats", width)

    // "⑂ 3" lists the chat's branches in the panel, opening nothing.
    const path = new URL(page.url()).pathname
    await count.click()
    expect(new URL(page.url()).pathname).toBe(path)
    const crumbs = panel().getByRole("navigation", { name: "Chat breadcrumbs" })
    await expect(crumbs).toContainText("All chats")
    await expect(crumbs).toContainText("Mika and Kuro")
    const rows = panel().getByRole("button", { name: /^Open branch / })
    await expect(rows).toHaveCount(3)
    // By last message, newest first: the second branch, the first, then the main chat.
    await expect(rows.nth(0)).toHaveAccessibleName(/^Open branch Split 13 Jan 2025.* at #4$/)
    await expect(rows.nth(1)).toHaveAccessibleName(/^Open branch Split 12 Jan 2025.* at #4$/)
    await expect(rows.nth(2)).toHaveAccessibleName("Open branch Original")
    // The chat opens on the branch ST last had open, marked as such, though another is newer.
    await expect(rows.nth(1).locator("../..")).toContainText("opens here")
    await expect(rows.nth(0).locator("../..")).not.toContainText("opens here")
    await expect(rows.nth(1)).toContainText("Last message 12 Jan 2025")
    await expect(rows.nth(1)).toContainText("Group: they head home.")
    await shot(page, "branches", width)

    // A branch opens in the middle; the panel stays on the branches, the one shown marked.
    await rows.nth(0).click()
    await expect(page.getByRole("main").getByText("Group: the second branch crosses over.")).toBeVisible()
    await openLeft()
    await expect(panel().getByRole("button", { name: /^Open branch Split 13 Jan/ })).toHaveAttribute(
      "aria-current",
      "page"
    )
    // The header names it the same way.
    const header = page.getByRole("button", { name: /switch branch/ })
    await expect(header).toHaveAccessibleName(/^Branch: Split 13 Jan 2025.* at #4, 1 of 3, not the one/)
    await shot(page, "branch-shown", width)

    // Back to all chats: the open chat's branches at the foot, switching without leaving the list.
    await panel()
      .getByRole("navigation", { name: "Chat breadcrumbs" })
      .getByRole("button", { name: "All chats" })
      .click()
    const foot = panel().getByRole("region", { name: "Branches of the open chat" })
    await expect(foot).toBeVisible()
    await expect(foot.getByRole("button", { name: /^Open branch / })).toHaveCount(3)
    await shot(page, "foot", width)
    await foot.getByRole("button", { name: "Open branch Original", exact: true }).click()
    await expect(page.getByRole("main").getByText("Group: the main line goes on.")).toBeVisible()
    await openLeft()
    await expect(panel().getByRole("navigation", { name: "Chat breadcrumbs" })).toHaveCount(0)
    const toggle = panel()
      .getByRole("region", { name: "Branches of the open chat" })
      .getByRole("button", { name: /^Branches of Mika and Kuro/ })
    await expect(toggle).toHaveAttribute("aria-expanded", "true")
    await toggle.click()
    await expect(toggle).toHaveAttribute("aria-expanded", "false")
    // Remembered on this device.
    await page.reload()
    await openLeft()
    await expect(
      panel()
        .getByRole("region", { name: "Branches of the open chat" })
        .getByRole("button", { name: /^Branches of Mika and Kuro/ })
    ).toHaveAttribute("aria-expanded", "false")
    await panel()
      .getByRole("region", { name: "Branches of the open chat" })
      .getByRole("button", { name: /^Branches of Mika and Kuro/ })
      .click()
    // Its header lists them as the panel's list.
    await panel().getByRole("button", { name: "List these branches in the panel", exact: true }).click()
    await expect(panel().getByRole("navigation", { name: "Chat breadcrumbs" })).toContainText("Mika and Kuro")
    await expect(panel().getByRole("region", { name: "Branches of the open chat" })).toHaveCount(0)
  })

  test(`a solo chat opens where ST had it open, and the Branch menu names its branches at ${width}`, async ({
    page
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/`)
    if (width === 390) await page.getByRole("button", { name: "Chats and menu" }).click()
    const panel = width === 390 ? page : page.getByRole("complementary").first()
    await panel.getByRole("button", { name: "Open chat Bob", exact: true }).click()
    // The card's `chat` names the first branch: the chat opens on it.
    await expect(page.getByRole("main").getByText("Solo: they head home.")).toBeVisible()
    const header = page.getByRole("button", { name: /switch branch/ })
    await expect(header).toHaveAccessibleName(/^Branch: Split 12 Jan 2025.* at #4, 2 of 3: switch branch$/)
    await header.click()
    const list = page.getByRole("list", { name: "Branches" })
    await expect(list.getByRole("listitem")).toHaveCount(3)
    await expect(list.getByRole("listitem").nth(1)).toContainText("opens here")
    await expect(list.getByText(/Branch #4/)).toHaveCount(0)
    await shot(page, "branch-menu", width)
  })
}

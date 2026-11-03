// An ST import's report and what it leads to (importreport, 2026-11-02): the same warning on
// many chats said once, with every chat listed and linked, a rarer one above it; the latest
// chat named by its cast and its start, not an old ST file stamp; and a group's reply strategy
// in the Cast tab, chosen there. Every file here is made up.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { openPanel } from "./support/panel.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { writeStReportFolder } from "./support/stFiles.ts"

const server = serverPerFile(withAdmin)
test.setTimeout(240_000)

let root = ""
test.beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "rp-st-report-"))
})
test.afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

/** At 1440 and 390 px, light and dark: nothing scrolls sideways; with SCREENSHOT_DIR set, saved there. */
const shoot = async (page: Page, name: string, ready: () => Promise<void> = async () => {}) => {
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"] as const) {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.evaluate((value) => localStorage.setItem("rp.theme", value), theme)
      await page.reload()
      await ready()
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
      const dir = process.env.SCREENSHOT_DIR
      if (dir) {
        mkdirSync(dir, { recursive: true })
        await page.screenshot({ path: join(dir, `${name}-${width}-${theme}.png`), fullPage: true })
      }
    }
  await page.setViewportSize({ width: 1440, height: 900 })
}

test("the report says a repeated warning once, lists and links every chat, and the group's reply order comes in", async ({
  page
}) => {
  const st = writeStReportFolder(root)
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/import/st`)
  await page.getByLabel("Folder path").fill(join(st, "data", "default-user"))
  await page.getByRole("button", { name: "Look in this folder" }).click()
  await page.getByRole("button", { name: "Import", exact: true }).click()
  await expect(page.getByRole("list", { name: "Imported" })).toContainText("Chats:")

  const attention = page.getByRole("list", { name: "Warnings and errors" })
  const entries = attention.locator(":scope > li")
  // Two entries: the one-off first, then the warning on Dax's twelve chats, said once.
  await expect(entries).toHaveCount(2)
  await expect(entries.nth(0)).toContainText("Gone Book")
  const riders = entries.nth(1)
  await expect(riders).toContainText("12 chats")
  await expect(riders.getByText(/^ST put a persona's description/)).toHaveCount(1)
  await expect(page.getByText(/aren't listed/)).toHaveCount(0)
  // Every chat is there, each with what rode on its note, and each a link to it.
  await riders.locator("summary").click()
  const listed = riders.getByRole("list", { name: /^Files:/ })
  await expect(listed.getByRole("link")).toHaveCount(12)
  await expect(listed).toContainText(
    "Dax's own author's note. This chat's note: depth 2 as system; the default's: depth 4 as system."
  )
  await shoot(page, "st-import-report", async () => {
    await expect(entries).toHaveCount(2)
    await riders.locator("summary").click()
    await expect(listed.getByRole("link")).toHaveCount(12)
  })

  // Still open from the last screenshot.
  await listed.getByRole("link", { name: "chats/Dax/Dax - 7.jsonl" }).click()
  await expect(page).toHaveURL(/\/chats\//)
  await expect(page.getByText("Dax's turn 0.").first()).toBeVisible()

  // The group's chat replies in list order, as ST's group did; the Cast tab says so and changes it.
  const group = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api
      .ListChats({ limit: 50, before: null })
      .pipe(Effect.map((chats) => chats.find((c) => c.title.startsWith("Both"))!))
  )
  await page.goto(`${server().url}/chats/${group.id}`)
  const cast = await openPanel(page, "Cast")
  const order = cast.getByRole("combobox", { name: "Who replies" })
  await expect(order).toHaveText(/List order/)
  await order.click()
  const options = page.getByRole("option")
  await expect(options).toHaveText([/Natural order/, /List order/, /Pooled order/, /Manual/])
  // Each says what it means beside it.
  const manual = options.filter({ hasText: "Manual" })
  await expect(manual).toHaveAccessibleDescription(/^No one replies to what you send unless you pick them/)
  await manual.hover()
  await expect(page.locator("[data-explanation]")).toHaveText(/^No one replies to what you send/)
  await options.filter({ hasText: "Pooled order" }).click()
  await expect(order).toHaveText(/Pooled order/)
  await page.reload()
  const again = await openPanel(page, "Cast")
  await expect(again.getByRole("combobox", { name: "Who replies" })).toHaveText(/Pooled order/)
  await shoot(page, "cast-reply-order", async () => {
    const tab = await openPanel(page, "Cast")
    await expect(tab.getByRole("combobox", { name: "Who replies" })).toHaveText(/Pooled order/)
  })
})

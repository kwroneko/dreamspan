// The result flow uses only synthetic ST files, including a missing character and a broken preset.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { writeStReportFolder } from "./support/stFiles.ts"
import { expectLayout } from "./support/layoutAudit.ts"

const server = serverPerFile(withAdmin)
test.setTimeout(120_000)

for (const width of [1440, 390]) {
  test(`result, decisions, grouped log, history and collapsed form (${width}px)`, async ({ page, context }, info) => {
    const root = mkdtempSync(join(tmpdir(), "rp-import-result-"))
    try {
      const st = writeStReportFolder(root)
      const user = join(st, "data/default-user")
      mkdirSync(join(user, "chats/undefined"), { recursive: true })
      writeFileSync(
        join(user, `chats/undefined/Lost-${width}.jsonl`),
        [
          { chat_metadata: {} },
          { name: "Unknown", is_user: false, mes: "A stranger waves.", send_date: "2025-02-01T10:00:00Z" },
          { name: "Sam", is_user: true, mes: "Hello.", send_date: "2025-02-01T10:01:00Z" }
        ]
          .map((line) => JSON.stringify(line))
          .join("\n")
      )
      mkdirSync(join(user, "OpenAI Settings"), { recursive: true })
      writeFileSync(join(user, "OpenAI Settings/Broken.json"), "{broken")
      await page.setViewportSize({ width, height: 900 })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      // Each viewport starts with no history; old imported content can stay in the library.
      await asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.ClearStImports({ importId: null }))
      await page.goto(`${server().url}/import/st`)
      await expect(page.getByLabel("Folder path")).toBeVisible()
      await page.getByLabel("Folder path").fill(user)
      await page.getByRole("button", { name: "Look in this folder" }).click()
      await page.getByRole("button", { name: "Import", exact: true }).click()
      await expect(page.getByRole("heading", { name: "Needs your action (1)" })).toBeVisible()
      const result = page.getByRole("heading", { name: "Result", exact: true }).locator("xpath=ancestor::section[1]")
      await expect(result).toContainText("Finished")
      await expect(page.locator("main h2")).toHaveText([
        "Result",
        "Needs your action (1)",
        "Warnings and errors",
        "History",
        "Start another import"
      ])
      await expect(page.getByLabel("Folder path")).toHaveCount(0)
      await expect(page.getByRole("button", { name: "Clear finished imports" })).toHaveCount(1)
      await expect(page.getByRole("button", { name: "Remove from the list" })).toHaveCount(0)
      await expect(page.getByRole("list", { name: "History", exact: true }).locator(":scope > li")).toHaveCount(1)
      const log = page.getByRole("list", { name: "Warnings and errors", exact: true })
      const groups = log.locator(":scope > li")
      await expect(groups.first()).toHaveAttribute("aria-label", /^error:/)
      await expect(groups).toHaveCount(3)
      const repeated = groups.filter({ hasText: "ST put a persona's description" })
      await expect(repeated).toContainText("12 chats")
      await repeated.locator("summary").click()
      await expect(repeated.getByRole("link")).toHaveCount(12)
      await expect(result).toContainText("Warnings: 13")
      await expect(result).toContainText("Errors: 1")

      await expectLayout(page, info, `import-log-expanded-${width}`)
      await repeated.locator("summary").click()
      await page.getByRole("main").evaluate((el) => {
        el.scrollTop = 0
      })
      const dir = process.env.SCREENSHOT_DIR
      if (dir) {
        mkdirSync(dir, { recursive: true })
        await page.screenshot({ path: join(dir, `result-${width}.png`), fullPage: true })
      }
      await context.grantPermissions(["clipboard-read", "clipboard-write"])
      await page.getByRole("button", { name: "Copy log" }).click()
      const copied = await page.evaluate(() => navigator.clipboard.readText())
      expect(copied).toContain("Broken.json")
      expect(copied).toContain("Gone Book")
      expect(copied).toContain(`chats/undefined/Lost-${width}.jsonl`)
      expect(copied).toContain("chats/Dax/Dax - 12.jsonl")
      expect(copied.indexOf("error:")).toBeLessThan(copied.indexOf("warning:"))

      await expectLayout(page, info, `import-result-${width}`)
      const choices = page.getByRole("list", { name: "Chats to link" })
      await expect(choices).toContainText(`Chat “Lost-${width}” was saved without a character.`)
      await choices.getByRole("combobox").click()
      await page.getByRole("option", { name: "Cleo", exact: true }).click()
      await choices.getByRole("button", { name: "Import with this card" }).click()
      await expect(page.getByRole("heading", { name: /^Needs your action/ })).toHaveCount(0)
      await page.goto(`${server().url}/import/st`)
      await expect(page.getByRole("heading", { name: "Warnings and errors", exact: true })).toBeVisible()
      await expect(page.getByLabel("Folder path")).toHaveCount(0)
      const again = page.getByRole("button", { name: "Import ST data again" })
      await again.scrollIntoViewIfNeeded()
      const before = await again.boundingBox()
      await again.click()
      await expect(again).toHaveAttribute("aria-pressed", "true")
      expect((await again.boundingBox())?.y).toBe(before?.y)
      await expect(page.getByLabel("Folder path")).toBeVisible()
      await page.getByLabel("Folder path").scrollIntoViewIfNeeded()
      if (dir) await page.screenshot({ path: join(dir, `form-${width}.png`), fullPage: true })
      await expectLayout(page, info, `import-form-${width}`)
      await page.getByRole("button", { name: "Close import form" }).click()
      await expect(page.getByLabel("Folder path")).toHaveCount(0)
      // A second job proves history navigation and per-row removal do not clear its neighbour.
      const second = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        api.StartStImport({ unsupported: [], source: "Second", files: 0, bytes: 0 })
      )
      await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        api.FinishStImport({ importId: second.importId, notSent: [] })
      )
      await page.reload()
      const history = page.getByRole("list", { name: "History", exact: true })
      await expect(history.locator(":scope > li")).toHaveCount(2)
      await history.getByRole("link").last().click()
      await expect(page.getByRole("list", { name: "Warnings and errors", exact: true })).toBeVisible()
      await history.locator(":scope > li").last().getByRole("button").click()
      await page.getByRole("menuitem", { name: "Remove from history" }).click()
      await expect(history.locator(":scope > li")).toHaveCount(1)
      await page.getByRole("button", { name: "Clear finished imports" }).click()
      await expect(history).toHaveCount(0)
      await expect(page.getByLabel("Folder path")).toBeVisible()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
}

test("a running import shows live progress and can be cancelled", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const job = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.StartStImport({ unsupported: [], source: "Synthetic running import", files: 2, bytes: 100 })
  )
  await page.goto(`${server().url}/import/st`)
  const result = page.getByRole("heading", { name: "Result", exact: true }).locator("xpath=ancestor::section[1]")
  await expect(result).toContainText("0 of 2 files · 0%")
  // Observe the running clock before a later upload: startup progress updates are coalesced.
  await expect(result.getByRole("status")).toContainText(/· (?:(?:[2-9]|\d{2,}) s|\d+ min)/)
  const sent = await page.request.post(
    `${server().url}/st-import/file?${new URLSearchParams({ import: job.importId, path: "settings.json" })}`,
    {
      headers: { origin: server().url, "content-type": "application/octet-stream" },
      data: "{}"
    }
  )
  expect(sent.ok()).toBe(true)
  await expect(result).toContainText("1 of 2 files")
  await page.getByRole("button", { name: "Cancel import", exact: true }).click()
  await expect(result).toContainText("Cancelled")
  await expect(page.getByRole("button", { name: "Cancel import", exact: true })).toHaveCount(0)
  await page.goto(`${server().url}/import/st?job=${job.importId}`)
  await expect(result).toContainText("Cancelled")
})

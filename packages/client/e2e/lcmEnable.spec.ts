// Enabling summaries on an imported chat (DESIGN §8.1, spec/LCM.md §2.7, §2.11) in the browser,
// against the production server and a fake provider: a synthetic ST folder is imported through
// the folder picker, and the enable dialog offers keeping ST's summary or starting over with
// the estimate shown first; nothing is asked of the model until "Summarize now".
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { type FakeProvider, startProvider } from "./support/provider.ts"
import { loginCookie, withCookie } from "./support/rpc.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { ADMIN, serverPerFile, withAdmin } from "./support/server.ts"
import { fixtureSql } from "../../server/test/support/lcmFixtures.ts"
import { IMPORTED_SUMMARY, writeStFolder } from "./support/stFiles.ts"
import { closePanel, openPanel } from "./support/panel.ts"

const server = serverPerFile(withAdmin)
// One server holds the imported chats, so the tests run in order in one worker.
test.describe.configure({ mode: "serial" })
let provider: FakeProvider
let cookie: string
let root = ""

const CHATS = ["Bob - desktop", "Bob - phone", "Bob - scratch", "Bob - approval"]

test.beforeAll(async () => {
  provider = await startProvider()
  root = mkdtempSync(join(tmpdir(), "rp-lcm-enable-"))
  writeStFolder(root, CHATS)
  cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
  await withCookie(server(), cookie, (api) =>
    Effect.gen(function* () {
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: "Local model server",
          baseUrl: provider.baseUrl,
          compat: {},
          cacheTtlS: 300,
          maxConcurrent: null,
          presetOverrideRefId: null
        },
        apiKey: "sk-lcm-enable-key-0042"
      })
      // Small, as its name says: the window these chats outgrow (no longer a silent 8,192 default).
      const model = yield* api.AddUserModel({
        connectionId: connection.id,
        key: "fake-small",
        overrides: { context: 8192 }
      })
      yield* api.SetGenerationDefaults({
        defaults: { model: { connection: connection.id, model: model.id }, preset: null }
      })
    })
  )
})
test.afterAll(async () => {
  await provider.stop()
  rmSync(root, { recursive: true, force: true })
})

const signIn = async (page: Page) => {
  const [name, ...value] = cookie.split("=")
  await page.context().addCookies([{ name: name!, value: value.join("="), url: server().url }])
}

test("import the folder", async ({ page }) => {
  await signIn(page)
  await page.goto(`${server().url}/import/st`)
  await page.getByLabel("Choose the folder").setInputFiles(join(root, "ST"))
  await page.getByRole("button", { name: "Import", exact: true }).click()
  await expect(page.getByRole("list", { name: "Imported" })).toContainText("Chats: 4")
})

const openChat = async (page: Page, title: string) => {
  await signIn(page)
  await page.goto(`${server().url}/chats`)
  // A row's link reads its name, then when it was last used and what was said last.
  await page.getByRole("main").getByRole("list", { name: "Chats" }).getByRole("link", { name: title }).click()
  await expect(page.getByRole("heading", { name: title })).toBeVisible()
}

const noSideways = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)

for (const [name, viewport, chat] of [
  ["desktop", { width: 1440, height: 900 }, "Bob - desktop"],
  ["phone", { width: 390, height: 844 }, "Bob - phone"]
] as const) {
  test.describe(name, () => {
    test.use({ viewport })

    test("keeping the imported summary shows the estimate first, spends nothing, and Summarize now backfills", async ({
      page
    }) => {
      if (process.env.STABLE_BUTTONS_AUDIT) test.setTimeout(180_000)
      const before = provider.completions.length
      await openChat(page, chat)
      // Summaries are off for an imported chat, and turning them on is one click away, on one line.
      const off = page.getByRole("status").filter({ hasText: "summaries are off" })
      await expect(off).toBeVisible()
      const label = await off
        .locator("span")
        .first()
        .evaluate((span) => ({
          height: span.getBoundingClientRect().height,
          line: Number.parseFloat(getComputedStyle(span).lineHeight),
          cut: span.scrollWidth > span.clientWidth
        }))
      // One line, and the words shown fit it whole.
      expect(label.height).toBeLessThanOrEqual(label.line + 1)
      expect(label.cut).toBe(false)
      await page.getByRole("button", { name: "Enable summaries", exact: true }).click()

      const dialog = page.getByRole("dialog", { name: "Summarize older messages" })
      await expect(dialog.getByText(IMPORTED_SUMMARY)).toBeVisible()
      const keep = dialog.getByRole("radio", { name: /^Keep the imported summary/ })
      await expect(dialog.getByText(/It stands in for messages 1–12/)).toBeVisible()
      await expect(keep).toBeChecked()
      const estimate = dialog.getByRole("group", { name: "Estimate" })
      await expect(estimate).toContainText("Requests")
      await expect(estimate).toContainText("Tokens sent")
      await expect(estimate).toContainText("It pauses at 150% of this")
      const kept = await estimate.innerText()
      await noSideways(page)

      // Starting over means more to summarize than keeping the summary.
      await dialog.getByRole("radio", { name: "Summarize from scratch" }).click()
      await expect(estimate).not.toHaveText(kept)
      await keep.click()
      await expect(keep).toBeChecked()

      await dialog.getByRole("button", { name: "Enable summaries" }).click()
      await expect(dialog).toHaveCount(0)
      // The summary stands in for the run: one summary, and nothing has been asked of the model.
      expect(provider.completions.length).toBe(before)

      const summaries = await openPanel(page, "Summaries")
      await expect(summaries.getByTestId("summary-panel-heading")).toContainText("Older messages: 1 summary")
      await expect(summaries.getByText("Imported", { exact: true })).toBeVisible()
      await expect(summaries.getByText(IMPORTED_SUMMARY)).toBeVisible()
      const backfill = summaries.getByTestId("backfill")
      await expect(backfill).toHaveAttribute("data-state", "waiting")
      await expect(backfill).toContainText("Not started")
      await expect(backfill.getByTestId("backfill-spent")).toContainText("Spent 0 of")
      await noSideways(page)

      // All three controls keep their boxes through waiting, running and paused states.
      const controls = backfill.getByRole("button", { name: "Summarize now", exact: true }).locator("..")
      const boxes = () =>
        controls.evaluate((row) =>
          [...row.querySelectorAll("button")].map((button) => {
            const r = button.getBoundingClientRect(),
              p = row.getBoundingClientRect()
            return [r.x - p.x, r.y - p.y, r.width, r.height]
          })
        )
      const beforeBoxes = await boxes()
      await expect(backfill.getByRole("button", { name: "Continue", exact: true })).toBeDisabled()
      await expect(backfill.getByRole("button", { name: "Pause", exact: true })).toBeDisabled()
      provider.hold()
      await backfill.getByRole("button", { name: "Summarize now", exact: true }).click()
      await expect(backfill).toHaveAttribute("data-state", "running")
      expect(await boxes()).toEqual(beforeBoxes)
      await backfill.getByRole("button", { name: "Pause", exact: true }).click()
      await expect(backfill).toHaveAttribute("data-state", "paused")
      await expect(backfill.getByRole("button", { name: "Continue", exact: true })).toBeEnabled()
      expect(await boxes()).toEqual(beforeBoxes)
      if (process.env.STABLE_BUTTONS_AUDIT) await expectLayout(page, test.info(), `backfill-${viewport.width}`)
      await backfill.getByRole("button", { name: "Continue", exact: true }).click()
      provider.release()
      await expect(summaries.getByTestId("backfill")).toHaveCount(0, { timeout: 45_000 })
      expect(provider.completions.length).toBeGreaterThan(before)
      await expect(summaries.getByRole("list", { name: "Summaries in use" })).toBeVisible()
      // The imported summary is still there, in its own note, and the run is in the context.
      await closePanel(page)
      await expect(page.getByRole("tablist", { name: "Chat panel" })).toHaveCount(0)
    })
  })
}

test("starting over shows the run again and summarizes it with the rest", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await openChat(page, "Bob - scratch")
  const settings = await openPanel(page, "This chat")
  await settings.getByRole("switch", { name: /Summarize older messages/ }).click()
  const dialog = page.getByRole("dialog", { name: "Summarize older messages" })
  await dialog.getByRole("radio", { name: "Summarize from scratch" }).click()
  await dialog.getByRole("button", { name: "Enable summaries" }).click()
  await expect(dialog).toHaveCount(0)
  await expect(settings.getByRole("switch", { name: /Summarize older messages/ })).toBeChecked()
  // No summary stands in for anything yet, and the imported one is still in its note.
  const summaries = await openPanel(page, "Summaries")
  await expect(summaries.getByTestId("summary-panel-heading")).toContainText("none summarized yet")
  const notes = await openPanel(page, "Notes")
  await expect(notes.getByText("summary").first()).toBeVisible()
})

test("a higher estimate stays in the dialog until the new figures are confirmed", async ({ page }) => {
  const before = provider.completions.length
  const model = await withCookie(server(), cookie, (api) =>
    Effect.map(api.GetGenerationDefaults(), (d) => d.model!.model)
  )
  const price = async (rate: number) =>
    Effect.runPromise(
      fixtureSql(server().dataDir, [
        {
          sql: "UPDATE models SET upstream_json=? WHERE id=?",
          params: [JSON.stringify({ price: { input: rate, output: rate * 4, cacheRead: rate / 10 } }), model]
        }
      ])
    )
  await price(1)
  await openChat(page, "Bob - approval")
  await page.getByRole("button", { name: "Enable summaries", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Summarize older messages" })
  await dialog.getByRole("radio", { name: "Summarize from scratch" }).click()
  const cost = dialog.getByTestId("estimate-cost")
  const seen = await cost.innerText()
  await price(1000)
  await dialog.getByRole("button", { name: "Enable summaries", exact: true }).click()
  await expect(dialog.getByRole("alert")).toContainText("The estimate changed")
  await expect(cost).not.toHaveText(seen)
  await expect(dialog).toBeVisible()
  expect(provider.completions.length).toBe(before)
  await dialog.getByRole("button", { name: "Enable summaries", exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect(provider.completions.length).toBe(before)
})

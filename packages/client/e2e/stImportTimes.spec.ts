// Synthetic folder upload with real file mtimes: the picker shows ST's dates after import.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { presetChip } from "./support/strip.ts"

const server = serverPerFile(withAdmin)
const OLD = Date.UTC(2023, 1, 3, 12, 30)
const NEW = Date.UTC(2024, 5, 14, 12, 30)
let root: string

test.beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "rp-st-times-"))
  mkdirSync(join(root, "OpenAI Settings"))
  const preset = JSON.parse(
    readFileSync(new URL("../../server/test/fixtures/presets/default.json", import.meta.url), "utf8")
  )
  for (const [name, modifiedAt, temperature] of [
    ["A older", OLD, 0.5],
    ["Z newer", NEW, 0.8]
  ] as const) {
    const path = join(root, "OpenAI Settings", `${name}.json`)
    writeFileSync(path, JSON.stringify({ ...preset, temperature }))
    utimesSync(path, new Date(modifiedAt), new Date(modifiedAt))
  }
})
test.afterAll(() => rmSync(root, { recursive: true, force: true }))

for (const width of [1440, 390])
  test(`folder-uploaded presets show file dates and sort by Modified (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/import/st`)
    await expect(page.getByRole("heading", { name: "History", exact: true })).toBeVisible()
    const again = page.getByRole("button", { name: "Import ST data again" })
    if (await again.isVisible()) await again.click()
    await page.getByLabel("Choose the folder").setInputFiles(root)
    await expect(page.getByText("2 files (")).toBeVisible()
    await page.getByRole("button", { name: "Import", exact: true }).click()
    await expect(
      page.getByRole("heading", { name: "Result", exact: true }).locator("xpath=ancestor::section[1]")
    ).toContainText("Finished")

    const chatId = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
      Effect.gen(function* () {
        const card = yield* api.CreateCard({ label: `Time check ${width}`, name: "Synthetic" })
        return (yield* api.StartChat({
          cards: [card.entityId],
          persona: null,
          greeting: null,
          first: { _tag: "Send", content: "Check the imported presets.", speakerEntityId: null }
        })).chat.id
      })
    )
    await page.goto(`${server().url}/chats/${chatId}`)
    await presetChip(page).click()
    await page
      .getByRole("group", { name: "Show presets", exact: true })
      .getByRole("button", { name: "Modified", exact: true })
      .click()
    const picker = page.getByRole("radiogroup", { name: "Prompt preset", exact: true })
    await expect(picker.getByRole("radio")).toHaveText([/^Default \(built-in\)/, /^Z newer/, /^A older/])
    const newer = picker.getByRole("radio", { name: "Z newer", exact: true })
    await expect(newer).toHaveAccessibleDescription(/^edited (?!just now)/)
    await newer.hover()
    const date = await page.evaluate(
      (at) => new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(at),
      NEW
    )
    await expect(page.getByText(`Edited ${date}`, { exact: false })).toBeVisible()
    if (process.env.SCREENSHOT_DIR)
      await page.screenshot({ path: join(process.env.SCREENSHOT_DIR, `preset-import-time-${width}.png`) })
  })

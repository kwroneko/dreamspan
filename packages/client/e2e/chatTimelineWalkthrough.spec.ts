// Realistic synthetic imported histories, deliberately independent of any owner's data.
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import type { ChatId } from "@rp/shared/chat.ts"
import { writeRealisticStFolder } from "../../server/test/support/stRealistic.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { type Client, loginCookie, withCookie } from "./support/rpc.ts"
import { startProvider, type FakeProvider } from "./support/provider.ts"
import { closePanel, openPanel } from "./support/panel.ts"
import { closePortrait } from "./support/portrait.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "40" })
test.setTimeout(240_000)
let chatId: ChatId
let cookie = ""
let provider: FakeProvider
const admin = <A>(use: (api: Client) => Effect.Effect<A, unknown>) => withCookie(server(), cookie, use)

test.beforeAll(async ({ browser }) => {
  cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
  provider = await startProvider()
  const page = await browser.newPage()
  try {
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const folder = writeRealisticStFolder(join(server().dataDir, "synthetic-st"))
    await page.goto(`${server().url}/import/st`)
    await page.getByLabel("Folder path").fill(folder)
    await page.getByRole("button", { name: "Look in this folder" }).click()
    await page.getByRole("button", { name: "Import", exact: true }).click()
    await expect(page.getByRole("list", { name: "Imported" })).toBeVisible({ timeout: 180_000 })
    await page.goto(`${server().url}/chats`)
    const link = page
      .getByRole("main")
      .getByRole("link")
      .filter({ hasText: "The Lantern Inn" })
      .filter({ hasText: "380 messages" })
    chatId = (await link.getAttribute("href"))!.split("/").at(-1)! as ChatId
    await admin((api) =>
      Effect.gen(function* () {
        const connection = yield* api.CreateConnection({
          kind: "openai-chat",
          settings: {
            name: "Walkthrough model",
            baseUrl: provider.baseUrl,
            compat: {},
            cacheTtlS: 300,
            maxConcurrent: null,
            presetOverrideRefId: null
          },
          apiKey: "synthetic-walkthrough-key"
        })
        const model = yield* api.AddUserModel({ connectionId: connection.id, key: "fake-small", overrides: {} })
        yield* api.SetGenerationDefaults({
          defaults: { model: { connection: connection.id, model: model.id }, preset: null }
        })
        const chat = yield* api.GetChat({ chatId })
        const leafSlotId = chat.activeLeafSlotId!
        const offer = yield* api.GetLcmEnableOffer({ chatId, leafSlotId })
        if (!offer.adopted) return yield* Effect.die("The realistic chat must have an imported summary")
        yield* api.EnableLcm({ chatId, leafSlotId, choice: "adopt", approved: offer.adopted })
      })
    )
  } finally {
    await page.close()
  }
})
test.afterAll(async () => {
  await provider?.stop()
})

const shoot = async (page: Page, name: string) => {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
  const shapes = await page.locator("[data-portrait]").evaluateAll((nodes) =>
    nodes.flatMap((node) => {
      const box = node.getBoundingClientRect()
      return box.height > 0
        ? [
            {
              ratio: box.width / box.height,
              radius: parseFloat(getComputedStyle(node).borderTopLeftRadius),
              width: box.width
            }
          ]
        : []
    })
  )
  for (const shape of shapes) {
    expect(shape.ratio).toBeCloseTo(2 / 3, 2)
    expect(shape.radius).toBeLessThan(shape.width / 2)
  }
  if (!process.env.SCREENSHOT_DIR) return
  mkdirSync(process.env.SCREENSHOT_DIR, { recursive: true })
  await page.screenshot({ path: join(process.env.SCREENSHOT_DIR, `${name}.png`) })
}

for (const width of [1440, 390])
  for (const colorScheme of ["light", "dark"] as const) {
    test(`realistic chat walkthrough ${width} ${colorScheme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
      await page.emulateMedia({ colorScheme })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await admin((api) =>
        api.SetDisplayPrefs({ prefs: { timeline: "originals", coverageRail: false, portraitSize: "default" } })
      )
      const path = await admin((api) =>
        api.ReadPath({ chatId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 500 })
      )
      // Start at the first uncovered original so the walkthrough expands manually.
      const slot = path.entries[120]!.slotId
      const base = `${server().url}/chats/${chatId}?slot=${slot}`
      await page.goto(base)
      await expect(page.getByTestId("lcm-boundary")).toBeVisible()
      const draft = "Keep every composer action within reach."
      await page.getByLabel("Message", { exact: true }).fill(draft)
      await shoot(page, `chat-originals-${width}-${colorScheme}`)
      const toggle = page.getByTestId("messages").getByRole("switch", { name: "Summaries in chat" })
      await toggle.click()
      await expect(toggle).toBeChecked()
      const summary = page.locator("[data-timeline-summary]").first()
      await expect(summary).toContainText("Messages 1–120")
      await page.getByTestId("messages").evaluate((node) => {
        node.scrollTop = 0
      })
      await shoot(page, `chat-summaries-${width}-${colorScheme}`)
      await summary.getByRole("button", { name: "Expand messages 1–120", exact: true }).click()
      await expect(summary.locator("article")).toHaveCount(100)
      await summary.getByRole("button", { name: "Earlier messages", exact: true }).click()
      await expect(summary.locator("article")).toHaveCount(120)
      await page.getByTestId("messages").evaluate((node) => {
        node.scrollTop = 0
      })
      await shoot(page, `chat-expanded-${width}-${colorScheme}`)
      await summary.locator("article").first().scrollIntoViewIfNeeded()
      await shoot(page, `expanded-messages-${width}-${colorScheme}`)
      await page.getByTestId("messages").evaluate((node) => {
        node.scrollTop = 0
      })
      await summary.getByRole("button", { name: "Collapse messages 1–120", exact: true }).first().click()
      const panel = await openPanel(page, "Summaries")
      await expect(panel.getByRole("switch", { name: "Summaries in chat" })).toBeChecked()
      await shoot(page, `summaries-tab-${width}-${colorScheme}`)
      await closePanel(page)
      // A message portrait, never the header, is the entry point under test.
      const portrait = page.locator("article .chat-portrait").first()
      await portrait.click()
      const full = page.getByRole("img", { name: /full portrait$/ })
      await expect(full).toBeVisible()
      await shoot(page, `portrait-${width}-${colorScheme}`)
      await closePortrait(page)
      const display = await openPanel(page, "Display")
      await display.getByLabel("Message portrait size", { exact: true }).click()
      await expect(page.getByRole("option", { name: "Large (84 × 126)" })).toBeVisible()
      await shoot(page, `portrait-size-${width}-${colorScheme}`)
      await page.keyboard.press("Escape")
      await closePanel(page)
      const cast = await openPanel(page, "Cast")
      await expect(cast.getByRole("list", { name: "Characters in this chat" })).toBeVisible()
      await shoot(page, `cast-portraits-${width}-${colorScheme}`)
      await closePanel(page)
      await page.getByRole("button", { name: /Speaking as .*Change the speaker/ }).click()
      await shoot(page, `speaker-portraits-${width}-${colorScheme}`)
      await page.keyboard.press("Escape")
      await expect(page.getByLabel("Message", { exact: true })).toHaveValue(draft)
    })
  }

// Phase 1 unit 3 (DESIGN §1.3, §5.0) through the real browser on a realistic synthetic ST
// folder: the Lorebooks tab with its sections, the "only below the history" setting and its
// popover; the preset editor and the card editor saying whether a card's prompt replaces the
// preset's; the inspector of a group chat with joined definitions. With SCREENSHOT_DIR set,
// each view is captured at 1440 and 390 px, light and dark.
import { mkdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import type { ChatId, SlotId, VersionId } from "@rp/shared/chat.ts"
import type { LibraryRef } from "@rp/shared/library.ts"
import { writeRealisticStFolder } from "../../server/test/support/stRealistic.ts"
import { type FakeProvider, startProvider } from "./support/provider.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { openPanel, openPresetAt } from "./support/panel.ts"
import { saveRevision } from "./support/saveRevision.ts"

// Replies go to the synthetic provider (not the fake generator), so the inspector has a captured request.
const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
const shots = process.env.SCREENSHOT_DIR ? resolve(process.env.SCREENSHOT_DIR) : null
let provider: FakeProvider
let ariaChat: ChatId
let ariaCard: LibraryRef
let group: { chatId: ChatId; reply: VersionId; slot: SlotId }

test.describe.configure({ mode: "serial" })
test.setTimeout(300_000)

test.beforeAll(async ({ browser }) => {
  // The import, the model and a group reply take longer than a hook's default.
  test.setTimeout(300_000)
  if (shots) mkdirSync(shots, { recursive: true })
  const page = await browser.newPage()
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const folder = writeRealisticStFolder(join(server().dataDir, "synthetic-st"))
  await page.goto(`${server().url}/import/st`)
  await page.getByLabel("Folder path").fill(folder)
  await page.getByRole("button", { name: "Look in this folder" }).click()
  await page.getByRole("button", { name: "Import", exact: true }).click()
  await expect(page.getByRole("list", { name: "Imported" })).toBeVisible({ timeout: 180_000 })
  await page.close()
  provider = await startProvider()
  const preset = (await admin((api) => api.ListLibrary({ kind: "preset" }))).find((p) => p.label === "Celia 4.2")!
  const connection = await admin((api) =>
    api.CreateConnection({
      kind: "openai-chat",
      settings: {
        name: "Local model server",
        baseUrl: provider.baseUrl,
        compat: {},
        cacheTtlS: 300,
        maxConcurrent: null,
        presetOverrideRefId: null
      },
      apiKey: "sk-assembly-test-key-0042"
    })
  )
  await admin((api) => api.RefreshModels({ connectionId: connection.id }))
  const model = (await admin((api) => api.ListModels({ connectionId: connection.id, includeHidden: false }))).find(
    (m) => m.key === "fake-small"
  )!
  await admin((api) =>
    api.EditModel({
      modelId: model.id,
      overrides: {
        context: 128000,
        cacheBreakpoints: "explicit",
        settings: { samplers: { openai_max_context: 128000 } }
      },
      expectedRowVersion: model.rowVersion
    })
  )
  await admin((api) =>
    api.SetGenerationDefaults({
      defaults: { model: { connection: connection.id, model: model.id }, preset: preset.id }
    })
  )
  ariaCard = (await admin((api) => api.ListLibrary({ kind: "card" }))).find(
    (c) => c.label === "Aria Vance" && c.refKind === "upstream"
  )!
  const usage = await admin((api) => api.ListCardUsage())
  const aria = usage.find((c) => c.name === "Aria Vance")!
  const chats = await admin((api) => api.ListChats({ limit: 50, before: null, entityId: aria.entityId }))
  ariaChat = chats.find((c) => c.title.startsWith("Aria Vance"))!.id
  // A reply in the Lantern Inn, whose four characters' definitions are joined field by field.
  group = await admin((api) =>
    Effect.gen(function* () {
      const inn = (yield* api.ListChatGroups()).find((g) => g.name === "The Lantern Inn")!
      const chat = yield* api.GetChat({ chatId: inn.latestChatId })
      const reply = yield* api.Generate({
        chatId: chat.id,
        parentSlotId: chat.activeLeafSlotId as SlotId,
        branch: false
      })
      if (reply._tag !== "Posted") return yield* Effect.die(new Error("the reply was queued"))
      return { chatId: chat.id, reply: reply.entry.version.id, slot: reply.entry.slotId }
    })
  )
  // The inspector shows a reply's context once its request was sent: polled in one session.
  const status = await admin((api) =>
    Effect.gen(function* () {
      for (let i = 0; i < 120; i++) {
        const run = yield* api.GetRunContext({ versionId: group.reply }).pipe(Effect.catch(() => Effect.succeed(null)))
        if (run?.status === "completed") return run.status
        yield* Effect.sleep("500 millis")
      }
      return "not completed"
    })
  )
  expect(status).toBe("completed")
})

test.afterAll(async () => {
  await provider?.stop()
})

const setUp = async (page: Page, width: number, theme: "light" | "dark", login = true) => {
  await page.setViewportSize({ width, height: 1000 })
  await page.emulateMedia({ colorScheme: theme })
  await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
  // Logins are rate-limited: a page logs in once.
  if (login) await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  return async (name: string) => {
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
    if (shots)
      await page.screenshot({
        path: join(shots, `${name}-${width}-${theme}.png`),
        animations: "disabled",
        timeout: 60_000
      })
  }
}

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`lorebooks, overrides and joined definitions ${width} ${theme}`, async ({ page }) => {
      const shoot = await setUp(page, width, theme)
      await page.goto(`${server().url}/chats/${ariaChat}`)
      const tab = await openPanel(page, "Lorebooks")
      // Every book the chat reads, in one list; ST's global book is sent by ST's selected preset.
      const books = tab.getByRole("list", { name: "Lorebooks in this chat" })
      await expect(books).toContainText("Aria Vance's own lorebook")
      await expect(books.getByRole("switch", { name: /^Harbor Almanac/ })).toBeChecked()
      await expect(books).toContainText("From the preset Celia 4.2")
      // Where entries go: one setting for the chat's books, with its why a click away.
      const below = tab.getByRole("switch", { name: "Force all lorebook entries below the history" })
      await expect(below).toBeChecked()
      await tab.getByRole("button", { name: "Why below the history" }).click()
      const popover = page.getByRole("dialog", { name: "Below the history" })
      await expect(popover).toContainText("cache")
      await shoot("lorebooks-popover")
      await page.keyboard.press("Escape")
      await expect(popover).toHaveCount(0)
      await below.click()
      await expect(below).not.toBeChecked()
      await shoot("lorebooks-setting-off")
      await below.click()
      await expect(below).toBeChecked()
      await shoot("lorebooks-setting-on")
      // The preset editor at the Main Prompt: Aria's system prompt replaces it in this chat.
      const presetPanel = await openPanel(page, "Prompt preset")
      await openPresetAt(page, presetPanel, "Main Prompt")
      const overlay = page.getByRole("region", { name: "Preset editor", exact: true })
      const main = overlay.locator('[data-prompt="main"]')
      await expect(main).toContainText("Replaced in this chat by Aria Vance's system prompt")
      await expect(main.getByRole("link", { name: "Aria Vance" })).toBeVisible()
      await expect(overlay.locator('[data-prompt="jailbreak"]')).toContainText(
        "Replaced in this chat by Aria Vance's post-history instructions"
      )
      await main.scrollIntoViewIfNeeded()
      await shoot("preset-main-replaced")
      await overlay.getByRole("button", { name: "Close", exact: true }).click()
      // The card editor says its prompts are used.
      await page.goto(`${server().url}/library/${ariaCard.id}`)
      const note = page.locator('[data-prompt-use="replaceable"]').first()
      await expect(note).toContainText("Used in place of Celia 4.2's Main Prompt")
      await expect(page.getByText("Loading editor…")).toHaveCount(0)
      await note.scrollIntoViewIfNeeded()
      await shoot("card-editor-override")
      // The run inspector of the group chat: each character's part of the joined definitions.
      await page.goto(`${server().url}/chats/${group.chatId}/context/${group.reply}`)
      await expect(page.getByText("<Tobias Wren>").first()).toBeVisible({ timeout: 30_000 })
      await expect(page.getByText("Rook's description").first()).toBeVisible()
      await page.getByText("<Tobias Wren>").first().scrollIntoViewIfNeeded()
      await shoot("inspector-group-joined")
    })

test("a prompt that forbids overrides says so in both editors; entries by position show in the inspector", async ({
  page
}) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${ariaChat}`)
  const presetPanel = await openPanel(page, "Prompt preset")
  await openPresetAt(page, presetPanel, "Main Prompt")
  const overlay = page.getByRole("region", { name: "Preset editor", exact: true })
  // The switch is among the prompt's options, folded under its header.
  await overlay.locator('[data-prompt="main"]').getByRole("button", { name: "Options of Main Prompt" }).click()
  await overlay.locator('[data-prompt="main"]').getByRole("switch", { name: "A card can't replace it" }).click()
  await saveRevision(overlay)
  await overlay.getByRole("button", { name: "Close", exact: true }).click()
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"] as const) {
      const shoot = await setUp(page, width, theme, false)
      await page.goto(`${server().url}/chats/${ariaChat}`)
      const panel = await openPanel(page, "Prompt preset")
      await openPresetAt(page, panel, "Main Prompt")
      const main = page.getByRole("region", { name: "Preset editor", exact: true }).locator('[data-prompt="main"]')
      await expect(main).toContainText("Aria Vance has a system prompt; this prompt forbids it")
      await main.scrollIntoViewIfNeeded()
      await shoot("preset-main-forbidding")
      await page.goto(`${server().url}/library/${ariaCard.id}`)
      const note = page.locator('[data-prompt-use="forbidden"]').first()
      await expect(note).toContainText("Not used: Celia 4.2's Main Prompt can't be replaced.")
      await expect(page.getByText("Loading editor…")).toHaveCount(0)
      await note.scrollIntoViewIfNeeded()
      await shoot("card-editor-forbidden")
    }
  // Entries by position: the inspector shows them, with the cache breakpoints.
  const chat = await admin((api) => api.GetChat({ chatId: ariaChat }))
  await admin((api) =>
    api.ChangeCast({ chatId: ariaChat, slotId: chat.activeLeafSlotId, change: { _tag: "LoreBelowHistory", on: false } })
  )
  const generate = () =>
    admin((api) =>
      Effect.gen(function* () {
        const at = yield* api.GetChat({ chatId: ariaChat })
        const reply = yield* api.Generate({
          chatId: ariaChat,
          parentSlotId: at.activeLeafSlotId as SlotId,
          branch: false
        })
        if (reply._tag !== "Posted") return yield* Effect.die(new Error("the reply was queued"))
        const versionId = reply.entry.version.id
        for (let i = 0; i < 120; i++) {
          const run = yield* api.GetRunContext({ versionId }).pipe(Effect.catch(() => Effect.succeed(null)))
          if (run?.status === "completed") break
          yield* Effect.sleep("500 millis")
        }
        return versionId
      })
    )
  const first = await generate()
  await expect.poll(() => provider.completions.length, { timeout: 60_000 }).toBeGreaterThan(0)
  const before = await admin((api) => api.GetNextContext({ chatId: ariaChat, leafSlotId: null }))
  expect(before.presetContext?.cacheAfter.length).toBeGreaterThan(0)
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"] as const) {
      const shoot = await setUp(page, width, theme, false)
      await page.goto(`${server().url}/chats/${ariaChat}/context/${first}`)
      await expect(page.getByText("Breakpoints").first()).toBeVisible({ timeout: 30_000 })
      await shoot("inspector-lore-by-position")
    }
})

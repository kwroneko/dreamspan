import { replaceEditorText } from "./support/textbox.ts"
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import type { ShellLibrary } from "@dreamspan/shared/chatSetupApi.ts"
import type { LibraryRef } from "@dreamspan/shared/library.ts"
import { writeRealisticStFolder } from "../../server/test/support/stRealistic.ts"
import { type FakeProvider, startProvider } from "./support/provider.ts"
import { asUser } from "./support/rpc.ts"
import { NOTHING_TO_SAVE, UNSAVED, expectSaveState, saveRevision } from "./support/saveRevision.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { openPanel, openPresetAt } from "./support/panel.ts"
import { openNoteSettings } from "./support/notes.ts"
import { expectTextBox } from "./support/textbox.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "60" })
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
const shots = resolve(process.env.SCREENSHOT_DIR ?? join(tmpdir(), "rp-preset-screenshots"))
let library: ShellLibrary
let preset: LibraryRef
let provider: FakeProvider

test.setTimeout(240_000)
test.beforeAll(async ({ browser }) => {
  // The hook has its own timeout (the config's 60 s): importing the realistic ST folder alone
  // can take longer than that on a loaded host.
  test.setTimeout(300_000)
  mkdirSync(shots, { recursive: true })
  const page = await browser.newPage()
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const folder = writeRealisticStFolder(join(server().dataDir, "synthetic-st"))
  await page.goto(`${server().url}/import/st`)
  await page.getByLabel("Folder path").fill(folder)
  await page.getByRole("button", { name: "Look in this folder" }).click()
  await page.getByRole("button", { name: "Import", exact: true }).click()
  await expect(page.getByRole("list", { name: "Imported" })).toBeVisible({ timeout: 180_000 })
  library = await admin((api) => api.GetShellLibrary())
  preset = (await admin((api) => api.ListLibrary({ kind: "preset" }))).find((p) => p.label === "Celia 4.2")!
  expect(preset).toBeTruthy()
  // Unit I made the model and prompt preset account selections and moved the context size onto
  // the model: select Celia 4.2 and a model with the 128000-token context its ST preset had.
  provider = await startProvider()
  const connection = await admin((api) =>
    api.CreateConnection({
      kind: "openai-chat",
      settings: {
        name: "Local model server",
        baseUrl: provider.baseUrl,
        compat: {},
        cacheTtlS: null,
        maxConcurrent: null,
        presetOverrideRefId: null
      },
      apiKey: "sk-preset-test-key-0042"
    })
  )
  await admin((api) => api.RefreshModels({ connectionId: connection.id }))
  const model = (await admin((api) => api.ListModels({ connectionId: connection.id, includeHidden: false }))).find(
    (m) => m.key === "fake-small"
  )!
  await admin((api) =>
    api.EditModel({
      modelId: model.id,
      overrides: { context: 128000, settings: { samplers: { openai_max_context: 128000 } } },
      expectedRowVersion: model.rowVersion
    })
  )
  await admin((api) =>
    api.SetGenerationDefaults({
      defaults: { model: { connection: connection.id, model: model.id }, preset: preset.id }
    })
  )
  const context = await admin((api) =>
    api.GetNextContext({ chatId: library.forks.find((f) => f.current)!.chat.id, leafSlotId: null })
  )
  expect(context.budget?.maximum).toBe(128000)
  expect(context.presetContext?.blocks.length).toBeGreaterThan(0)
  await page.close()
})

test.afterAll(async () => {
  await provider?.stop()
})

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`preset document walkthrough ${width} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const fork = library.forks.find((f) => f.current && f.cast.length === 1)!
      await page.goto(`${server().url}/chats/${fork.chat.id}`)
      const composer = page.getByRole("textbox", { name: "Message", exact: true })
      await expect(composer).toBeEnabled()
      await composer.fill(`An unfinished message ${width} ${theme}`)
      const chatUrl = new URL(page.url()).pathname
      const outerScroll = await page.evaluate(() => scrollY)
      const panel = await openPanel(page, "Prompt preset")
      await expect(panel.getByRole("list", { name: "Preset blocks" })).toBeVisible()
      await expect(panel.getByRole("listitem").filter({ hasText: "Chat history" })).toContainText(/~[1-9][\d,]+ tokens/)
      const shoot = async (name: string) => {
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
        await page.screenshot({ path: join(shots, `${name}-${width}-${theme}.png`) })
      }
      await shoot("panel")
      await openPresetAt(page, panel, "Post-History Instructions")
      const overlay = page.getByRole("region", { name: "Preset editor", exact: true })
      await expect(overlay).toBeVisible()
      // The editor is a tab beside the chat, bound to it.
      await expect(page).toHaveURL(new RegExp(`/library/.*chat=${chatUrl.split("/")[2]}`))
      const focused = overlay.locator('[data-prompt="jailbreak"]')
      await expect(focused).toBeInViewport()
      expect(await page.evaluate(() => scrollY)).toBe(outerScroll)
      await shoot("focused-block")
      const scroll = overlay.getByTestId("preset-scroll")
      await scroll.evaluate((e) => {
        e.scrollTop = 0
      })
      // The search is folded away until asked for.
      await expect(overlay.getByRole("textbox", { name: "Find", exact: true })).toHaveCount(0)
      await overlay.getByRole("button", { name: "Search and replace", exact: true }).click()
      await expect(overlay.getByRole("textbox", { name: "Find", exact: true })).toBeInViewport()
      await shoot("document")
      await overlay.getByRole("button", { name: "Collapse all", exact: true }).click()
      await expect(overlay.getByRole("textbox", { name: "Prompt: Main Prompt", exact: true })).toHaveCount(0)
      await shoot("collapsed")
      await scroll.evaluate((e) => {
        e.scrollTop = e.scrollHeight / 2
      })
      await expect(overlay.getByRole("textbox", { name: "Find", exact: true })).toBeInViewport()
      await scroll.evaluate((e) => {
        e.scrollTop = 0
      })
      const find = overlay.getByRole("textbox", { name: "Find", exact: true })
      // Any macro: the group nudge's {{speaker}} stays after the light run's save removes {{char}}.
      await find.fill("{{")
      await overlay.getByRole("textbox", { name: "Replace with", exact: true }).fill("{{cast}}")
      await overlay.getByRole("button", { name: "Find", exact: true }).click()
      await expect(overlay.getByRole("list", { name: "Matches", exact: true })).toContainText("→")
      // The sticky bar, with its matches, leaves most of a phone's screen to the document.
      const sticky = await overlay
        .getByRole("region", { name: "Search and replace", exact: true })
        .evaluate((element) => {
          let at: HTMLElement | null = element as HTMLElement
          while (at && getComputedStyle(at).position !== "sticky") at = at.parentElement
          return at!.getBoundingClientRect().height
        })
      if (width < 640) {
        // The separate editing/view rows and open search leave most of the screen to the document.
        expect(sticky).toBeLessThan(page.viewportSize()!.height / 2)
        const options = overlay.getByRole("button", { name: "Options", exact: true })
        await options.click()
        await expect(overlay.getByRole("checkbox", { name: "Whole word", exact: true })).toBeVisible()
        await options.click()
      }
      await shoot("search-preview")
      await overlay.getByRole("button", { name: "Close", exact: true }).first().click()
      await expect(overlay).toHaveCount(0)
      await expectTextBox(composer, `An unfinished message ${width} ${theme}`)
      const notes = await openPanel(page, "Notes")
      // The first note, its settings opened (they fold under its text).
      const first = notes.getByRole("list", { name: "Notes", exact: true }).getByRole("region").first()
      const title = ((await first.getAttribute("aria-label")) ?? "").replace(/^Note /, "")
      await openNoteSettings(first, title)
      await first.getByRole("combobox", { name: "Position", exact: true }).click()
      await expect(page.getByRole("option", { name: "Start of context", exact: true })).toBeVisible()
      await shoot("note-positions")
      await page.keyboard.press("Escape")
      // From the library the preset opens at its own address, with no chat-specific fills.
      await page.goto(`${server().url}/library`)
      await page.getByRole("tab", { name: /^Presets/ }).click()
      await page.getByRole("link", { name: "Edit Celia 4.2", exact: true }).click()
      await expect(page).toHaveURL(`${server().url}/library/${preset.id}`)
      const editor = page.getByRole("main")
      await expect(editor).toContainText("no chat open")
      await shoot("library-document")
      await replaceEditorText(
        editor.getByRole("textbox", { name: "Prompt: Main Prompt", exact: true }),
        `Keep continuity in vivid prose ${width} ${theme}.`
      )
      await replaceEditorText(
        editor.getByRole("textbox", { name: "Prompt: Post-History Instructions", exact: true }),
        `Keep continuity ${width} ${theme}.`
      )
      await editor.getByRole("button", { name: "Search and replace", exact: true }).click()
      await editor.getByRole("textbox", { name: "Find", exact: true }).fill("continuity")
      await editor.getByRole("textbox", { name: "Replace with", exact: true }).fill("coherence")
      await editor.getByRole("button", { name: "Find", exact: true }).click()
      await editor.getByRole("button", { name: "Replace all", exact: true }).click()
      await expectTextBox(
        editor.getByRole("textbox", { name: "Prompt: Main Prompt", exact: true }),
        `Keep coherence in vivid prose ${width} ${theme}.`
      )
      await expectTextBox(
        editor.getByRole("textbox", { name: "Prompt: Post-History Instructions", exact: true }),
        `Keep coherence ${width} ${theme}.`
      )
      // Save asks nothing; History's comparison shows both prompts changed.
      await saveRevision(editor)
      await expect(page.getByRole("dialog")).toHaveCount(0)
      await shoot("saved")
      await editor.getByRole("button", { name: "History", exact: true }).first().click()
      const revisions = page.getByRole("dialog", { name: "History", exact: true })
      await revisions
        .getByRole("list", { name: "Revisions", exact: true })
        .getByRole("button", { name: /^Revision \d+ / })
        .first()
        .click()
      await expect(revisions.locator('div[aria-label="Revision changes"]:not([role="tablist"])')).toContainText(
        "Main Prompt"
      )
      await expect(revisions.locator('div[aria-label="Revision changes"]:not([role="tablist"])')).toContainText(
        "Post-History Instructions"
      )
      await revisions.locator("summary").first().click()
      await expect(revisions.locator('div[aria-label="Revision changes"]:not([role="tablist"])')).toBeVisible()
      await shoot("revisions")
    })
  }

test("a panel switch is shared with the overlay as flipped, with no unsaved bar", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${library.forks.find((f) => f.current)!.chat.id}`)
  const panel = await openPanel(page, "Prompt preset")
  const toggle = panel.getByRole("switch", { name: "Send Main Prompt", exact: true })
  const was = await toggle.isChecked()
  await toggle.click()
  await openPresetAt(page, panel, "Main Prompt")
  const overlay = page.getByRole("region", { name: "Preset editor", exact: true })
  await expect(overlay.getByRole("switch", { name: "Send Main Prompt", exact: true })).toBeChecked({ checked: !was })
  await overlay.getByRole("button", { name: "Close", exact: true }).first().click()
  // A switch is live: no bar holds it; flipping it back is the way back.
  await expect(panel.getByRole("region", { name: "Unsaved changes" })).toHaveCount(0)
  // Checkpoint this state before flipping back: a no-net edit may retain a valid active
  // draft while Save is disabled. Both saves flush their draft writes before cleanup.
  await saveRevision(panel)
  await toggle.click()
  await expect(toggle).toBeChecked({ checked: was })
  // The next tests share the preset: leave it saved.
  await saveRevision(panel)
  await expectSaveState(panel, NOTHING_TO_SAVE)
  const opened = await admin((api) =>
    Effect.map(api.OpenEditor({ refId: preset.id }), (editor) =>
      editor.drafts.filter((draft) => draft.status === "active")
    )
  )
  expect(opened).toHaveLength(0)
})

test("text typed in the overlay is live in the panel too, and the overlay's Save saves it", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${library.forks.find((f) => f.current)!.chat.id}`)
  const panel = await openPanel(page, "Prompt preset")
  await openPresetAt(page, panel, "Main Prompt")
  const overlay = page.getByRole("region", { name: "Preset editor", exact: true })
  const main = overlay.getByRole("textbox", { name: "Prompt: Main Prompt", exact: true })
  await replaceEditorText(main, "An hour of careful prompt work.")
  await expectSaveState(overlay, UNSAVED)
  await overlay.getByRole("button", { name: "Close", exact: true }).first().click()
  // No bar holds typed text; the tab's Save says there's something to save.
  const bar = panel.getByRole("region", { name: "Unsaved changes" })
  await expect(bar).toHaveCount(0)
  await expectSaveState(panel, UNSAVED)
  await openPresetAt(page, panel, "Main Prompt")
  await expectTextBox(main, "An hour of careful prompt work.")
  // The overlay's toolbar saves it, asking nothing.
  await saveRevision(overlay)
  await expectSaveState(overlay, NOTHING_TO_SAVE)
  await overlay.getByRole("button", { name: "Close", exact: true }).first().click()
  await expectSaveState(panel, NOTHING_TO_SAVE)
})

test("the panel's Revert puts back an order the overlay changed, without asking", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${library.forks.find((f) => f.current)!.chat.id}`)
  const panel = await openPanel(page, "Prompt preset")
  const names = () =>
    panel
      .getByRole("list", { name: "Preset blocks" })
      .locator("[data-prompt]")
      .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-prompt")).join("|"))
  // Read the order once the blocks and their estimates are shown, not while the panel loads.
  const blocks = panel.getByRole("list", { name: "Preset blocks" }).getByRole("listitem")
  await expect(blocks.first()).toContainText(/~[\d,]+ tokens/)
  await expect(blocks.last()).toContainText(/~[\d,]+ tokens/)
  const before = await names()
  await openPresetAt(page, panel, "Main Prompt")
  const overlay = page.getByRole("region", { name: "Preset editor", exact: true })
  await overlay.getByRole("list", { name: "Prompt order" }).getByRole("button", { name: "Move Main Prompt" }).focus()
  await page.keyboard.press("ArrowDown")
  await expect.poll(names).not.toBe(before)
  await overlay.getByRole("button", { name: "Close", exact: true }).first().click()
  const bar = panel.getByRole("region", { name: "Unsaved changes" })
  await expect(bar).toContainText("new order")
  await panel.getByRole("button", { name: "Revert", exact: true }).click()
  await expect(page.getByRole("alertdialog")).toHaveCount(0)
  await expect.poll(names).toBe(before)
  await expect(bar).toHaveCount(0)
})

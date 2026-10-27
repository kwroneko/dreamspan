import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import type { ShellLibrary } from "@rp/shared/chatSetupApi.ts"
import type { LibraryRef } from "@rp/shared/library.ts"
import { writeRealisticStFolder } from "../../server/test/support/stRealistic.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { openPanel } from "./support/panel.ts"
import { expectTextBox } from "./support/textbox.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "60" })
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
const shots = resolve(process.env.SCREENSHOT_DIR ?? join(tmpdir(), "rp-preset-screenshots"))
let library: ShellLibrary
let preset: LibraryRef

test.setTimeout(240_000)
test.beforeAll(async ({ browser }) => {
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
  const context = await admin((api) =>
    api.GetNextContext({ chatId: library.forks.find((f) => f.current)!.chat.id, leafSlotId: null })
  )
  expect(context.budget?.maximum).toBe(128000)
  expect(context.presetContext?.blocks.length).toBeGreaterThan(0)
  await page.close()
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
      const panel = await openPanel(page, "Preset")
      await expect(panel.getByRole("list", { name: "Preset blocks" })).toBeVisible()
      await expect(panel.getByRole("listitem").filter({ hasText: "Chat History" })).toContainText(/~[1-9][\d,]+ tokens/)
      const shoot = async (name: string) => {
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
        await page.screenshot({ path: join(shots, `${name}-${width}-${theme}.png`) })
      }
      await shoot("panel")
      await panel.getByRole("button", { name: "Edit Post-History Instructions", exact: true }).click()
      const overlay = page.getByRole("dialog", { name: "Preset editor", exact: true })
      await expect(overlay).toBeVisible()
      expect(new URL(page.url()).pathname).toBe(chatUrl)
      const focused = overlay.locator('[data-prompt="jailbreak"]')
      await expect(focused).toBeInViewport()
      expect(await page.evaluate(() => scrollY)).toBe(outerScroll)
      await shoot("focused-block")
      const scroll = overlay.getByTestId("preset-scroll")
      await scroll.evaluate((e) => {
        e.scrollTop = 0
      })
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
      await find.fill("{{char}}")
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
        expect(sticky).toBeLessThan(400)
        const options = overlay.getByRole("button", { name: "Options", exact: true })
        await options.click()
        await expect(overlay.getByRole("checkbox", { name: "Whole word", exact: true })).toBeVisible()
        await options.click()
      }
      await shoot("search-preview")
      await overlay.getByRole("button", { name: "Close preset editor", exact: true }).click()
      await expect(overlay).toHaveCount(0)
      await expectTextBox(composer, `An unfinished message ${width} ${theme}`)
      const notes = await openPanel(page, "Notes")
      await notes
        .getByRole("button", { name: /^Edit / })
        .first()
        .click()
      await notes.getByRole("combobox", { name: "Placement", exact: true }).first().click()
      await expect(page.getByRole("option", { name: "Start of context", exact: true })).toBeVisible()
      await shoot("note-positions")
      await page.keyboard.press("Escape")
      // Reopening from the library is an overlay too and has no chat-specific fills.
      await page.goto(`${server().url}/library`)
      await page.getByRole("button", { name: "Edit Celia 4.2", exact: true }).click()
      await expect(overlay).toContainText("no chat open")
      await shoot("library-document")
      await overlay
        .getByRole("textbox", { name: "Prompt: Main Prompt", exact: true })
        .fill(`Keep continuity in vivid prose ${width} ${theme}.`)
      await overlay
        .getByRole("textbox", { name: "Prompt: Post-History Instructions", exact: true })
        .fill(`Keep continuity ${width} ${theme}.`)
      await overlay.getByRole("textbox", { name: "Find", exact: true }).fill("continuity")
      await overlay.getByRole("textbox", { name: "Replace with", exact: true }).fill("coherence")
      await overlay.getByRole("button", { name: "Find", exact: true }).click()
      await overlay.getByRole("button", { name: "Replace all", exact: true }).click()
      await expectTextBox(
        overlay.getByRole("textbox", { name: "Prompt: Main Prompt", exact: true }),
        `Keep coherence in vivid prose ${width} ${theme}.`
      )
      await expectTextBox(
        overlay.getByRole("textbox", { name: "Prompt: Post-History Instructions", exact: true }),
        `Keep coherence ${width} ${theme}.`
      )
      await overlay.getByRole("button", { name: /^Save \(/ }).click()
      const diff = page.getByRole("dialog", { name: "Save a revision", exact: true })
      await expect(diff.getByRole("list", { name: "Changes", exact: true })).toContainText("Main Prompt")
      await expect(diff.getByRole("list", { name: "Changes", exact: true })).toContainText("Post-History Instructions")
      await shoot("save-diff")
      await diff.getByRole("button", { name: "Save revision", exact: true }).click()
      await expect(diff).toHaveCount(0)
      await overlay.getByRole("button", { name: "History", exact: true }).first().click()
      const revisions = page.getByRole("dialog", { name: "History", exact: true })
      await revisions.getByRole("list", { name: "Revisions", exact: true }).getByRole("button").first().click()
      await revisions.locator("summary").first().click()
      await expect(revisions.getByLabel("Revision changes")).toBeVisible()
      await shoot("revisions")
    })
  }

test("panel toggles share drafts with the overlay and discard restores the saved switch", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${library.forks.find((f) => f.current)!.chat.id}`)
  const panel = await openPanel(page, "Preset")
  const toggle = panel.getByRole("switch", { name: "Send Main Prompt", exact: true })
  const was = await toggle.isChecked()
  await toggle.click()
  await panel.getByRole("button", { name: "Edit Main Prompt", exact: true }).click()
  const overlay = page.getByRole("dialog", { name: "Preset editor", exact: true })
  await expect(overlay.getByRole("switch", { name: "Send Main Prompt", exact: true })).toBeChecked({ checked: !was })
  await overlay.getByRole("button", { name: "Close preset editor", exact: true }).click()
  await panel.getByRole("button", { name: "Discard", exact: true }).click()
  await expect(toggle).toBeChecked({ checked: was })
  await expect(panel.getByRole("button", { name: "Save", exact: true })).toHaveCount(0)
  const opened = await admin((api) =>
    Effect.map(api.OpenEditor({ refId: preset.id }), (editor) =>
      editor.drafts.filter((draft) => draft.status === "active")
    )
  )
  expect(opened).toHaveLength(0)
})

test("the panel's Discard asks first when the overlay changed more than the switches", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${library.forks.find((f) => f.current)!.chat.id}`)
  const panel = await openPanel(page, "Preset")
  await panel.getByRole("button", { name: "Edit Main Prompt", exact: true }).click()
  const overlay = page.getByRole("dialog", { name: "Preset editor", exact: true })
  const main = overlay.getByRole("textbox", { name: "Prompt: Main Prompt", exact: true })
  await main.fill("An hour of careful prompt work.")
  await expect(overlay.getByText("1 field has changes")).toBeVisible()
  await overlay.getByRole("button", { name: "Close preset editor", exact: true }).click()
  await panel.getByRole("button", { name: "Discard", exact: true }).click()
  const confirm = page.getByRole("alertdialog", { name: "Discard 1 unsaved change?" })
  await expect(confirm).toContainText("prompt text")
  await confirm.getByRole("button", { name: "Cancel", exact: true }).click()
  await panel.getByRole("button", { name: "Edit Main Prompt", exact: true }).click()
  await expectTextBox(main, "An hour of careful prompt work.")
  await overlay.getByRole("button", { name: "Close preset editor", exact: true }).click()
  await panel.getByRole("button", { name: "Discard", exact: true }).click()
  await page.getByRole("button", { name: "Discard them", exact: true }).click()
  await expect(panel.getByRole("button", { name: "Save", exact: true })).toHaveCount(0)
})

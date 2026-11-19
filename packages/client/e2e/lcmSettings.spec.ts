// The summarization settings (DESIGN §8) in the browser: the Summaries tab's settings (each field saved
// and read back, reset to the account default, the fit problems, Advanced), Settings → Chats →
// the defaults for new chats, the enable dialog switching the imported summary off, the Notes
// tab's summary note and the preset editor's `{{summary}}` badge. The realistic synthetic ST
// folder is imported by path, with ST sending its summary through `{{summary}}` in the preset.
// With SCREENSHOT_DIR set, it also writes the walkthrough's screenshots there.
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, type Locator, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import type { ChatId } from "@dreamspan/shared/chat.ts"
import { writeRealisticStFolder } from "../../server/test/support/stRealistic.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { type Client, loginCookie, withCookie } from "./support/rpc.ts"
import { startProvider, type FakeProvider } from "./support/provider.ts"
import { closePanel, openPanel, openSummarySettings } from "./support/panel.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "60" })
test.describe.configure({ mode: "serial" })
test.setTimeout(240_000)
let chatId: ChatId
/** Another imported chat with ST's summary, left off, for the walkthrough's shots before enabling. */
let otherId: ChatId
let cookie = ""
let provider: FakeProvider
const admin = <A>(use: (api: Client) => Effect.Effect<A, unknown>) => withCookie(server(), cookie, use)

test.beforeAll(async ({ browser }) => {
  cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
  provider = await startProvider()
  const page = await browser.newPage()
  try {
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const folder = writeRealisticStFolder(join(server().dataDir, "synthetic-st"), { summary: "macro" })
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
    // Karen Holt's 420-message chat: since fe174be2 its row counts the branch it opens on (355).
    const other = page
      .getByRole("main")
      .getByRole("link")
      .filter({ hasText: "Karen Holt" })
      .filter({ hasText: "355 messages" })
    otherId = (await other.getAttribute("href"))!.split("/").at(-1)! as ChatId
    // A model with a large window, as the owner's: the default pairs fit it.
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
        const model = yield* api.AddUserModel({
          connectionId: connection.id,
          key: "fake-large",
          overrides: { context: 128_000, maxOutput: 4_000 }
        })
        const defaults = yield* api.GetGenerationDefaults()
        yield* api.SetGenerationDefaults({
          defaults: { ...defaults, model: { connection: connection.id, model: model.id } }
        })
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
  if (!process.env.SCREENSHOT_DIR) return
  mkdirSync(process.env.SCREENSHOT_DIR, { recursive: true })
  await page.screenshot({ path: join(process.env.SCREENSHOT_DIR, `${name}.png`), fullPage: false })
}

const open = async (page: Page, width: number, colorScheme: "light" | "dark" = "light", chat = chatId) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
  await page.emulateMedia({ colorScheme })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chat}`)
}

/** The summary settings, with the summaries in their tab. */
const summaries = async (page: Page) => {
  const section = await openSummarySettings(page)
  await expect(section.getByRole("group", { name: "Recent messages kept as written" })).toBeVisible()
  return section
}

/** Summaries on or off: in This chat, with what a person touches first. */
const summarySwitch = async (page: Page) =>
  (await openPanel(page, "This chat")).getByRole("switch", { name: "Summarize older messages" })

const pair = (section: Locator, legend: string) => section.getByRole("group", { name: legend })

/** Resets every field that differs from the account default, one write at a time. */
const resetAll = async (section: Locator) => {
  const buttons = section.getByRole("button", { name: "Reset to account default" })
  for (let n = await buttons.count(); n > 0; n--) {
    await buttons.first().click()
    await expect(buttons).toHaveCount(n - 1)
  }
}

/** Types a number and leaves the field, which writes it. */
const setNumber = async (field: Locator, value: string) => {
  await field.fill(value)
  await field.press("Enter")
}

for (const width of [1440, 390])
  test(`the Summaries tab saves each field, resets, shows misfits and Advanced at ${width}`, async ({ page }) => {
    await open(page, width)
    // An imported chat: off, with the account default copied.
    await expect(await summarySwitch(page)).not.toBeChecked()
    let section = await summaries(page)
    const recent = pair(section, "Recent messages kept as written")
    await expect(recent.getByLabel("Target")).toHaveValue("12000")
    await expect(recent.getByLabel("Maximum")).toHaveValue("20000")
    // Copied unchanged (the first viewport), or following it after that viewport's reset.
    await expect(recent.getByText(/^(Same as|Follows) the account default\.$/)).toBeVisible()
    await expect(recent).toContainText(/now [\d,]+/)
    // One field, written and read back after a reload.
    await setNumber(recent.getByLabel("Maximum"), "30000")
    await expect(recent).toContainText("This chat's own; the account default is 12,000 and 20,000.")
    await page.reload()
    section = await summaries(page)
    await expect(pair(section, "Recent messages kept as written").getByLabel("Maximum")).toHaveValue("30000")
    await pair(section, "Recent messages kept as written")
      .getByRole("button", { name: "Reset to account default" })
      .click()
    await expect(pair(section, "Recent messages kept as written").getByLabel("Maximum")).toHaveValue("20000")
    // Pairs that don't fit the model: said under the fields, in the danger colour.
    await setNumber(pair(section, "Summary block").getByLabel("Maximum"), "200000")
    // Under the pair whose maximum takes the larger share.
    const problem = pair(section, "Summary block").getByRole("alert")
    await expect(problem).toContainText("Recent messages (20,000) and summaries (200,000) need 220,000 tokens")
    await expect(problem.locator("p").first()).toHaveClass(/text-danger/)
    await pair(section, "Summary block").getByRole("button", { name: "Reset to account default" }).click()
    await expect(problem).toHaveCount(0)
    // A target at or above the maximum it follows is said under the pair.
    await setNumber(pair(section, "Summary block").getByLabel("Target"), "19000")
    await expect(pair(section, "Summary block").getByRole("alert")).toContainText(
      "The target (19,000) must be below the maximum (18,000)."
    )
    await setNumber(pair(section, "Summary block").getByLabel("Target"), "14000")
    await expect(pair(section, "Summary block").getByRole("alert")).toHaveCount(0)
    // A maximum lowered below its target takes the target with it, at the same share, and says so.
    const block = pair(section, "Summary block")
    await setNumber(block.getByLabel("Maximum"), "10000")
    await expect(block.getByRole("status")).toHaveText("Target lowered to 7,700 to stay below the maximum.")
    await expect(block.getByLabel("Target")).toHaveValue("7700")
    await expect(block.getByRole("alert")).toHaveCount(0)
    await block.getByRole("button", { name: "Reset to account default" }).click()
    await expect(block.getByLabel("Maximum")).toHaveValue("18000")
    // Notes in summary requests: off by default, the chat's own when switched.
    const withNotes = section.getByRole("switch", { name: "Include notes in summary requests" })
    await expect(withNotes).not.toBeChecked()
    await withNotes.click()
    await expect(section).toContainText("the account default is off.")
    // Without the preset, and with the next reply; both read back.
    await section.getByRole("button", { name: "Instruction and messages only" }).click()
    await expect(section).toContainText("the account default is the current preset.")
    await section.getByRole("radio", { name: "With the next reply" }).click()
    await expect(section).toContainText("the account default is right after a reply.")
    // How a summary is written: the reply (default) or through tools.
    await expect(section.getByRole("button", { name: "A reply" })).toHaveAttribute("aria-pressed", "true")
    await section.getByRole("button", { name: "With tools" }).click()
    await expect(section).toContainText("the account default is a reply.")
    // Advanced: closed, then the chunk size and the summary length.
    await expect(section.getByLabel("Chunk size", { exact: true })).toBeHidden()
    await section.getByText("Advanced", { exact: true }).click()
    await setNumber(section.getByLabel("Chunk size", { exact: true }), "3000")
    await expect(section).toContainText("This chat's own; the account default is automatic.")
    await setNumber(section.getByLabel("Summary length", { exact: true }), "500")
    await expect(section).toContainText("This chat's own; the account default is 600.")
    // The instruction asks for the length in words.
    await expect(section).toContainText("{{words}} now: 375.")
    await page.reload()
    section = await summaries(page)
    await expect(section.getByRole("button", { name: "Instruction and messages only" })).toHaveAttribute(
      "aria-pressed",
      "true"
    )
    await expect(section.getByRole("radio", { name: "With the next reply" })).toBeChecked()
    await expect(section.getByRole("button", { name: "With tools" })).toHaveAttribute("aria-pressed", "true")
    await expect(section.getByRole("switch", { name: "Include notes in summary requests" })).toBeChecked()
    await section.getByText("Advanced", { exact: true }).click()
    await expect(section.getByLabel("Chunk size", { exact: true })).toHaveValue("3000")
    await expect(section.getByLabel("Summary length", { exact: true })).toHaveValue("500")
    // Back to the defaults for the next viewport.
    await resetAll(section)
    await section.getByLabel("Chunk size", { exact: true }).fill("")
    await section.getByLabel("Chunk size", { exact: true }).press("Enter")
    await expect(section.getByRole("button", { name: "Reset to account default" })).toHaveCount(0)
    const settings = await admin((api) => api.GetLcmSettings({ chatId, leafSlotId: null }))
    expect(settings.resolved.leafInput).toBeNull()
    expect(settings.resolved.withPreset).toBe("current")
    expect(settings.resolved.withNotes).toBe(false)
    expect(settings.resolved.style).toBe("direct")
    await closePanel(page)
  })

test("Settings → Chats sets the defaults a new chat copies", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/settings/chats`)
  const defaults = page.getByRole("region", { name: "Summary defaults for new chats" })
  await setNumber(pair(defaults, "Recent messages kept as written").getByLabel("Maximum"), "25000")
  await expect(defaults).toContainText("Your default; the built-in is 12,000 and 20,000.")
  await defaults.getByRole("radio", { name: "With the next reply" }).click()
  await expect(defaults.getByRole("radio", { name: "With the next reply" })).toBeChecked()
  const made = await admin((api) => api.CreateChat({ title: "A new story" }))
  await page.goto(`${server().url}/chats/${made.id}`)
  const section = await summaries(page)
  await expect(pair(section, "Recent messages kept as written").getByLabel("Maximum")).toHaveValue("25000")
  await expect(section.getByRole("radio", { name: "With the next reply" })).toBeChecked()
  await expect(await summarySwitch(page)).toBeChecked()
  // A later change of the default leaves the chat as it was made.
  await admin((api) => api.ChangeGenerationDefaults({ change: { lcm: { recentMax: null, when: null } } }))
  await page.reload()
  const again = await summaries(page)
  await expect(pair(again, "Recent messages kept as written").getByLabel("Maximum")).toHaveValue("25000")
})

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`Written as defaults survive reload and a new chat keeps its choice ${width} ${theme}`, async ({ page }) => {
      await open(page, width, theme)
      await page.goto(`${server().url}/settings/chats`)
      const defaults = page.getByRole("region", { name: "Summary defaults for new chats" })
      await defaults.getByRole("button", { name: "With tools", exact: true }).click()
      await expect(defaults.getByRole("button", { name: "With tools", exact: true })).toHaveAttribute(
        "aria-pressed",
        "true"
      )
      await page.reload()
      await expect(defaults.getByRole("button", { name: "With tools", exact: true })).toHaveAttribute(
        "aria-pressed",
        "true"
      )
      const made = await admin((api) => api.CreateChat({ title: "Written with tools" }))
      await defaults.getByRole("button", { name: "A reply", exact: true }).click()
      await expect(defaults.getByRole("button", { name: "A reply", exact: true })).toHaveAttribute(
        "aria-pressed",
        "true"
      )
      await page.goto(`${server().url}/chats/${made.id}`)
      let section = await summaries(page)
      await expect(section.getByRole("button", { name: "With tools", exact: true })).toHaveAttribute(
        "aria-pressed",
        "true"
      )
      await section.getByRole("button", { name: "Reset to account default", exact: true }).click()
      await expect(section.getByRole("button", { name: "A reply", exact: true })).toHaveAttribute(
        "aria-pressed",
        "true"
      )
      await page.reload()
      section = await summaries(page)
      await expect(section.getByRole("button", { name: "A reply", exact: true })).toHaveAttribute(
        "aria-pressed",
        "true"
      )
    })

// The phone first: the desktop run turns summaries on.
for (const width of [390, 1440])
  test(`the summary note, the preset badge and the enable dialog at ${width}`, async ({ page }) => {
    await open(page, width)
    const notes = await openPanel(page, "Notes")
    const row = notes.getByRole("listitem").filter({ hasText: "Summary (from ST)" })
    await expect(row.getByRole("switch", { name: "Summary (from ST)" })).toBeChecked()
    await expect(row).toContainText("Your preset includes this through {{summary}}.")
    const preset = await openPanel(page, "Prompt preset")
    await expect(preset.getByText(/\{\{summary\}\}: Summary \(from ST\) note \(~[\d,]+ tokens\)/)).toBeVisible()
    // The badge sits under the prompt's name and leaves it its width: the name stays on one line.
    const name = (await preset.getByText("Main Prompt", { exact: true }).boundingBox())!
    expect(name.height).toBeLessThan(30)
    if (width === 1440) {
      // The enable dialog says the note goes off, and turning summaries on does it.
      await (await summarySwitch(page)).click()
      const dialog = page.getByRole("dialog", { name: "Summarize older messages" })
      await expect(dialog).toContainText("Its note is switched off, so it isn't sent twice.")
      await dialog.getByRole("button", { name: "Enable summaries" }).click()
      await expect(dialog).toHaveCount(0)
      const after = await openPanel(page, "Notes")
      const off = after.getByRole("listitem").filter({ hasText: "Summary (from ST)" })
      await expect(off.getByRole("switch", { name: "Summary (from ST)" })).not.toBeChecked()
      // `{{summary}}` is ST's summary note's alone, never the summaries (DESIGN §8).
      await expect(off).toContainText("Your preset has {{summary}}; it sends nothing while this is off.")
      const badge = await openPanel(page, "Prompt preset")
      await expect(badge.getByText("{{summary}}: Nothing, no summary note is on")).toBeVisible()
      expect((await badge.getByText("Main Prompt", { exact: true }).boundingBox())!.height).toBeLessThan(30)
      // Switched back on, it's sent beside the summaries, and the note says so.
      const back = await openPanel(page, "Notes")
      const on = back.getByRole("listitem").filter({ hasText: "Summary (from ST)" })
      await on.getByRole("switch", { name: "Summary (from ST)" }).click()
      await expect(on).toContainText("Your preset includes this through {{summary}}. Also sent beside the summaries.")
      const filled = await openPanel(page, "Prompt preset")
      await expect(filled.getByText(/\{\{summary\}\}: Summary \(from ST\) note \(~[\d,]+ tokens\)/)).toBeVisible()
    }
  })

for (const width of [1440, 390])
  for (const colorScheme of ["light", "dark"] as const)
    test(`walkthrough screenshots ${width} ${colorScheme}`, async ({ page }) => {
      test.skip(!process.env.SCREENSHOT_DIR, "screenshots only")
      await open(page, width, colorScheme)
      const section = await summaries(page)
      await section.scrollIntoViewIfNeeded()
      await shoot(page, `summaries-${width}-${colorScheme}`)
      await setNumber(pair(section, "Recent messages kept as written").getByLabel("Maximum"), "30000")
      await expect(section).toContainText("This chat's own")
      await shoot(page, `summaries-edited-${width}-${colorScheme}`)
      await setNumber(pair(section, "Summary block").getByLabel("Maximum"), "200000")
      await pair(section, "Summary block").getByRole("alert").scrollIntoViewIfNeeded()
      await shoot(page, `summaries-misfit-${width}-${colorScheme}`)
      await pair(section, "Summary block").getByRole("button", { name: "Reset to account default" }).click()
      await expect(pair(section, "Summary block").getByLabel("Maximum")).toHaveValue("18000")
      await setNumber(pair(section, "Summary block").getByLabel("Maximum"), "10000")
      await pair(section, "Summary block").getByRole("status").scrollIntoViewIfNeeded()
      await shoot(page, `summaries-lowered-${width}-${colorScheme}`)
      await section.getByText("Advanced", { exact: true }).click()
      await section.getByLabel("Summary length", { exact: true }).scrollIntoViewIfNeeded()
      await shoot(page, `summaries-advanced-${width}-${colorScheme}`)
      await resetAll(section)
      // Summaries on, the note switched back on beside them, and `{{summary}}` sending the note.
      const notes = await openPanel(page, "Notes")
      await notes.getByText("Summary (from ST)").first().scrollIntoViewIfNeeded()
      await shoot(page, `notes-on-${width}-${colorScheme}`)
      const preset = await openPanel(page, "Prompt preset")
      await preset
        .getByText(/\{\{summary\}\}:/)
        .first()
        .scrollIntoViewIfNeeded()
      await shoot(page, `preset-badge-on-${width}-${colorScheme}`)
      await closePanel(page)
      // An imported chat before enabling: its note, the badge, and the enable dialog (cancelled).
      await open(page, width, colorScheme, otherId)
      const before = await openPanel(page, "Notes")
      await before.getByText("Your preset includes this through {{summary}}.").scrollIntoViewIfNeeded()
      await shoot(page, `notes-imported-${width}-${colorScheme}`)
      const badge = await openPanel(page, "Prompt preset")
      await badge.getByText(/\{\{summary\}\}: Summary \(from ST\) note/).scrollIntoViewIfNeeded()
      await shoot(page, `preset-badge-imported-${width}-${colorScheme}`)
      await (await summarySwitch(page)).click()
      const dialog = page.getByRole("dialog", { name: "Summarize older messages" })
      await expect(dialog).toContainText("Its note is switched off")
      await shoot(page, `enable-dialog-${width}-${colorScheme}`)
      await dialog.getByRole("button", { name: "Cancel" }).click()
      await closePanel(page)
      await page.goto(`${server().url}/settings/chats`)
      await page.getByRole("region", { name: "Summary defaults for new chats" }).scrollIntoViewIfNeeded()
      await shoot(page, `settings-chats-${width}-${colorScheme}`)
    })

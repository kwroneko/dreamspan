// Notes that replace prompts (DESIGN §4.2; spec/NOTE-OVERRIDES.md): a card field and a preset
// prompt replaced from their own boxes ("Replace with a note in this chat"), shown with "As
// replaced" first, glowing, its edits going to the note; "Original" the card's or preset's own
// text; the note's Replaces control, its greyed position and Its own position; one note per
// target. At 1440 and 390, light and dark, with the layout audit on each surface. A made-up
// card and ST's default preset.
import { mkdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, type Locator, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
import { noteBlock, openNoteSettings } from "./support/notes.ts"
import { openPanel, panelTab } from "./support/panel.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "400", FAKE_GENERATOR_TOKENS: "20" })
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
const shots = process.env.SCREENSHOT_DIR ?? join(tmpdir(), "rp-note-overrides")
mkdirSync(shots, { recursive: true })

const preset = JSON.parse(
  readFileSync(new URL("../../server/test/fixtures/presets/default.json", import.meta.url), "utf8")
) as Record<string, unknown>

const upload = async (page: Page, name: string, data: unknown) => {
  const response = await page.request.post(`${server().url}/library/import?name=${encodeURIComponent(name)}.json`, {
    data: Buffer.from(JSON.stringify(data)),
    headers: { origin: server().url, "content-type": "application/octet-stream" }
  })
  expect(response.status()).toBe(200)
}

const setUp = async (page: Page, tag: string) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await upload(page, `Wren ${tag}`, {
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: { name: `Wren ${tag}`, description: "A lighthouse keeper in a grey coat.", first_mes: "The lamp turns." }
  })
  await upload(page, `Preset ${tag}`, preset)
  return admin((api) =>
    Effect.gen(function* () {
      const ref = (yield* api.ListLibrary({ kind: "preset" })).find((r) => r.label === `Preset ${tag}`)!
      yield* api.ChangeGenerationDefaults({ change: { preset: ref.id } })
      const card = (yield* api.ListCards()).find((c) => c.name === `Wren ${tag}`)!
      const chat = yield* api.CreateChat({ title: `Lamp ${tag}` })
      yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: card.entityId } })
      return { chatId: chat.id, name: `Wren ${tag}` }
    })
  )
}

const theme = async (page: Page, width: number, scheme: "light" | "dark") => {
  await page.setViewportSize({ width, height: width < 600 ? 844 : 900 })
  await page.emulateMedia({ colorScheme: scheme })
  await page.addInitScript((value) => localStorage.setItem("rp.theme", value), scheme)
}

/** A field by its box's accessible name, with its label row and strip. */
const fieldOf = (scope: Locator, name: string) =>
  scope.locator("[data-field-frame]").filter({ has: scope.page().getByRole("textbox", { name, exact: true }) })

test.setTimeout(240_000)

for (const width of [1440, 390])
  for (const scheme of ["light", "dark"] as const)
    test(`a card field and a preset prompt replaced by notes (${width}px ${scheme})`, async ({ page }, info) => {
      await theme(page, width, scheme)
      const { chatId, name } = await setUp(page, `${width}${scheme}`)
      const shot = (what: string) => page.screenshot({ path: join(shots, `${what}-${width}-${scheme}.png`) })
      await page.goto(`${server().url}/chats/${chatId}`)
      await expect(page.getByLabel("Message", { exact: true })).toBeEditable()

      // The character's tab: Description, replaced from its own box.
      await openPanel(page, "Cast")
      await panelTab(page, name)
      const tab = page.getByRole("tabpanel", { name })
      const description = tab.getByRole("textbox", { name: "Description", exact: true })
      await expect(description).toContainText("grey coat")
      const replace = fieldOf(tab, "Description").getByRole("button", { name: "Replace with a note in this chat" })
      await description.click()
      await replace.click()
      const tabs = tab.getByRole("tablist", { name: "Description: as replaced or original" })
      await expect(tabs.getByRole("tab", { name: "As replaced" })).toHaveAttribute("aria-selected", "true")
      const replaced = tab.locator("[data-replaced-field]")
      await expect(replaced).toBeVisible()
      await expect(replaced.getByText("Replaced in this chat by the note")).toBeVisible()
      await expect(replaced.getByRole("button", { name: `${name}'s Description` })).toBeVisible()
      // Edits go to the note; the original keeps the card's text.
      const noteBox = replaced.getByRole("textbox", { name: "Description", exact: true })
      await expect(noteBox).toContainText("grey coat")
      await noteBox.click()
      await page.keyboard.press("End")
      await page.keyboard.type(" Today: a red scarf.")
      await expect(noteBox).toContainText("red scarf")
      await replaced.scrollIntoViewIfNeeded()
      await shot("card-field-as-replaced")
      await expectLayout(page, info, `card field as replaced ${width} ${scheme}`, { scope: "[data-note-replaced]" })
      await tabs.getByRole("tab", { name: "Original" }).click()
      const original = tab.getByRole("textbox", { name: "Description", exact: true })
      await expect(original).toContainText("grey coat")
      await expect(original).not.toContainText("red scarf")
      await expect(tab.locator("[data-replaced-field]")).toHaveCount(0)
      await shot("card-field-original")

      // The note in the Notes tab: what it replaces, its position greyed until it has its own.
      const notes = await openPanel(page, "Notes")
      const title = `${name}'s Description`
      const block = noteBlock(notes, title)
      await expect(block).toContainText(`In place of ${title}`)
      await openNoteSettings(block, title)
      await expect(block.getByRole("combobox", { name: "Replaces" })).toContainText(title)
      await expect(block.getByRole("combobox", { name: "Position" })).toBeDisabled()
      await block.getByRole("switch", { name: "Its own position" }).click()
      await expect(block.getByRole("combobox", { name: "Position" })).toBeEnabled()
      await expect(block).toContainText(`replaces ${title}`)
      await block.scrollIntoViewIfNeeded()
      await shot("note-replaces")
      await expectLayout(page, info, `note settings ${width} ${scheme}`, { scope: `[aria-label="Note ${title}"]` })
      await block.getByRole("switch", { name: "Its own position" }).click()
      await expect(block.getByRole("combobox", { name: "Position" })).toBeDisabled()

      // A preset prompt: replaced from its box in the Prompt preset tab, marked on its row.
      const presetTab = await openPanel(page, "Prompt preset")
      await expect(presetTab.getByRole("list", { name: "Preset blocks" })).toBeVisible({ timeout: 60_000 })
      const mainToggle = presetTab.getByRole("button", { name: /^Expand Main Prompt/ }).first()
      if (await mainToggle.count()) await mainToggle.click()
      const main = presetTab.getByRole("textbox", { name: "Prompt: Main Prompt", exact: true })
      await main.click()
      await fieldOf(presetTab, "Prompt: Main Prompt")
        .getByRole("button", { name: "Replace with a note in this chat" })
        .click()
      const mainTabs = presetTab.getByRole("tablist", { name: "Prompt: Main Prompt: as replaced or original" })
      await expect(mainTabs.getByRole("tab", { name: "As replaced" })).toHaveAttribute("aria-selected", "true")
      await expect(presetTab.locator('[data-prompt="main"] [data-prompt-replaced]')).toBeVisible({ timeout: 60_000 })
      await presetTab.locator('[data-prompt="main"]').scrollIntoViewIfNeeded()
      await shot("preset-prompt-as-replaced")
      await expectLayout(page, info, `preset prompt as replaced ${width} ${scheme}`, { scope: '[data-prompt="main"]' })

      // One note per target: a second note picking Main says so and offers to unlink the first.
      const notes2 = await openPanel(page, "Notes")
      await notes2.getByRole("region", { name: "This chat's notes" }).getByRole("button", { name: "Add note" }).click()
      const fresh = noteBlock(notes2, "Note")
      await openNoteSettings(fresh, "Note")
      await fresh.getByRole("combobox", { name: "Replaces" }).click()
      await page.getByRole("option", { name: "Main Prompt", exact: true }).click()
      await expect(fresh.getByText("Only one note can replace Main Prompt")).toBeVisible()
      await fresh.getByText("Only one note can replace Main Prompt").scrollIntoViewIfNeeded()
      await shot("one-per-target")
      await fresh.getByRole("button", { name: /^Unlink / }).click()
      await expect(fresh.getByRole("combobox", { name: "Replaces" })).toContainText("Main Prompt")
      await expect(fresh.getByText("Only one note can replace Main Prompt")).toHaveCount(0)
    })

test("turning off a newly created replacement restores the original field while its editor stays open", async ({
  page
}) => {
  await theme(page, 1440, "light")
  const { chatId, name } = await setUp(page, "off-with-editor-open")
  await page.goto(`${server().url}/chats/${chatId}`)
  await expect(page.getByLabel("Message", { exact: true })).toBeEditable()
  await openPanel(page, "Cast")
  await panelTab(page, name)
  const card = page.getByRole("tabpanel", { name })
  const field = fieldOf(card, "Description")
  await card.getByRole("textbox", { name: "Description", exact: true }).click()
  await field.getByRole("button", { name: "Replace with a note in this chat" }).click()
  await expect(card.locator("[data-replaced-field]")).toBeVisible()
  const note = await admin((api) =>
    Effect.gen(function* () {
      const notes = yield* api.ListChatNotes({ chatId, slotId: null })
      return notes.find((n) => n.doc["title"] === `${name}'s Description`)!
    })
  )
  // Wait for assembly to acknowledge the replacement before switching it off.
  await expect
    .poll(() =>
      admin((api) =>
        Effect.map(
          api.GetNextContext({ chatId, leafSlotId: null }),
          (next) => next.presetContext?.replacements?.some((r) => r.note === note.ref.id) ?? false
        )
      )
    )
    .toBe(true)
  await admin((api) =>
    api.ChangeCast({ chatId, slotId: null, change: { _tag: "Note", entityId: note.ref.entityId, active: false } })
  )
  await expect(card.locator("[data-replaced-field]")).toHaveCount(0)
  await expect(card.getByRole("textbox", { name: "Description", exact: true })).toContainText("grey coat")
})

for (const { label, content, expected } of [
  { label: "empty", content: "", expected: "0 tokens" },
  { label: "longer", content: "x".repeat(400), expected: "~100 tokens" }
])
  test(`a preset prompt shows the sent token count of its ${label} replacement`, async ({ page }) => {
    await theme(page, 1440, "light")
    const { chatId } = await setUp(page, `${label}-token-count`)
    await admin((api) =>
      Effect.gen(function* () {
        const note = yield* api.CreateChatNote({
          chatId,
          title: "Replacement Main",
          content,
          replaces: { kind: "preset_prompt", identifier: "main" }
        })
        yield* api.ChangeCast({ chatId, slotId: null, change: { _tag: "Note", entityId: note.entityId, active: true } })
      })
    )
    await page.goto(`${server().url}/chats/${chatId}`)
    await expect(page.getByLabel("Message", { exact: true })).toBeEditable()
    const panel = await openPanel(page, "Prompt preset")
    const main = panel.locator('[data-prompt="main"]')
    await expect(main.locator("[data-prompt-replaced]")).toBeVisible({ timeout: 60_000 })
    await expect(main.locator("[data-prompt-tokens]")).toHaveText(expected)
    const expand = main.getByRole("button", { name: /^Expand Main Prompt/ })
    if (await expand.count()) await expand.click()
    await expect(main.locator("[data-prompt-tokens]")).toHaveText(expected)
    await panel.getByRole("link", { name: "Open the preset in the large editor", exact: true }).click()
    const large = page.getByRole("region", { name: "Preset editor", exact: true })
    await expect(large.locator('[data-prompt="main"] [data-prompt-tokens]')).toHaveText(expected)
  })

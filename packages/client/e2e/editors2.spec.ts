// The owner's decisions of 2026-11-02 for the editors: Export with unsaved changes asks first
// (the full editor, the character tab and the library's item menu), the card's token counts
// say which tokenizer counted, and bulk lorebook changes and preset structure wait behind
// Save/Revert (their own steps are in lorebookPanel, presetTab and editor). At 1440 and 390, in
// both themes. Made-up cards only.
import { switchAll } from "./support/lorebook.ts"
import { mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, type Locator, type Page, test } from "@playwright/test"
import type { EntityId } from "@dreamspan/shared/chat.ts"
import { HELD_FIELD, textField } from "@dreamspan/shared/editing.ts"
import type { RefId } from "@dreamspan/shared/library.ts"
import { Effect } from "effect"
import { type Client, loginCookie, withCookie } from "./support/rpc.ts"
import { NOTHING_TO_SAVE, UNSAVED, expectSaveState } from "./support/saveRevision.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { expectTextBox } from "./support/textbox.ts"

const server = serverPerFile(withAdmin)
// Reuse the setup session: the extra export cases must not exhaust the login limit.
let adminCookie: Promise<string> | undefined
const admin = async <A>(use: (api: Client) => Effect.Effect<A, unknown>) =>
  withCookie(server(), await (adminCookie ??= loginCookie(server(), ADMIN.handle, ADMIN.password)), use)
const shots = process.env.SCREENSHOT_DIR

const shoot = async (page: Page, name: string) => {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
  if (!shots) return
  mkdirSync(shots, { recursive: true })
  await page.screenshot({ path: join(shots, `${name}.png`), animations: "disabled" })
}

const importCard = async (page: Page, name: string) => {
  const data = {
    name,
    description: `${name} keeps the lighthouse log.`,
    personality: "Patient.",
    scenario: "A storm at dusk.",
    first_mes: `${name} lights the lamp.`,
    mes_example: "",
    creator_notes: "",
    system_prompt: "",
    post_history_instructions: "",
    alternate_greetings: [],
    tags: [],
    creator: "Synthetic",
    character_version: "1.0",
    extensions: {}
  }
  const body = Buffer.from(JSON.stringify({ spec: "chara_card_v3", spec_version: "3.0", data }))
  const response = await page.request.post(`${server().url}/library/import?name=card.json`, {
    data: body,
    headers: { origin: server().url, "content-type": "application/octet-stream" }
  })
  expect(response.status()).toBe(200)
  return (await response.json()).library.ref as { id: RefId; entityId: EntityId }
}

const downloaded = async (page: Page, click: () => Promise<void>) => {
  const download = page.waitForEvent("download")
  await click()
  return JSON.parse(readFileSync(await (await download).path(), "utf8")) as { data: { description: string } }
}

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`export asks about unsaved changes; counts name their tokenizer (${width}, ${theme})`, async ({ page }) => {
      test.setTimeout(150_000)
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const name = `Ione ${width} ${theme}`
      const ref = await importCard(page, name)
      await page.goto(`${server().url}/library/${ref.id}`)
      await expect(page.getByRole("heading", { level: 1, name })).toBeVisible({ timeout: 30_000 })

      // Counts come from the server's tokenizer; with no chat model here, o200k_base, said so.
      const tokens = page.locator("[data-card-tokens]")
      await expect(tokens).toHaveText(/^~[\d,]+ tokens · ~[\d,]+ permanent$/, { timeout: 30_000 })
      await tokens.hover()
      const explained = page.getByText(/^Total: every card field/).last()
      await expect(explained).toContainText("Approximate: counted with o200k_base")
      await expect(explained).toContainText("No model is chosen")
      await shoot(page, `tokens-${width}-${theme}`)
      const description = page.getByRole("textbox", { name: "Description", exact: true })
      const field = page.locator("[data-field-tokens]").first()
      await expect(field).toHaveText(/^~[\d,]+ tokens$/)
      const before = await field.textContent()
      await description.fill(`${name} keeps the lighthouse log, and writes the storms down hour by hour.`)
      await expect(field).not.toHaveText(before!, { timeout: 30_000 })
      await expectSaveState(page, UNSAVED)

      // Export with that unsaved: the dialog names it; the last revision leaves it out.
      await page.getByRole("button", { name: "Export…", exact: true }).click()
      await page.getByRole("menuitem", { name: "V3 JSON" }).click()
      const dialog = page.getByRole("dialog", { name: `${name} has unsaved changes` })
      await expect(dialog.getByRole("list", { name: "Unsaved changes" })).toHaveText("Description")
      await shoot(page, `export-unsaved-${width}-${theme}`)
      const last = await downloaded(page, () =>
        dialog.getByRole("button", { name: "Export the last revision", exact: true }).click()
      )
      expect(last.data.description).toBe(`${name} keeps the lighthouse log.`)
      await expect(dialog).toHaveCount(0)
      await expectSaveState(page, UNSAVED)

      // Cancel writes nothing; Save and export cuts revision 2 and exports it.
      await page.getByRole("button", { name: "Export…", exact: true }).click()
      await page.getByRole("menuitem", { name: "V3 JSON" }).click()
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
      await expect(dialog).toHaveCount(0)
      await page.getByRole("button", { name: "Export…", exact: true }).click()
      await page.getByRole("menuitem", { name: "V3 JSON" }).click()
      const saved = await downloaded(page, () =>
        dialog.getByRole("button", { name: "Save and export", exact: true }).click()
      )
      expect(saved.data.description).toContain("hour by hour")
      await expectSaveState(page, NOTHING_TO_SAVE)

      // Nothing unsaved: Export downloads at once, with no dialog.
      await page.getByRole("button", { name: "Export…", exact: true }).click()
      const plain = await downloaded(page, () => page.getByRole("menuitem", { name: "V3 JSON" }).click())
      expect(plain.data.description).toContain("hour by hour")
      await expect(dialog).toHaveCount(0)
    })

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`cast Export submenu works by hover, click and keyboard (${width}, ${theme})`, async ({ page }) => {
      test.setTimeout(150_000)
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const name = `Export Cast ${width} ${theme}`
      const ref = await importCard(page, name)
      const started = await admin((api) =>
        api.StartChat({
          cards: [ref.entityId],
          persona: null,
          greeting: null,
          first: { _tag: "Send", content: "The lamp is lit.", speakerEntityId: null }
        })
      )
      await page.goto(`${server().url}/chats/${started.chat.id}?panel=cast`)
      const more = page.getByRole("button", { name: `More for ${name}`, exact: true })
      const parent = page.getByRole("menu", { name: `More for ${name}`, exact: true })
      const trigger = page.getByRole("menuitem", { name: "Export…", exact: true })
      const formats = page.getByRole("menu", { name: "Export…", exact: true })
      // Hover keeps the parent open and exposes all registered formats, including PNG.
      await more.click()
      await expect(trigger).toHaveAccessibleDescription("Exports this card as a file.")
      await trigger.hover()
      await expect(formats).toBeVisible()
      await expect(parent).toBeVisible()
      for (const format of ["PNG", "V2 JSON", "V3 JSON", "CHARX"])
        await expect(formats.getByRole("menuitem", { name: format, exact: true })).toBeVisible()
      await shoot(page, `cast-export-${width}-${theme}`)
      const download = page.waitForEvent("download")
      await formats.getByRole("menuitem", { name: "PNG", exact: true }).click()
      const file = await download
      expect(file.suggestedFilename()).toMatch(/\.png$/)
      await expect(parent).toBeHidden()
      // Click opens the same submenu; Escape closes only that level and restores its trigger.
      await more.click()
      await trigger.click()
      await expect(formats).toBeVisible()
      await page.keyboard.press("Escape")
      await expect(formats).toBeHidden()
      await expect(parent).toBeVisible()
      await page.keyboard.press("Escape")
      // Reopened while the closing menu still animates out, the old menu's focus return
      // can land after the new one has taken focus.
      await expect(parent).toBeHidden()
      // Keyboard alone: Enter opens Cast, typeahead reaches Export, → opens the submenu,
      // Enter selects PNG and starts the download. Left returns to the parent level.
      await page.mouse.move(0, 0)
      await more.focus()
      await more.press("Enter")
      await page.keyboard.type("Export")
      await expect(trigger).toBeFocused()
      // A submenu takes focus a moment after it shows; keys pressed before then reach the parent.
      const focusIn = (menu: Locator) => expect.poll(() => menu.evaluate((m) => m.contains(document.activeElement)))
      await page.keyboard.press("ArrowRight")
      await expect(formats).toBeVisible()
      await focusIn(formats).toBe(true)
      await page.keyboard.press("ArrowLeft")
      await expect(trigger).toBeFocused()
      await page.keyboard.press("Enter")
      await expect(formats).toBeVisible()
      await focusIn(formats).toBe(true)
      await page.keyboard.press("Home")
      await expect(formats.getByRole("menuitem", { name: "PNG", exact: true })).toBeFocused()
      const keyedDownload = page.waitForEvent("download")
      await page.keyboard.press("Enter")
      expect((await keyedDownload).suggestedFilename()).toMatch(/\.png$/)
      await expect(parent).toBeHidden()
      // Existing server drafts still ask first, after either hover or keyboard selection.
      await admin((api) =>
        Effect.gen(function* () {
          const opened = yield* api.OpenEditor({ refId: ref.id })
          yield* api.SaveEditorDraft({
            refId: ref.id,
            field: textField(["description"]),
            draftId: null,
            content: "An unsaved lighthouse description.",
            expectedRowVersion: null,
            expectedSession: null,
            baseRevisionId: opened.ref.headRevisionId
          })
        })
      )
      const dialog = page.getByRole("dialog", { name: `${name} has unsaved changes`, exact: true })
      for (const keyboard of [false, true]) {
        if (keyboard) {
          await page.mouse.move(0, 0)
          await more.focus()
          await more.press("Enter")
          await page.keyboard.type("Export")
          await expect(trigger).toBeFocused()
          // Home before the submenu takes focus moves to the parent's first item instead,
          // closing the submenu, and Enter then picks that item.
          await page.keyboard.press("ArrowRight")
          await focusIn(formats).toBe(true)
          await page.keyboard.press("Home")
          await expect(formats.getByRole("menuitem", { name: "PNG", exact: true })).toBeFocused()
          await page.keyboard.press("Enter")
        } else {
          await more.click()
          await trigger.hover()
          await formats.getByRole("menuitem", { name: "PNG", exact: true }).click()
        }
        await expect(dialog.getByRole("list", { name: "Unsaved changes" })).toHaveText("Description")
        await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
        // The closing dialog hands focus back as it unmounts: wait, as for the menu above.
        await expect(dialog).toHaveCount(0)
        await expect(parent).toBeHidden()
      }
    })

test("the library's item menu asks too, from the server's unsaved drafts", async ({ page }) => {
  test.setTimeout(120_000)
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const name = "Corin Library"
  const ref = await importCard(page, name)
  await page.goto(`${server().url}/library/${ref.id}`)
  const description = page.getByRole("textbox", { name: "Description", exact: true })
  await description.fill("Corin mends nets on the slipway.")
  await expectSaveState(page, UNSAVED)
  // The typing is on the server as a draft, then the editor is left.
  await expect
    .poll(() =>
      admin((api) =>
        Effect.map(api.OpenEditor({ refId: ref.id }), (editor) =>
          editor.drafts.some((d) => d.status === "active" && d.content === "Corin mends nets on the slipway.")
        )
      )
    )
    .toBe(true)
  await page.goto(`${server().url}/library`)
  await page.getByRole("button", { name: `More actions for ${name}` }).click()
  await page.getByRole("menuitem", { name: "Export…", exact: true }).click()
  await page.getByRole("menuitem", { name: "V2 JSON", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: `${name} has unsaved changes` })
  await expect(dialog.getByRole("list", { name: "Unsaved changes" })).toHaveText("Description")
  const saved = await downloaded(page, () =>
    dialog.getByRole("button", { name: "Save and export", exact: true }).click()
  )
  expect(saved.data.description).toBe("Corin mends nets on the slipway.")
  await page.goto(`${server().url}/library/${ref.id}`)
  await expectTextBox(description, "Corin mends nets on the slipway.")
  await expectSaveState(page, NOTHING_TO_SAVE)
})

test("a card's note with unsaved typing is asked about too, and saved with the card", async ({ page }) => {
  test.setTimeout(120_000)
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const name = "Maren Notes"
  const ref = await importCard(page, name)
  // A note on the card, exported with it, typed into and not saved.
  await admin((api) =>
    Effect.gen(function* () {
      const note = yield* api.CreateCardNote({ cardRefId: ref.id, title: "Lamp oil" })
      const opened = yield* api.OpenEditor({ refId: note.id })
      yield* api.SaveEditorDraft({
        refId: note.id,
        field: textField(["content"]),
        draftId: null,
        content: "Maren smells of lamp oil.",
        expectedRowVersion: null,
        expectedSession: null,
        baseRevisionId: opened.ref.headRevisionId
      })
    })
  )
  await page.goto(`${server().url}/library`)
  await page.getByRole("button", { name: `More actions for ${name}` }).click()
  await page.getByRole("menuitem", { name: "Export…", exact: true }).click()
  await page.getByRole("menuitem", { name: "V2 JSON", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: `${name} has unsaved changes` })
  await expect(dialog.getByRole("list", { name: "Unsaved changes" })).toHaveText("Note “Lamp oil”: Content")
  // The last revisions: the note's text isn't in the file.
  const last = await downloaded(page, () =>
    dialog.getByRole("button", { name: "Export the last revision", exact: true }).click()
  )
  expect(JSON.stringify(last)).not.toContain("lamp oil.")
  // Save and export saves the note too, and the file has it (ST's depth prompt).
  await page.getByRole("button", { name: `More actions for ${name}` }).click()
  await page.getByRole("menuitem", { name: "Export…", exact: true }).click()
  await page.getByRole("menuitem", { name: "V2 JSON", exact: true }).click()
  const saved = await downloaded(page, () =>
    dialog.getByRole("button", { name: "Save and export", exact: true }).click()
  )
  expect(JSON.stringify(saved)).toContain("Maren smells of lamp oil.")
  // Nothing unsaved now: the next export asks nothing.
  await page.getByRole("button", { name: `More actions for ${name}` }).click()
  await page.getByRole("menuitem", { name: "Export…", exact: true }).click()
  await downloaded(page, () => page.getByRole("menuitem", { name: "V2 JSON", exact: true }).click())
  await expect(dialog).toHaveCount(0)
})

test("token counts expand {{char}} and {{user}} first, as ST does", async ({ page }) => {
  test.setTimeout(120_000)
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const ref = await importCard(page, "Bartholomew Longname")
  await page.goto(`${server().url}/library/${ref.id}`)
  const scenario = page.getByRole("textbox", { name: "Scenario", exact: true })
  const counts = page.locator("[data-field-tokens]")
  // Scenario is the third counted field: {{char}} counts as the name it becomes, typed out.
  // {{user}} outside a chat is "User", as in ST.
  const settled = async () => {
    await expect(counts.nth(2)).toHaveAttribute("aria-busy", "true")
    await expect.poll(() => counts.nth(2).getAttribute("aria-busy"), { timeout: 30_000 }).toBeNull()
  }
  await scenario.fill("Bartholomew Longname waits by User's pier, then by the long harbour wall.")
  await settled()
  const plain = await counts.nth(2).textContent()
  expect(plain).toMatch(/^~\d+ tokens$/)
  // The macros expand to that same text: nothing new to count, so the count never even waits.
  await scenario.fill("{{char}} waits by {{user}}'s pier, then by the long harbour wall.")
  await expectTextBox(scenario, "{{char}} waits by {{user}}'s pier, then by the long harbour wall.")
  await page.waitForTimeout(150)
  expect(await counts.nth(2).getAttribute("aria-busy")).toBeNull()
  await expect(counts.nth(2)).toHaveText(plain!)
  await counts.nth(2).hover()
  await expect(page.getByText(/^Counted with macros as they become/).last()).toBeVisible()
})

test("the character tab's Export asks with the tab's own unsaved typing", async ({ page }) => {
  test.setTimeout(120_000)
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const ref = await importCard(page, "Petra Tab")
  const started = await admin((api) =>
    api.StartChat({
      cards: [ref.entityId],
      persona: null,
      greeting: null,
      first: { _tag: "Send", content: "Petra waves.", speakerEntityId: null }
    })
  )
  await page.goto(`${server().url}/chats/${started.chat.id}?panel=card:${ref.entityId}`)
  const tab = page.getByRole("tabpanel").filter({ has: page.locator('[data-card-tabs="panel"]') })
  await tab.getByRole("textbox", { name: "Description", exact: true }).fill("Petra carries the post up the hill.")
  await tab.getByRole("button", { name: "Export…", exact: true }).click()
  await page.getByRole("menuitem", { name: "V2 JSON" }).click()
  const dialog = page.getByRole("dialog", { name: "Petra Tab has unsaved changes" })
  await expect(dialog.getByRole("list", { name: "Unsaved changes" })).toHaveText("Description")
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
  await expectSaveState(tab, UNSAVED)
})

const upload = async (page: Page, name: string, data: unknown) => {
  const response = await page.request.post(`${server().url}/library/import?name=${encodeURIComponent(name)}`, {
    headers: { "content-type": "application/octet-stream", origin: server().url },
    data: Buffer.from(JSON.stringify(data))
  })
  expect(response.status()).toBe(200)
  return ((await response.json()) as { library: { ref: { id: RefId } } }).library.ref.id
}

test("export asks about a preset's held changes even with no ordinary dirty fields", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const name = "Held export preset"
  const refId = await upload(page, `${name}.json`, {
    prompts: [
      { identifier: "main", name: "Main Prompt", role: "system", content: "Write the scene." },
      { identifier: "extra", name: "Extra", role: "system", content: "HELD-EXPORT-EXTRA" }
    ],
    prompt_order: [
      {
        character_id: 100001,
        order: [
          { identifier: "main", enabled: true },
          { identifier: "extra", enabled: true }
        ]
      }
    ]
  })
  await admin((api) =>
    Effect.gen(function* () {
      const opened = yield* api.OpenEditor({ refId })
      yield* api.SaveEditorDraft({
        refId,
        field: HELD_FIELD,
        draftId: null,
        content: JSON.stringify({ deleted: ["extra"] }),
        expectedRowVersion: null,
        expectedSession: null,
        baseRevisionId: opened.ref.headRevisionId
      })
    })
  )
  await page.goto(`${server().url}/library`)
  await page.getByRole("tab", { name: /^Presets/ }).click()
  await page.getByRole("button", { name: `More actions for ${name}` }).click()
  await page.getByRole("menuitem", { name: "Export…", exact: true }).click()
  await page.getByRole("menuitem", { name: "Preset JSON", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: `${name} has unsaved changes` })
  await expect(dialog.getByRole("list", { name: "Unsaved changes" })).toHaveText(
    "Prompts or lorebooks added, deleted or moved"
  )
  const exported = await downloaded(page, () =>
    dialog.getByRole("button", { name: "Save and export", exact: true }).click()
  )
  expect(JSON.stringify(exported)).not.toContain("HELD-EXPORT-EXTRA")
  const saved = await admin((api) => api.OpenEditor({ refId }))
  expect(saved.doc.prompts).not.toEqual(expect.arrayContaining([expect.objectContaining({ identifier: "extra" })]))
})

test("export asks about a linked note slot's own unsaved fields", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const name = "Linked note export"
  const ref = await importCard(page, name)
  await admin((api) =>
    Effect.gen(function* () {
      const shared = yield* api.CreateSharedNote({ title: "Shared", content: "Shared note text." })
      const slot = yield* api.CreateCardNote({ cardRefId: ref.id, title: "Linked slot", link: shared.entityId })
      const opened = yield* api.OpenEditor({ refId: slot.id })
      yield* api.SaveEditorDraft({
        refId: slot.id,
        field: textField(["title"]),
        draftId: null,
        content: "Changed linked slot title",
        expectedRowVersion: null,
        expectedSession: null,
        baseRevisionId: opened.ref.headRevisionId
      })
    })
  )
  await page.goto(`${server().url}/library`)
  await page.getByRole("button", { name: `More actions for ${name}` }).click()
  await page.getByRole("menuitem", { name: "Export…", exact: true }).click()
  await page.getByRole("menuitem", { name: "V2 JSON", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: `${name} has unsaved changes` })
  await expect(dialog.getByRole("list", { name: "Unsaved changes" })).toContainText("Title")
  const saved = await downloaded(page, () =>
    dialog.getByRole("button", { name: "Save and export", exact: true }).click()
  )
  expect(JSON.stringify(saved)).toContain("Changed linked slot title")
  expect(JSON.stringify(saved)).toContain("Shared note text.")
})

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`Disable all and a prompt added wait unsaved, Revert takes them back (${width}, ${theme})`, async ({
      page
    }) => {
      test.setTimeout(150_000)
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)

      // A book's Disable all: unsaved, no Undo of its own; Revert takes it back.
      const book = await upload(page, `Shoals ${width} ${theme}.json`, {
        name: `Shoals ${width} ${theme}`,
        entries: {
          0: { uid: 0, key: ["reef"], comment: "Reef", content: "The reef shows at low tide.", order: 10 },
          1: { uid: 1, key: ["buoy"], comment: "Buoy", content: "The bell buoy rings in a swell.", order: 20 }
        }
      })
      await page.goto(`${server().url}/library/${book}`)
      await switchAll(page, "Disable all")
      await expect(page.getByText("Disabled all 2 entries", { exact: true })).toBeVisible({ timeout: 30_000 })
      await expect(page.getByRole("button", { name: "Undo", exact: true })).toHaveCount(0)
      await expectSaveState(page, UNSAVED)
      await shoot(page, `lorebook-disable-all-${width}-${theme}`)
      await page.getByRole("button", { name: "Revert", exact: true }).click()
      await expectSaveState(page, NOTHING_TO_SAVE, { timeout: 30_000 })

      // A preset's added prompt waits behind the bar, shown in place.
      const preset = await upload(page, `Tidewater ${width} ${theme}.json`, {
        prompts: [
          { identifier: "main", name: "Main Prompt", system_prompt: true, role: "system", content: "Write the scene." },
          { identifier: "chatHistory", name: "Chat History", system_prompt: true, marker: true }
        ],
        prompt_order: [
          {
            character_id: 100001,
            order: [
              { identifier: "main", enabled: true },
              { identifier: "chatHistory", enabled: true }
            ]
          }
        ]
      })
      await page.goto(`${server().url}/library/${preset}`)
      await page.getByRole("button", { name: "Actions for Main Prompt" }).click()
      await page.getByRole("menuitem", { name: "Insert a prompt below" }).click()
      const bar = page.getByRole("region", { name: "Unsaved changes" })
      await expect(bar).toContainText("1 prompt added")
      await page.getByRole("textbox", { name: "Prompt: New prompt", exact: true }).fill("Keep it brief.")
      await shoot(page, `preset-added-${width}-${theme}`)
      await page.getByRole("button", { name: "Revert", exact: true }).click()
      await expect(bar).toHaveCount(0)
      await expect(page.getByRole("textbox", { name: "Prompt: New prompt", exact: true })).toHaveCount(0)
    })

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`a connection's token counts stay on this server until the user chooses a provider, and say which one gets the text (${width}, ${theme})`, async ({
      page
    }) => {
      test.setTimeout(90_000)
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const settings = (name: string, baseUrl: string) => ({
        name,
        baseUrl,
        compat: {},
        cacheTtlS: null,
        maxConcurrent: null,
        presetOverrideRefId: null
      })
      const connection = await admin((api) =>
        api.CreateConnection({
          kind: "openrouter",
          settings: settings(`Router ${width} ${theme}`, "http://127.0.0.1:9/api/v1")
        })
      )
      const counter = await admin((api) =>
        api.CreateConnection({
          kind: "anthropic",
          settings: settings(`Counter ${width} ${theme}`, "http://127.0.0.1:9")
        })
      )
      await page.goto(`${server().url}/settings/connections/${connection.id}`)
      const picker = page.getByRole("combobox", { name: "Count with" })
      await expect(picker).toHaveText("Local estimate", { timeout: 30_000 })
      await expect(picker).toHaveAccessibleDescription(/^Counted on this server; nothing is sent\./)
      await picker.scrollIntoViewIfNeeded()
      await shoot(page, `connection-counting-${width}-${theme}`)
      await picker.click()
      const another = page.getByRole("option", { name: `Another: Counter ${width} ${theme}` })
      await another.hover()
      // The option's explanation, beside it or under it, names the provider that gets the text.
      await expect(another).toHaveAccessibleDescription(
        /sent to Anthropic \(http:\/\/127\.0\.0\.1:9\) through “Counter/
      )
      // The explanation beside the highlighted option comes after a short delay (ui/Explanation.tsx).
      if (width > 640) await expect(page.locator(".bg-text.text-canvas", { hasText: "through “Counter" })).toBeVisible()
      await shoot(page, `connection-counting-open-${width}-${theme}`)
      await another.click()
      await expect(picker).toHaveText(`Another: Counter ${width} ${theme}`)
      await expect(picker).toHaveAccessibleDescription(
        `The text and images being counted are sent to Anthropic (http://127.0.0.1:9) through “Counter ${width} ${theme}”, under that provider's retention policy. Replies still go to this connection.`
      )
      expect(await admin((api) => api.GetTokenCounting())).toContainEqual({
        connectionId: connection.id,
        via: counter.id
      })
      await shoot(page, `connection-counting-other-${width}-${theme}`)
      await picker.click()
      await page.getByRole("option", { name: "This connection's provider" }).click()
      await expect(picker).toHaveAccessibleDescription(
        /OpenRouter \(http:\/\/127\.0\.0\.1:9\), this connection's provider/
      )
      expect(await admin((api) => api.GetTokenCounting())).toContainEqual({
        connectionId: connection.id,
        via: connection.id
      })
      await picker.click()
      await page.getByRole("option", { name: "Local estimate" }).click()
      await expect(picker).toHaveText("Local estimate")
      expect((await admin((api) => api.GetTokenCounting())).map((c) => c.connectionId)).not.toContain(connection.id)
    })

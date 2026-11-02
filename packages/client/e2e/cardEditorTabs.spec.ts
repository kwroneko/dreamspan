// The card editor in tabs (owner, 2026-11-01), the same in the chat's character tab and the
// full editor: every field in Definition, Greetings, Metadata, Lorebook, Notes and Extra; the
// names renamed in place with the history question asked on confirm (the owner's matrix); the
// token counts; New chat, Export… and the other actions as buttons with explanations; the
// persona's tab as a full card; Add a script on a card that has none. Screenshots at 1440 and
// 390 in both themes go to SCREENSHOT_DIR. Every card here is made up.
import { mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, type Locator, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import type { EntityId } from "@rp/shared/chat.ts"
import type { RefId } from "@rp/shared/library.ts"
import { asUser } from "./support/rpc.ts"
import { saveButton } from "./support/saveRevision.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
test.setTimeout(180_000)

const shots = process.env.SCREENSHOT_DIR
const shoot = async (page: Page, name: string) => {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
  if (!shots) return
  mkdirSync(shots, { recursive: true })
  await page.screenshot({ path: join(shots, `${name}.png`), animations: "disabled" })
}

const importCard = async (page: Page, data: Record<string, unknown>) => {
  const body = Buffer.from(JSON.stringify({ spec: "chara_card_v3", spec_version: "3.0", data }))
  const response = await page.request.post(`${server().url}/library/import?name=card.json`, {
    data: body,
    headers: { origin: server().url, "content-type": "application/octet-stream" }
  })
  expect(response.status()).toBe(200)
  return (await response.json()).library.ref as { id: RefId; entityId: EntityId }
}

const card = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  description: `${name} keeps the tide tables for the harbour and never misses a turn of the water.`,
  personality: "Careful, warm.",
  scenario: "A foggy morning at the harbour office.",
  first_mes: `${name} looks up. "You're early."`,
  mes_example: "<START>\n{{char}}: The tide turns at noon.",
  creator_notes: "Made for testing.",
  system_prompt: "",
  post_history_instructions: "",
  alternate_greetings: [],
  tags: ["harbour"],
  creator: "Synthetic",
  character_version: "1.0",
  extensions: {},
  ...extra
})

/** A chat with the card in it and one message naming it, on a fresh card per test. */
const seed = async (page: Page, name: string, extra: Record<string, unknown> = {}) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const ref = await importCard(page, card(name, extra))
  const persona = await importCard(page, card(`Juniper ${name}`))
  await admin((api) => api.SetPersona({ entityId: persona.entityId, persona: true }))
  const started = await admin((api) =>
    api.StartChat({
      cards: [ref.entityId],
      persona: persona.entityId,
      greeting: null,
      first: { _tag: "Send", content: `${name} waves from the pier.`, speakerEntityId: null }
    })
  )
  return { ref, persona, chat: started.chat }
}

const messages = (chatId: string) =>
  admin((api) =>
    Effect.gen(function* () {
      const chat = yield* api.GetChat({ chatId: chatId as never })
      const path = yield* api.ReadPath({
        chatId: chatId as never,
        forkId: chat.currentForkId!,
        leafSlotId: null,
        range: { _tag: "Bottom" },
        limit: 10
      })
      return path.entries.map((entry) => entry.version.content)
    })
  )

/** The character tab that holds the card's tabs, whatever the cast calls it now. */
const cardTab = (page: Page) => page.getByRole("tabpanel").filter({ has: page.locator('[data-card-tabs="panel"]') })
const subTab = async (scope: Locator, name: string) => {
  await scope.getByRole("tablist", { name: "Card fields" }).getByRole("tab", { name, exact: true }).click()
  return scope.getByRole("tabpanel", { name, exact: true })
}
const rename = async (scope: Locator, which: string, field: string, value: string) => {
  await scope.getByRole("button", { name: `Rename ${which}`, exact: true }).click()
  await scope.getByRole("textbox", { name: field, exact: true }).fill(value)
  await scope.getByRole("textbox", { name: field, exact: true }).press("Enter")
}
const renameNickname = (scope: Locator, value: string) => rename(scope, "the chat name", "Chat name (nickname)", value)
const renameDisplay = (scope: Locator, value: string) => rename(scope, "the display name", "Display name", value)

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`the character tab holds every field in tabs, at ${width} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
      const name = `Mio ${width} ${theme}`
      const { ref, chat } = await seed(page, name, {
        extensions: { chub: { full_path: "synthetic/mio-harbour", id: 1 }, talkativeness: 0.8 },
        source: ["https://example.org/cards/mio"]
      })
      await page.goto(`${server().url}/chats/${chat.id}?panel=card:${ref.entityId}`)
      const tab = cardTab(page)
      await expect(tab.getByRole("tablist", { name: "Card fields" })).toBeVisible({ timeout: 30_000 })
      // The names, without labels on screen, and the token counts.
      await expect(tab.getByRole("heading", { name })).toBeVisible()
      await expect(tab.getByText("Add a chat name", { exact: true })).toBeVisible()
      await expect(tab.getByText("1.0", { exact: true })).toBeVisible()
      await expect(tab.locator("[data-card-tokens]")).toHaveText(/^~\d+ tokens · ~\d+ permanent$/)
      // The actions are buttons, each with its explanation; no More menu.
      await expect(tab.getByRole("link", { name: `New chat with ${name}`, exact: true })).toBeVisible()
      await expect(tab.getByRole("button", { name: `Open ${name} in the full editor`, exact: true })).toBeVisible()
      await expect(tab.getByRole("button", { name: `Fork for this chat: ${name}`, exact: true })).toHaveAttribute(
        "aria-describedby",
        /.+/
      )
      await expect(tab.getByRole("button", { name: "Export…", exact: true })).toBeVisible()
      await expect(tab.getByRole("button", { name: /^More for/ })).toHaveCount(0)
      if (width === 1440) {
        await tab.getByRole("link", { name: `New chat with ${name}`, exact: true }).hover()
        await expect(page.getByText("Start a chat with only them, at their greeting.", { exact: false })).toBeVisible()
      }
      await page.waitForTimeout(300)
      await shoot(page, `panel-definition-${width}-${theme}`)

      // Definition: what goes into the prompt, each with its token count.
      const definition = tab.getByRole("tabpanel", { name: "Definition", exact: true })
      for (const field of [
        "Description",
        "Personality",
        "Scenario",
        "Example messages",
        "System prompt",
        "Post-history instructions"
      ])
        await expect(definition.getByRole("textbox", { name: field, exact: true })).toBeVisible()
      await expect(definition.getByText(/^~\d+ tokens$/)).toHaveCount(6)
      // Counts follow typing.
      const before = await tab.locator("[data-card-tokens]").textContent()
      await definition.getByRole("textbox", { name: "Scenario", exact: true }).click()
      await page.keyboard.press("Control+End")
      await page.keyboard.type(" The fog horn sounds twice, and the gulls go quiet over the water.")
      await expect(tab.locator("[data-card-tokens]")).not.toHaveText(before!)

      const greetings = await subTab(tab, "Greetings")
      await expect(greetings.getByRole("textbox", { name: "First message", exact: true })).toBeVisible()
      await greetings.getByRole("button", { name: "Add a greeting", exact: true }).click()
      await expect(greetings.getByRole("textbox", { name: "Alternate greeting 1", exact: true })).toBeVisible()
      await expect(greetings.getByRole("button", { name: "Add a group greeting", exact: true })).toBeVisible()
      await shoot(page, `panel-greetings-${width}-${theme}`)

      const metadata = await subTab(tab, "Metadata")
      await expect(metadata.getByRole("textbox", { name: "Creator's notes", exact: true })).toBeVisible()
      await expect(metadata.getByRole("list", { name: "Tags" })).toContainText("harbour")
      await expect(metadata.getByRole("textbox", { name: "Creator", exact: true })).toHaveValue("Synthetic")
      await expect(metadata.getByRole("slider", { name: "Talkativeness in group chats" })).toHaveAttribute(
        "aria-valuenow",
        "0.8"
      )
      const chub = metadata.getByRole("link", { name: /chub/i }).first()
      await expect(chub).toHaveAttribute("href", "https://chub.ai/characters/synthetic/mio-harbour")
      await expect(chub).toHaveAttribute("target", "_blank")
      await expect(metadata.getByRole("link", { name: /example\.org/ })).toBeVisible()
      await shoot(page, `panel-metadata-${width}-${theme}`)

      const lorebook = await subTab(tab, "Lorebook")
      await lorebook.getByRole("button", { name: "Add a lorebook", exact: true }).click()
      await expect(lorebook.getByRole("region", { name: `Lorebook ${name}'s lorebook` })).toBeVisible()
      await shoot(page, `panel-lorebook-${width}-${theme}`)

      const notes = await subTab(tab, "Notes")
      await expect(notes.getByText("No notes", { exact: true })).toBeVisible()
      await notes.getByRole("button", { name: "New note", exact: true }).click()
      await expect(notes.getByRole("list", { name: "The card's notes" })).toBeVisible()
      await shoot(page, `panel-notes-${width}-${theme}`)

      // Extra: regex scripts; "Add a script" on a card that has none adds one.
      const extra = await subTab(tab, "Extra")
      await expect(extra.getByText("No regex scripts")).toBeVisible()
      await extra.getByRole("button", { name: "Add a script", exact: true }).click()
      await expect(extra.getByRole("list", { name: "Regex scripts" }).getByRole("listitem")).toHaveCount(1)
      await shoot(page, `panel-extra-${width}-${theme}`)

      // Save and Revert as the pair: what changed goes back to the revision.
      await expect(tab.getByRole("button", { name: "Revert to the last save", exact: true })).toBeVisible()
      await saveButton(tab).click()
      await expect(tab.getByRole("button", { name: "Revert to the last save", exact: true })).toHaveCount(0)
      const revisions = await admin((api) => api.ListRevisions({ refId: ref.id, limit: 50 }))
      expect(revisions.length).toBeGreaterThan(1)
    })

test("a rename asks about past messages on confirm, as the owner's matrix says", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const { ref, chat } = await seed(page, "Mio Tanaka")
  await page.goto(`${server().url}/chats/${chat.id}?panel=card:${ref.entityId}`)
  const tab = cardTab(page)
  await expect(tab.getByRole("tablist", { name: "Card fields" })).toBeVisible({ timeout: 30_000 })
  const dialog = page.getByRole("dialog")

  // Display name changed with no nickname: the three choices. Keep the old name in chats.
  await renameDisplay(tab, "Mio T.")
  await expect(dialog).toHaveAccessibleName("Rename Mio Tanaka to Mio T.?")
  await expect(dialog.getByRole("button", { name: "Just change it", exact: true })).toBeVisible()
  await expect(dialog.getByRole("button", { name: "In all 1 chat", exact: true })).toBeEnabled()
  await shoot(page, "rename-display-1440")
  await dialog.getByRole("button", { name: "Keep “Mio Tanaka” in chats", exact: true }).click()
  await expect(tab.getByRole("heading", { name: "Mio T." })).toBeVisible()
  await expect(tab.getByText("In chat: Mio Tanaka", { exact: true })).toBeVisible()
  expect(await messages(chat.id)).toContain("Mio Tanaka waves from the pier.")

  // Display name changed with a nickname set: nothing asked.
  await renameDisplay(tab, "Mio Tan")
  await expect(tab.getByRole("heading", { name: "Mio Tan" })).toBeVisible()
  await expect(dialog).toHaveCount(0)

  // Nickname changed: closing the question cancels the rename.
  await renameNickname(tab, "Mio")
  await expect(dialog).toHaveAccessibleName("Replace the name in past messages?")
  // The focused answer's explanation shows first; Escape closes it, then the question.
  await page.keyboard.press("Escape")
  await page.keyboard.press("Escape")
  await expect(dialog).toHaveCount(0)
  await expect(tab.getByRole("textbox", { name: "Chat name (nickname)", exact: true })).toHaveValue("Mio")
  await tab.getByRole("button", { name: "Cancel renaming", exact: true }).click()
  await expect(tab.getByText("In chat: Mio Tanaka", { exact: true })).toBeVisible()

  // Nickname changed, replaced in this chat.
  await renameNickname(tab, "Mio")
  await dialog.getByRole("button", { name: "Yes, only in this chat.", exact: true }).click()
  await expect(dialog.getByRole("list", { name: "History diffs and undo" })).toBeVisible()
  await dialog.getByRole("button", { name: "Done", exact: true }).click()
  await expect(tab.getByText("In chat: Mio", { exact: true })).toBeVisible()
  expect(await messages(chat.id)).toContain("Mio waves from the pier.")

  // Nickname cleared while the display name differs: asked; No keeps past messages.
  await renameNickname(tab, "")
  await expect(dialog).toHaveAccessibleName("Replace the name in past messages?")
  await dialog.getByRole("button", { name: "No. Past messages will keep “Mio”.", exact: true }).click()
  await expect(tab.getByText("Add a chat name", { exact: true })).toBeVisible()
  expect(await messages(chat.id)).toContain("Mio waves from the pier.")

  // A first nickname equal to the display name: nothing asked.
  await renameNickname(tab, "Mio Tan")
  await expect(tab.getByText("In chat: Mio Tan", { exact: true })).toBeVisible()
  await expect(dialog).toHaveCount(0)
  await renameNickname(tab, "")
  await expect(tab.getByText("Add a chat name", { exact: true })).toBeVisible()

  // Display name with no nickname again: rename everywhere replaces in all its chats.
  await renameDisplay(tab, "Mio")
  await dialog.getByRole("button", { name: "In all 1 chat", exact: true }).click()
  await expect(dialog.getByRole("status").filter({ hasText: "No matching text was found" })).toBeVisible()
  await dialog.getByRole("button", { name: "Done", exact: true }).click()
  // Just change it: the new name from now on, the history untouched.
  await renameDisplay(tab, "Mira")
  await dialog.getByRole("button", { name: "Just change it", exact: true }).click()
  await expect(tab.getByRole("heading", { name: "Mira" })).toBeVisible()
  expect(await messages(chat.id)).toContain("Mio waves from the pier.")
  // Live text is what's sent: the names are drafts until Save, and the card is renamed.
  await saveButton(tab).click()
  await expect
    .poll(async () => (await admin((api) => api.ListLibrary({ kind: "card" }))).map((r) => r.label))
    .toContain("Mira")
})

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`the full editor has the same names, tabs and actions, at ${width} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
      const name = `Ren ${width} ${theme}`
      const { ref } = await seed(page, name)
      await page.goto(`${server().url}/library/${ref.id}`)
      await expect(page.getByRole("heading", { level: 1, name })).toBeVisible({ timeout: 30_000 })
      await expect(page.getByText("Add a chat name", { exact: true })).toBeVisible()
      await expect(page.locator("[data-card-tokens]")).toHaveText(/^~\d+ tokens · ~\d+ permanent$/)
      // No separate identity section: no labelled Display name box.
      await expect(page.getByRole("textbox", { name: "Display name", exact: true })).toHaveCount(0)
      for (const label of ["Definition", "Greetings", "Metadata", "Lorebook", "Notes", "Extra"])
        await expect(page.getByRole("tab", { name: label, exact: true })).toBeVisible()
      await shoot(page, `editor-definition-${width}-${theme}`)
      await page.getByRole("tab", { name: "Metadata", exact: true }).click()
      await expect(page.getByRole("heading", { name: "Picture" })).toBeVisible()
      await shoot(page, `editor-metadata-${width}-${theme}`)
      // Export… lists the card formats and downloads one.
      await page.getByRole("button", { name: "Export…", exact: true }).click()
      for (const format of ["PNG", "V2 JSON", "V3 JSON", "CHARX"])
        await expect(page.getByRole("menuitem", { name: format })).toBeVisible()
      await shoot(page, `editor-export-${width}-${theme}`)
      const download = page.waitForEvent("download")
      await page.getByRole("menuitem", { name: "V3 JSON" }).click()
      const file = JSON.parse(readFileSync(await (await download).path(), "utf8"))
      expect(file.data.name).toBe(name)
    })

test("export from the character tab downloads the card", async ({ page }) => {
  const { ref, chat } = await seed(page, "Tamsin")
  await page.goto(`${server().url}/chats/${chat.id}?panel=card:${ref.entityId}`)
  const tab = cardTab(page)
  await tab.getByRole("button", { name: "Export…", exact: true }).click()
  const download = page.waitForEvent("download")
  await page.getByRole("menuitem", { name: "V2 JSON" }).click()
  expect((await download).suggestedFilename()).toMatch(/Tamsin/)
})

test("the persona's tab is a full card", async ({ page }) => {
  const { persona, chat } = await seed(page, "Wren")
  await page.goto(`${server().url}/chats/${chat.id}?panel=card:${persona.entityId}`)
  const tab = cardTab(page)
  await expect(tab.getByText("You play", { exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(tab.getByRole("textbox", { name: "Personality", exact: true })).toBeVisible()
  const greetings = await subTab(tab, "Greetings")
  await expect(greetings.getByRole("textbox", { name: "First message", exact: true })).toBeVisible()
  await expect(tab.getByRole("button", { name: /^Fork for this chat/ })).toHaveCount(0)
  await expect(tab.getByRole("button", { name: /Change your persona/ })).toBeVisible()
  await expect(tab.getByRole("button", { name: "Export…", exact: true })).toBeVisible()
})

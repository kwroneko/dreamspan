// Live text is what's sent (owner, 2026-11-01): a chat's note, a card's field and a preset's
// prompt typed in the chat's panel and never saved reach the next request; the reply cuts a
// revision labelled with it, which the editors' state lines then name; Save asks nothing, and
// "Save with a message…" takes a one-line message; a field's edit history puts an earlier
// state back as the newest. The provider is a fake on loopback, and the cards are made up.
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, type Locator, type Page, test } from "@playwright/test"
import type { RefId } from "@rp/shared/library.ts"
import { closePanel, openPanel, panelTab } from "./support/panel.ts"
import { type FakeProvider, startProvider } from "./support/provider.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { textBoxValue } from "./support/textbox.ts"

const server = serverPerFile(withAdmin)
const shots = process.env.SCREENSHOT_DIR
let provider: FakeProvider
let presetRef = ""
let miraRef = ""
let miraEntity = ""

const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)

const shoot = async (page: Page, name: string) => {
  if (!shots) return
  mkdirSync(shots, { recursive: true })
  await page.screenshot({ path: join(shots, `live-text-${name}.png`) })
}

test.beforeAll(async () => {
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
      apiKey: "sk-live-text-key-0042"
    })
  )
  await admin((api) => api.RefreshModels({ connectionId: connection.id }))
  const models = await admin((api) => api.ListModels({ connectionId: connection.id, includeHidden: false }))
  const model = models.find((m) => m.key === "fake-small")!
  const preset = await admin((api) => api.CreatePreset({ label: "Live preset" }))
  presetRef = preset.id
  await admin((api) =>
    api.SetGenerationDefaults({
      defaults: { model: { connection: connection.id, model: model.id }, preset: preset.id as RefId }
    })
  )
  const mira = await admin((api) => api.CreateCard({ label: "Mira", name: "Mira" }))
  miraRef = mira.id
  miraEntity = mira.entityId
})
test.afterAll(async () => {
  await provider.stop()
})

const startChat = (content: string) =>
  admin((api) =>
    api.StartChat({
      cards: [miraEntity as never],
      persona: null,
      greeting: null,
      first: { _tag: "Send", content, speakerEntityId: null }
    })
  ).then((started) => started.chat.id)

/** Sends a message; the reply that follows is generated through the fake provider. */
const send = async (page: Page, text: string) => {
  const before = provider.completions.length
  await page.getByLabel("Message", { exact: true }).fill(text)
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect.poll(() => provider.completions.length, { timeout: 60_000 }).toBe(before + 1)
  return JSON.stringify(provider.completions.at(-1)!.messages)
}

/** Types at the end of a text box (a code editor box or a plain one), as a person does. */
const typeAtEnd = async (page: Page, box: Locator, text: string) => {
  await box.click()
  await page.keyboard.press("Control+End")
  await page.keyboard.insertText(text)
}

for (const width of [1440, 390])
  test(`a note, a card field and a preset prompt are sent as typed, at ${width}`, async ({ page }) => {
    test.setTimeout(300_000)
    await page.setViewportSize({ width, height: 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const chatId = await startChat(`The tide turns at ${width}.`)
    await page.goto(`${server().url}/chats/${chatId}`)
    await expect(page.getByTestId("messages").getByText(`The tide turns at ${width}.`)).toBeVisible()

    // A chat's own note, typed and never saved.
    const notes = await openPanel(page, "Notes")
    await notes
      .getByRole("region", { name: "This chat's notes" })
      .getByRole("button", { name: "New note", exact: true })
      .click()
    const note = notes.getByRole("region", { name: "Note Note" })
    const noteText = `NOTE-LIVE-${width} lanterns along the levee.`
    await note.getByRole("textbox", { name: /^Text of/ }).fill(noteText)
    await expect(note.getByRole("status").filter({ hasText: /revision/ })).toHaveText(/^Changed since revision \d+$/)
    await shoot(page, `note-changed-${width}`)

    // A card's field, in its tab.
    await panelTab(page, "Mira")
    const card = page.getByRole("tabpanel", { name: "Mira", exact: true })
    const description = card.getByRole("textbox", { name: "Description", exact: true })
    await expect(description).toBeVisible({ timeout: 30_000 })
    const cardText = `CARD-LIVE-${width} keeps the ledger.`
    await typeAtEnd(page, description, cardText)
    await expect(card.getByRole("status").filter({ hasText: /revision/ })).toHaveText(/^Changed since revision \d+$/)

    // A preset's prompt, in the Prompt preset tab: text is live, no unsaved bar for it.
    await panelTab(page, "Prompt preset")
    const presetTab = page.getByRole("tabpanel", { name: "Prompt preset", exact: true })
    await presetTab.getByRole("button", { name: "Expand Main Prompt", exact: true }).click()
    const main = presetTab.getByRole("textbox", { name: "Prompt: Main Prompt", exact: true })
    const presetText = ` PRESET-LIVE-${width}.`
    await typeAtEnd(page, main, presetText)
    await expect(presetTab.getByRole("region", { name: "Unsaved changes" })).toHaveCount(0)
    await shoot(page, `preset-changed-${width}`)
    if (width === 390) await closePanel(page)

    // The next reply sends all three as typed, though none was saved.
    const sent = await send(page, "What does the ledger say?")
    expect(sent).toContain(noteText)
    expect(sent).toContain(cardText)
    expect(sent).toContain(presetText.trim())

    // The reply cut a revision of each, which the editors now name.
    const revisions = await admin((api) => api.ListRevisions({ refId: miraRef as RefId, limit: 10 }))
    expect(revisions[0]!.origin).toBe("generation")
    expect(revisions[0]!.usedBy?.chatId).toBe(chatId)
    await openPanel(page, "Mira")
    await expect(card.getByRole("status").filter({ hasText: /revision/ })).toHaveText(
      `Saved as revision ${revisions[0]!.number}`
    )
    await panelTab(page, "Prompt preset")
    await expect(presetTab.getByRole("status").filter({ hasText: /revision/ })).toHaveText(/^Saved as revision \d+$/)
    // The phone's sheet was closed for the reply: its blocks start closed again.
    if (!(await main.isVisible()))
      await presetTab.getByRole("button", { name: "Expand Main Prompt", exact: true }).click()

    // Save asks nothing; "Save with a message…" takes one line, Enter saving it.
    await typeAtEnd(page, main, " Typed after the reply.")
    await expect(presetTab.getByRole("status").filter({ hasText: /revision/ })).toHaveText(/^Changed since/)
    await presetTab.getByRole("button", { name: "Save with a message…", exact: true }).click()
    await presetTab.getByRole("textbox", { name: "Revision message", exact: true }).fill(`Tidied at ${width}`)
    await shoot(page, `save-with-message-${width}`)
    await page.keyboard.press("Enter")
    await expect(presetTab.getByRole("status").filter({ hasText: /revision/ })).toHaveText(/^Saved as revision \d+$/)
    await expect(page.getByRole("dialog", { name: "Changed meanwhile" })).toHaveCount(0)
    const saved = await admin((api) => api.ListRevisions({ refId: presetRef as RefId, limit: 1 }))
    expect(saved[0]!.message).toBe(`Tidied at ${width}`)
    expect(saved[0]!.origin).toBe("user")

    // The card's edit history: every state past the revisions, an earlier one put back as the newest.
    await openPanel(page, "Mira")
    await typeAtEnd(page, description, ` A second thought at ${width}.`)
    await card.getByRole("button", { name: "Save", exact: true }).click()
    await expect(page.getByRole("dialog", { name: "Changed meanwhile" })).toHaveCount(0)
    await card.getByRole("button", { name: "Edit history of Description", exact: true }).click()
    const history = page.getByRole("dialog", { name: "Edit history: Description" })
    await expect(history.getByRole("list", { name: "Earlier states" }).getByRole("listitem")).not.toHaveCount(0)
    const earlier = history.getByRole("list", { name: "Earlier states" }).getByRole("button").nth(1)
    await earlier.click()
    await expect(history.getByLabel("Text of the state")).toContainText(cardText)
    await shoot(page, `edit-history-${width}`)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
    await history.getByRole("button", { name: "Put this text in the box", exact: true }).click()
    await expect(history).toHaveCount(0)
    await expect.poll(() => textBoxValue(description)).not.toContain(`A second thought at ${width}.`)
    expect(await textBoxValue(description)).toContain(cardText)

    // Revert, beside Save while something changed: one click, no question, the field back to the
    // revision, and what was there kept in its edit history.
    const status = card.getByRole("status").filter({ hasText: /revision/ })
    await expect(status).toHaveText(/^Changed since revision \d+$/)
    const revert = card.getByRole("button", { name: /^Revert to revision \d+$/ })
    await shoot(page, `revert-${width}`)
    await revert.click()
    await expect(status).toHaveText(/^Saved as revision \d+$/)
    await expect(revert).toHaveCount(0)
    await expect(page.getByRole("alertdialog")).toHaveCount(0)
    await expect.poll(() => textBoxValue(description)).toContain(`A second thought at ${width}.`)
    await card.getByRole("button", { name: "Edit history of Description", exact: true }).click()
    const kept = page.getByRole("dialog", { name: "Edit history: Description" })
    await kept.getByRole("list", { name: "Earlier states" }).getByRole("button").nth(1).click()
    await expect(kept.getByLabel("Text of the state")).not.toContainText(`A second thought at ${width}.`)
    await kept.getByRole("button", { name: "Close", exact: true }).click()
  })

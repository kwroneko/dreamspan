// A chat's notes (DESIGN §4.1), through real generation: a note made in the chat, turned on
// at the latest message, reaches the request the provider receives, and stops reaching it
// once turned off; a card's note is edited as the card's. The provider is a fake on
// loopback, and the cards are made up.
import { openPanel, panelTab } from "./support/panel.ts"
import { expect, type Page, test } from "@playwright/test"
import { textField } from "@rp/shared/editing.ts"
import { Effect } from "effect"
import type { RefId } from "@rp/shared/library.ts"
import { type FakeProvider, startProvider } from "./support/provider.ts"
import { asUser } from "./support/rpc.ts"
import { NOTHING_TO_SAVE, expectSaveState, saveRevision } from "./support/saveRevision.ts"
import { expectTextBox } from "./support/textbox.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
let provider: FakeProvider
let chatId = ""

const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)

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
      apiKey: "sk-notes-test-key-0042"
    })
  )
  await admin((api) => api.RefreshModels({ connectionId: connection.id }))
  const models = await admin((api) => api.ListModels({ connectionId: connection.id, includeHidden: false }))
  const model = models.find((m) => m.key === "fake-small")!
  await admin((api) =>
    api.SetGenerationDefaults({ defaults: { model: { connection: connection.id, model: model.id }, preset: null } })
  )
  const mira = await admin((api) => api.CreateCard({ label: "Mira", name: "Mira" }))
  await admin((api) => api.CreateCardNote({ cardRefId: mira.id as RefId, title: "Outfit" }))
  const started = await admin((api) =>
    api.StartChat({
      cards: [mira.entityId],
      persona: null,
      greeting: null,
      first: { _tag: "Send", content: "The river is rising.", speakerEntityId: null }
    })
  )
  chatId = started.chat.id
})
test.afterAll(async () => {
  await provider.stop()
})

/** Sends a message; the reply that follows is generated through the fake provider. */
const send = async (page: Page, text: string) => {
  const before = provider.completions.length
  await page.getByLabel("Message", { exact: true }).fill(text)
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect.poll(() => provider.completions.length).toBe(before + 1)
  await expect(page.getByText("The bridge holds.").last()).toBeVisible()
  return JSON.stringify(provider.completions.at(-1)!.messages)
}

test("a note made in the chat goes into the request once on, and out once off", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chatId}`)
  await expect(page.getByText("The river is rising.")).toBeVisible()

  await openPanel(page, "Notes")
  const dialog = page.getByRole("tabpanel", { name: "Notes" })
  await dialog
    .getByRole("region", { name: "This chat's notes" })
    .getByRole("button", { name: "Add note", exact: true })
    .click()
  const editor = dialog.getByRole("region", { name: "Note Note" })
  await editor.getByRole("textbox", { name: /^Text of/ }).fill("Lanterns burn along the levee.")
  // No frequency: a note goes every turn (DESIGN §4.1).
  await expect(editor.getByRole("spinbutton")).toHaveCount(0)
  await saveRevision(editor)
  await expectSaveState(editor, NOTHING_TO_SAVE)
  const storedChat = await admin((api) => api.GetChat({ chatId: chatId as never }))
  const storedNotes = await admin((api) =>
    api.ListChatNotes({ chatId: storedChat.id, slotId: storedChat.activeLeafSlotId })
  )
  expect(
    storedNotes.find((note) => note.doc.content === "Lanterns burn along the levee.")?.doc.interval
  ).toBeUndefined()
  // Made here, it's on from here.
  const own = dialog.getByRole("region", { name: "This chat's notes" })
  await expect(own.getByRole("switch", { name: "Note: on in this chat" })).toBeChecked()
  // Mira's note is hers: her group says so, and it isn't deleted from here. With two notes, both are open.
  const hers = dialog.getByRole("region", { name: "Mira's notes" })
  await expect(hers.getByRole("button", { name: "Collapse Outfit" })).toBeVisible()
  await expect(hers.getByText("what you change here changes them in every chat with Mira")).toHaveCount(0)
  await hers.getByRole("button", { name: "Actions for Outfit" }).click()
  await expect(page.getByRole("menuitem", { name: "Delete the note" })).toHaveCount(0)
  await page.keyboard.press("Escape")

  // The panel stays open beside the chat while sending.
  expect(await send(page, "Is the levee holding?")).toContain("Lanterns burn along the levee.")

  await own.getByRole("switch", { name: "Note: on in this chat" }).click()
  await expect(own.getByRole("switch", { name: "Note: on in this chat" })).not.toBeChecked()
  expect(await send(page, "And now?")).not.toContain("Lanterns burn")
})

test("the notes fit a phone, under the Content-Security-Policy", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const page = await context.newPage()
  const violations: Array<string> = []
  page.on("console", (message) => {
    if (message.text().includes("Content Security Policy")) violations.push(message.text())
  })
  await apiLogin(context.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chatId}`)
  // A phone opens the panel as a sheet over the chat.
  await page.getByRole("button", { name: "Chat panel" }).click()
  await panelTab(page, "Notes")
  const hers = page.getByRole("tabpanel", { name: "Notes" }).getByRole("region", { name: "Mira's notes" })
  await expect(hers.getByRole("textbox", { name: /^Text of Outfit/ })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
  expect(violations).toEqual([])
  await context.close()
})

test("an open Notes tab follows another connection's State changes", async ({ page }) => {
  const note = await admin((api) => api.CreateChatNote({ chatId: chatId as never, title: "Remote" }))
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chatId}`)
  await openPanel(page, "Notes")
  const toggle = page.getByRole("tabpanel", { name: "Notes" }).getByRole("switch", { name: "Remote" })
  await expect(toggle).not.toBeChecked()
  const chat = await admin((api) => api.GetChat({ chatId: chatId as never }))
  for (const active of [true, false]) {
    await admin((api) =>
      api.ChangeCast({
        chatId: chat.id,
        slotId: chat.activeLeafSlotId,
        change: { _tag: "Note", entityId: note.entityId, active }
      })
    )
    if (active) await expect(toggle).toBeChecked()
    else await expect(toggle).not.toBeChecked()
  }
})

test("editing at a displayed leaf keeps the sibling branch's note revision", async ({ page }) => {
  const { chat, left, leftFork, rightFork, note } = await admin((api) =>
    Effect.gen(function* () {
      const card = yield* api.CreateCard({ label: "Branch Mira", name: "Mira" })
      const start = yield* api.StartChat({
        cards: [card.entityId],
        persona: null,
        greeting: null,
        first: { _tag: "Send", content: "Before the fork.", speakerEntityId: null }
      })
      const note = yield* api.CreateChatNote({ chatId: start.chat.id, title: "Weather" })
      const field = textField(["content"])
      const draft = yield* api.SaveEditorDraft({
        refId: note.id,
        field,
        draftId: null,
        content: "RAIN",
        expectedRowVersion: null,
        expectedSession: null,
        baseRevisionId: note.headRevisionId
      })
      yield* api.CommitEditorDrafts({
        refId: note.id,
        expectedRowVersion: note.rowVersion,
        fields: [{ field, draftId: draft.id, expectedRowVersion: draft.rowVersion }],
        message: null
      })
      yield* api.ChangeCast({
        chatId: start.chat.id,
        slotId: start.entry.slotId,
        change: { _tag: "Note", entityId: note.entityId, active: true }
      })
      const left = yield* api.SendMessage({
        chatId: start.chat.id,
        parentSlotId: start.entry.slotId,
        branch: false,
        content: "Left."
      })
      const right = yield* api.SendMessage({
        chatId: start.chat.id,
        parentSlotId: start.entry.slotId,
        branch: true,
        content: "Right."
      })
      if (left._tag !== "Posted" || right._tag !== "Posted") throw new Error("synthetic messages queued")
      return {
        chat: start.chat,
        left: left.entry.slotId,
        leftFork: left.chat.currentForkId!,
        rightFork: right.chat.currentForkId!,
        note
      }
    })
  )
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const editor = page.getByRole("region", { name: "Note Weather" })
  const openAt = async (fork: string) => {
    // A link can open the panel at a tab.
    await page.goto(`${server().url}/chats/${chat.id}?fork=${fork}&panel=notes`)
    // One note: it's open.
    await expect(page.getByRole("button", { name: "Collapse Weather" })).toBeVisible()
  }
  await openAt(leftFork)
  await expectTextBox(editor.getByRole("textbox", { name: "Text of Weather" }), "RAIN")
  await editor.getByRole("textbox", { name: "Text of Weather" }).fill("SUN")
  await saveRevision(editor)
  await expectSaveState(editor, NOTHING_TO_SAVE)
  const listed = await admin((api) => api.ListChatNotes({ chatId: chat.id, slotId: left }))
  expect(listed.find((n) => n.ref.id === note.id)?.doc.content).toBe("SUN")
  await openAt(rightFork)
  await expectTextBox(editor.getByRole("textbox", { name: "Text of Weather" }), "RAIN")
  await openAt(leftFork)
  await expectTextBox(editor.getByRole("textbox", { name: "Text of Weather" }), "SUN")
})

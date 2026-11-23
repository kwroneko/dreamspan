// The request inspector's source links land on the exact item (owner, 2026-11-23): a preset
// prompt opens the preset editor on that prompt, a lorebook entry its book on that entry, a
// card field the card editor on that field, a note the chat's Notes tab on that note; each is
// open, scrolled into view and flashed, and the place is the URL's, so a reload lands again.
// Against the production server and a fake OpenAI-compatible provider; everything is made up.
import { readFileSync } from "node:fs"
import type { ChatId, VersionId } from "@dreamspan/shared/chat.ts"
import { textField } from "@dreamspan/shared/editing.ts"
import { expect, type Locator, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { type FakeProvider, startProvider } from "./support/provider.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { scrollUntil } from "./support/scrollPane.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
let provider: FakeProvider
let chat: { readonly id: ChatId; readonly reply: VersionId }

// ST's default preset with text in its later prompts, so the one linked to is far down the editor.
const preset = (() => {
  const file = JSON.parse(
    readFileSync(new URL("../../server/test/fixtures/presets/default.json", import.meta.url), "utf8")
  ) as { prompts: Array<{ identifier: string; content?: string }> }
  for (const prompt of file.prompts) {
    if (prompt.identifier === "jailbreak") prompt.content = "Keep the harbor town in every scene."
    if (prompt.identifier === "nsfw") prompt.content = "Gulls are always nearby."
  }
  return file
})()

// A book whose sent entry is its last of twelve, below the others.
const book = {
  name: "Tides",
  entries: Object.fromEntries(
    Array.from({ length: 12 }, (_, uid) => [
      uid,
      uid === 11
        ? { uid, key: ["fog"], comment: "Fog", content: "Fog rolls in at dusk.", order: 100, constant: true }
        : { uid, key: [`mooring-${uid}`], comment: `Mooring ${uid}`, content: `Mooring ${uid} is empty.`, order: uid }
    ])
  )
}

const upload = async (name: string, data: unknown) => {
  const login = await fetch(`${server().url}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(ADMIN)
  })
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!
  const response = await fetch(`${server().url}/library/import?name=${encodeURIComponent(name)}.json`, {
    method: "POST",
    headers: { origin: server().url, cookie, "content-type": "application/octet-stream" },
    body: JSON.stringify(data)
  })
  expect(response.status).toBe(200)
}

test.beforeAll(async () => {
  provider = await startProvider()
  await upload("Harbor preset", preset)
  await upload("Tides", book)
  await upload("Mira", {
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: {
      name: "Mira",
      description: "{{char}} keeps the harbor ledger.",
      personality: "Patient.",
      scenario: "A flooded harbor town.",
      first_mes: "*Mira looks up.*"
    }
  })
  chat = await admin((api) =>
    Effect.gen(function* () {
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: "Local model server",
          baseUrl: provider.baseUrl,
          compat: {},
          cacheTtlS: 300,
          maxConcurrent: null,
          presetOverrideRefId: null
        },
        apiKey: "sk-source-links-test-0042"
      })
      const model = yield* api.AddUserModel({ connectionId: connection.id, key: "fake-small", overrides: {} })
      const harbor = (yield* api.ListLibrary({ kind: "preset" })).find((r) => r.label === "Harbor preset")!
      yield* api.SetGenerationDefaults({
        defaults: { model: { connection: connection.id, model: model.id }, preset: harbor.id }
      })
      const tides = (yield* api.ListLibrary({ kind: "lorebook" })).find((r) => r.label === "Tides")!
      const mira = (yield* api.ListCards()).find((card) => card.label === "Mira")!
      const started = yield* api.StartChat({
        cards: [mira.entityId],
        persona: null,
        greeting: 0,
        first: { _tag: "Send", content: "The road flooded.", speakerEntityId: null }
      })
      yield* api.ChangeCast({
        chatId: started.chat.id,
        slotId: null,
        change: { _tag: "Lorebook", ref: tides.id, active: true }
      })
      // The chat's own note, with text, so it's sent.
      const note = yield* api.CreateChatNote({ chatId: started.chat.id, title: "Weather" })
      const field = textField(["content"])
      const draft = yield* api.SaveEditorDraft({
        refId: note.id,
        field,
        draftId: null,
        content: "It is raining.",
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
        chatId: started.chat.id,
        slotId: null,
        change: { _tag: "Note", entityId: note.entityId, active: true }
      })
      const reply = yield* api.Generate({ chatId: started.chat.id, parentSlotId: started.entry.slotId, branch: false })
      if (reply._tag !== "Posted") return yield* Effect.die(new Error("the reply was queued"))
      return { id: started.chat.id, reply: reply.entry.version.id }
    })
  )
})
test.afterAll(async () => {
  await provider.stop()
})

/** Opens the reply's inspector and the source link named `name`, after checking where its hover says it goes. */
const follow = async (page: Page, name: string, hint: string) => {
  await page.goto(`${server().url}/chats/${chat.id}/context/${chat.reply}`)
  const messages = page.getByRole("region", { name: "Messages" })
  const link = await scrollUntil(messages, messages.getByRole("link", { name, exact: true }).first())
  await link.scrollIntoViewIfNeeded()
  await link.hover()
  await expect(page.locator('[data-layout-overlay="Tooltip floats above the page"]')).toHaveText(hint)
  await link.click()
}

/** In view and flashed once it lands; and again after a reload, from the URL alone. */
const expectLanded = async (page: Page, item: () => Locator, flashed: () => Locator) => {
  await expect(item()).toBeInViewport()
  await expect(flashed()).toHaveAttribute("data-flashing", "")
  await page.reload()
  await expect(item()).toBeInViewport()
}

for (const width of [1440, 390]) {
  test.describe(`at ${width}px`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width, height: width < 600 ? 844 : 900 })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    })

    test("a preset prompt's link opens the preset editor on that prompt, open and flashed", async ({ page }) => {
      await follow(page, "Preset prompt “Post-History Instructions”", "Opens this prompt in the preset editor.")
      await expect(page).toHaveURL(/\/library\/[^?]+\?focus=jailbreak$/)
      const block = () => page.locator('[data-prompt="jailbreak"]')
      // Open: its text's editor shows.
      const text = () => block().getByRole("textbox").first()
      await expect(text()).toContainText("Keep the harbor town in every scene.")
      await expectLanded(page, text, block)
    })

    test("a lorebook entry's link opens the book on that entry, open, focused and flashed", async ({ page }) => {
      await follow(page, "Lorebook “Tides”: entry 11 “Fog”", "Opens this entry in the lorebook editor.")
      await expect(page).toHaveURL(/\/library\/[^?]+\?entries.*entry=%2211%22/)
      const title = () => page.getByRole("textbox", { name: "Title of Fog" })
      await expect(title()).toBeFocused()
      // Open: its text shows; the other entries stay folded.
      const content = page.getByRole("textbox", { name: "Entry content" })
      await expect(content).toHaveCount(1)
      await expect(content).toContainText("Fog rolls in at dusk.")
      await expectLanded(page, title, () => page.locator("[role=listitem] > *").filter({ has: title() }))
      await expect(title()).toBeFocused()
    })

    test("a card field's link opens the card editor on that field, its caret there and flashed", async ({ page }) => {
      await follow(page, "Card “Mira”: scenario", "Opens this field in the card editor.")
      await expect(page).toHaveURL(/\/library\/[^?]+\?at=/)
      const field = () => page.getByRole("textbox", { name: "Scenario" })
      await expect(field()).toBeFocused()
      await expectLanded(page, field, () => page.locator("[data-field-frame]").filter({ has: field() }))
      await expect(field()).toBeFocused()
    })

    test("a note's link opens the chat's Notes tab on that note, open and flashed", async ({ page }) => {
      await follow(page, "Note “Weather”", "Opens this note in the chat's Notes tab.")
      await expect(page).toHaveURL(/panel=notes/)
      await expect(page).toHaveURL(/note=/)
      const note = () => page.getByRole("listitem").filter({ hasText: "Weather" }).first()
      const text = () => note().getByRole("textbox").first()
      await expect(text()).toContainText("It is raining.")
      await expectLanded(page, text, () => page.locator("[data-flashing]").filter({ hasText: "Weather" }))
    })
  })
}

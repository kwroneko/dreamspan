// A plain open of the request inspector in the tabbed workbench (owner, 2026-11-23: "it opens in
// a new internal tab by default"): with no inspector showing, a new italic tab beside the chat's,
// the chat's tab never navigated away, a second open replacing the italic inspector; with an
// inspector showing in another frame, there; on a phone, in place with Back returning. Each path:
// the message's ⋯ item, its pinned button, the context chip's View request and a chat not sent
// yet's first request. Synthetic provider and data only.
import { expect, type Locator, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { showActions } from "./support/message.ts"
import { REPLY, type FakeProvider, startProvider } from "./support/provider.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const LABEL = "Open request inspector"
const INSPECTOR = "The request a reply was generated from"
let provider: FakeProvider
let entityId: string

test.beforeAll(async () => {
  provider = await startProvider()
  entityId = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: "Synthetic inspector tab",
          baseUrl: provider.baseUrl,
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        }
      })
      const model = yield* api.AddUserModel({ connectionId: connection.id, key: "fake-small", overrides: {} })
      yield* api.ChangeGenerationDefaults({ change: { model: { connection: connection.id, model: model.id } } })
      const card = yield* api.CreateCard({ label: "Tovi", name: "Tovi", description: "Tovi mends nets." })
      return card.entityId
    })
  )
})
test.afterAll(async () => {
  await provider.stop()
})

const chatWithReplies = async (page: Page, title: string, count: number) => {
  const chat = await asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.CreateChat({ title }))
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chat.id}`)
  for (let i = 1; i <= count; i++) {
    await page.getByRole("button", { name: "Generate", exact: true }).click()
    await expect(page.getByRole("article")).toHaveCount(i)
    await expect(
      page
        .getByRole("article")
        .nth(i - 1)
        .locator(".markdown")
        .last()
    ).toHaveText(REPLY)
    await expect(page.getByText("generating", { exact: true })).toHaveCount(0)
  }
  return chat
}

const inspect = async (reply: Locator) => {
  await showActions(reply)
  await reply.getByRole("button", { name: "More actions", exact: true }).click()
  await reply.page().getByRole("menuitem", { name: LABEL, exact: true }).click()
}

const tabsOf = (page: Page) => page.getByRole("tablist", { name: "Open tabs", exact: true }).getByRole("tab")

/** The chat's tab is still there, and the strip has it and one italic inspector beside it. */
const expectChatAndInspector = async (page: Page, chatTitle: RegExp, inspectorHeading: string) => {
  await expect(page.getByRole("heading", { name: inspectorHeading })).toBeVisible()
  const tabs = tabsOf(page)
  await expect(tabs).toHaveCount(2)
  await expect(tabs.nth(0)).toHaveText(chatTitle)
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true")
  await expect(page.locator("[data-tab][data-preview]")).toHaveCount(1)
  await expect(page.locator("[data-frame]")).toHaveCount(1)
}

test("each plain open makes an inspector tab beside the chat, never replacing it, at 1440", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await chatWithReplies(page, "Inspector tab chat", 2)
  const chatTitle = /Inspector tab chat/
  const replies = page.getByRole("article")

  // The message's ⋯ item.
  await inspect(replies.nth(0))
  await expectChatAndInspector(page, chatTitle, INSPECTOR)
  const first = page.url()

  // A second open replaces the italic inspector, not the chat.
  await tabsOf(page).nth(0).click()
  await inspect(replies.nth(1))
  await expectChatAndInspector(page, chatTitle, INSPECTOR)
  expect(page.url()).not.toBe(first)
  expect(page.url()).toMatch(/\/context\//)

  // The pinned button.
  await tabsOf(page).nth(0).click()
  await showActions(replies.nth(0))
  await replies.nth(0).getByRole("button", { name: "More actions", exact: true }).click()
  await page.getByRole("menuitemcheckbox", { name: `Show ${LABEL} on the message`, exact: true }).click()
  await page.keyboard.press("Escape")
  await showActions(replies.nth(0))
  await replies.nth(0).getByRole("link", { name: LABEL, exact: true }).click()
  await expectChatAndInspector(page, chatTitle, INSPECTOR)
  await expect(page).toHaveURL(first)

  // The context chip's View request (the chat's next request).
  await tabsOf(page).nth(0).click()
  await expect(replies).toHaveCount(2)
  await page.getByRole("button", { name: /^Context: about / }).click()
  await page.getByRole("dialog", { name: "Context" }).getByRole("link", { name: "View request" }).click()
  await expect(page).toHaveURL(/\/request\/next/)
  await expect(tabsOf(page)).toHaveCount(2)
  await expect(tabsOf(page).nth(0)).toHaveText(chatTitle)
  await expect(page.locator("[data-tab][data-preview]")).toHaveCount(1)

  // The chat's tab still shows the chat.
  await tabsOf(page).nth(0).click()
  await expect(replies).toHaveCount(2)
})

test("a chat not sent yet's first request opens beside it, the draft kept, at 1440", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/cards/${entityId}/chat`)
  const box = page.getByRole("textbox", { name: "Message", exact: true })
  await box.fill("The nets are dry.")
  await page.getByRole("button", { name: /^Context: about [\d,]+ of [\d,]+ tokens in your first request/ }).click()
  await page.getByRole("dialog", { name: "Context" }).getByRole("link", { name: "View request" }).click()
  await expect(page.getByRole("heading", { name: "Your first request" })).toBeVisible()
  const tabs = tabsOf(page)
  await expect(tabs).toHaveCount(2)
  await expect(tabs.nth(1)).toHaveText(/Your first request/)
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true")
  await tabs.nth(0).click()
  await expect(box).toBeVisible()
  await expect(box).toContainText("The nets are dry.")
})

test("with an inspector showing in another frame, a plain open goes there at 1440", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await chatWithReplies(page, "Inspector split chat", 2)
  const frames = page.locator("[data-frame]")
  const chatFrame = frames.first()
  const replies = chatFrame.getByRole("article")
  await showActions(replies.nth(0))
  await replies.nth(0).getByRole("button", { name: "More actions", exact: true }).click()
  await page.getByRole("menuitem", { name: LABEL, exact: true }).click({ button: "right" })
  await page.getByRole("menuitem", { name: "Open beside", exact: true }).click()
  await expect(frames).toHaveCount(2)
  const first = page.url()

  await inspect(replies.nth(1))
  await expect(page).not.toHaveURL(first)
  await expect(page).toHaveURL(/\/context\//)
  await expect(frames).toHaveCount(2)
  await expect(frames.nth(1).getByRole("heading", { name: INSPECTOR })).toBeVisible()
  await expect(chatFrame.locator("[data-tab]")).toHaveCount(1)
  await expect(replies).toHaveCount(2)
})

test("on a phone the inspector opens in place and Back returns at 390", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 })
  await chatWithReplies(page, "Inspector phone chat", 1)
  await inspect(page.getByRole("article").first())
  await expect(page).toHaveURL(/\/context\//)
  await expect(page.getByRole("heading", { name: INSPECTOR })).toBeVisible()
  await expect(page.locator("[data-frame]")).toHaveCount(1)
  await page.goBack()
  await expect(page.getByRole("article").first().locator(".markdown").last()).toHaveText(REPLY)
})

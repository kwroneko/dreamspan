// The request inspector beside a chat (owner, 2026-11-23): a link's open menu on Open request
// inspector (Open, Open beside, Open in a new browser tab), and the inspector's kind opening
// where an inspector is showing, so the chat keeps its frame. Phones are unchanged. Synthetic
// provider and data only.
import { expect, type Locator, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { showActions } from "./support/message.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { REPLY, type FakeProvider, startProvider } from "./support/provider.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const LABEL = "Open request inspector"
// Each item's text, its explanation under it where the window shows it so.
const OPEN = /^Open(?! beside| in)/
const BESIDE = /^Open beside/
const NEW_TAB = /^Open in a new browser tab/
let provider: FakeProvider

test.beforeAll(async () => {
  provider = await startProvider()
  await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: "Synthetic inspector pane",
          baseUrl: provider.baseUrl,
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        }
      })
      const model = yield* api.AddUserModel({ connectionId: connection.id, key: "fake-small", overrides: {} })
      yield* api.ChangeGenerationDefaults({ change: { model: { connection: connection.id, model: model.id } } })
    })
  )
})
test.afterAll(async () => {
  await provider.stop()
})

/** A chat with `count` generated replies, open. */
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

/** Right-clicks Open request inspector in `reply`'s More actions menu: its open menu. */
const openMenuOf = async (reply: Locator) => {
  const page = reply.page()
  await showActions(reply)
  await reply.getByRole("button", { name: "More actions", exact: true }).click()
  await page.getByRole("menuitem", { name: LABEL, exact: true }).click({ button: "right" })
  const menu = page.getByRole("menu", { name: `Actions for ${LABEL}`, exact: true })
  await expect(menu).toBeVisible()
  return menu
}

const inspect = async (reply: Locator) => {
  await showActions(reply)
  await reply.getByRole("button", { name: "More actions", exact: true }).click()
  await reply.page().getByRole("menuitem", { name: LABEL, exact: true }).click()
}

test("the inspector opens beside the chat and takes turns there at 1440", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await chatWithReplies(page, "Inspector pane", 3)
  const frames = page.locator("[data-frame]")
  const chatFrame = frames.first()
  const replies = chatFrame.getByRole("article")

  // The pinned button has the same menu (checked first, while the chat has the whole width).
  await showActions(replies.nth(0))
  await replies.nth(0).getByRole("button", { name: "More actions", exact: true }).click()
  await page.getByRole("menuitemcheckbox", { name: `Show ${LABEL} on the message`, exact: true }).click()
  await page.keyboard.press("Escape")
  await showActions(replies.nth(0))
  await replies.nth(0).getByRole("link", { name: LABEL, exact: true }).click({ button: "right" })
  const pinnedMenu = page.getByRole("menu", { name: `Actions for ${LABEL}`, exact: true })
  await expect(pinnedMenu.getByRole("menuitem")).toHaveText([OPEN, BESIDE, NEW_TAB])
  await page.keyboard.press("Escape")

  // The ⋯ item's right-click menu: the chat rows' three items, each explained.
  const menu = await openMenuOf(replies.nth(0))
  await expect(menu.getByRole("menuitem")).toHaveText([OPEN, BESIDE, NEW_TAB])
  await menu.getByRole("menuitem", { name: "Open beside", exact: true }).hover()
  await expect(
    page
      .locator("[data-explanation]")
      .getByText("Opens it in the frame on the right, adding one if there's none. Alt-click a link to do the same.")
  ).toBeVisible()
  await expectLayout(page, info, "inspector-link-menu-1440", { scope: '[role="menu"]' })
  await menu.getByRole("menuitem", { name: "Open beside", exact: true }).click()

  await expect(frames).toHaveCount(2)
  const inspector = frames.nth(1)
  await expect(inspector.getByRole("heading", { name: "The request a reply was generated from" })).toBeVisible()
  await expect(inspector.locator("[data-tab]")).toHaveCount(1)
  await expect(inspector.locator("[data-tab][data-preview]")).toHaveCount(0)
  await expect(page).toHaveURL(/\/context\//)
  const first = page.url()

  // Kept: inspecting another reply opens an italic tab next to it, in the inspector's frame.
  await inspect(replies.nth(1))
  await expect(inspector.locator("[data-tab]")).toHaveCount(2)
  await expect(inspector.locator("[data-tab][data-preview]")).toHaveCount(1)
  await expect(page).toHaveURL(/\/context\//)
  const second = page.url()
  expect(second).not.toBe(first)
  // The chat's frame is untouched: its one tab, the chat, still shown.
  await expect(chatFrame.locator("[data-tab]")).toHaveCount(1)
  await expect(replies).toHaveCount(3)

  // Italic: the next one replaces it.
  await inspect(replies.nth(2))
  await expect(page).not.toHaveURL(second)
  await expect(page).toHaveURL(/\/context\//)
  await expect(inspector.locator("[data-tab]")).toHaveCount(2)
  await expect(inspector.locator("[data-tab][data-preview]")).toHaveCount(1)
  await expect(chatFrame.locator("[data-tab]")).toHaveCount(1)
  await expect(replies).toHaveCount(3)
  await expect(frames).toHaveCount(2)
  // The strips this changes; the inspector page itself is not (its Usage table at half width is its own).
  await expectLayout(page, info, "inspector-pane-1440", { scope: "[data-tab-strip]" })
})

test("phones keep opening the inspector in place at 390", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 900 })
  await chatWithReplies(page, "Inspector phone", 1)
  const reply = page.getByRole("article").first()
  const menu = await openMenuOf(reply)
  // No frames side by side here: no Open beside.
  await expect(menu.getByRole("menuitem")).toHaveText([OPEN, NEW_TAB])
  await expectLayout(page, info, "inspector-link-menu-390", { scope: '[role="menu"]' })
  await menu.getByRole("menuitem", { name: "Open", exact: true }).click()
  await expect(page).toHaveURL(/\/context\//)
  await expect(page.getByRole("heading", { name: "The request a reply was generated from" })).toBeVisible()
  await expect(page.locator("[data-frame]")).toHaveCount(1)
  await page.goBack()
  await expect(page.getByRole("article").first().locator(".markdown").last()).toHaveText(REPLY)
})

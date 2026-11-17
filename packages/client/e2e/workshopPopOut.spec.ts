// A workshop opened from a story's side panel opens beside the story, never in its place (owner,
// 2026-11-17), and a workshop links back to the story it's about wherever it's shown as a chat:
// one pane split in two, a split getting a tab, a second open focusing the first, a reload keeping
// the layout, the link back focusing the story, a phone navigating with Back, a deleted story
// shown as text, and the story's name in the chat list. Synthetic data only; with LAYOUT_AUDIT=1
// each surface is audited.
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import type { ChatId } from "@rp/shared/chat.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { sidePanel } from "./support/workshopSideChat.ts"

const server = serverPerFile(withAdmin)
const STORY_LINE = "The ledger lists three ships."
const POP = "Open beside the story"

/** A story with one message of the user's: no reply, so no model is needed. */
const makeStory = (_server: typeof server, title: string) =>
  asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title })
      yield* api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: STORY_LINE })
      return chat
    })
  )

const attach = (story: ChatId) =>
  asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.CreateWorkshop({ attachTo: story }))

const audit = async (page: Page, name: string) => {
  if (process.env.LAYOUT_AUDIT) await expectLayout(page, test.info(), name)
}

const start = async (page: Page, width: number, title: string) => {
  await page.setViewportSize({ width, height: 900 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const story = await makeStory(server, title)
  const workshop = await attach(story.id)
  await page.goto(`${server().url}/chats/${story.id}?panel=workshop&workshop=${workshop.id}`)
  const side = sidePanel(page).locator(`[data-side-chat="${workshop.id}"]`)
  await expect(side).toBeVisible({ timeout: 30_000 })
  return { story, workshop, side }
}

const frames = (page: Page) => page.locator("[data-frame]")
test("one chat: the workshop opens in a pane beside the story, once, and a reload keeps both", async ({ page }) => {
  test.setTimeout(120_000)
  const { story, workshop } = await start(page, 1440, "Pop ledger")
  await sidePanel(page).getByRole("link", { name: POP }).click()
  await expect(frames(page)).toHaveCount(2)
  await expect(frames(page).first().getByText(STORY_LINE)).toBeVisible()
  const back = frames(page).nth(1).getByRole("link", { name: "About “Pop ledger”" })
  await expect(back).toBeVisible()
  await audit(page, "workshop-popped-1440")

  // The link back focuses the story where it's open: no third pane, no duplicate.
  const tabsBefore = await page.locator("[data-frame] [data-tab]").count()
  await back.click()
  await expect(page).toHaveURL(new RegExp(`/chats/${story.id}`))
  await expect(frames(page)).toHaveCount(2)
  await expect(page.locator(`[data-frame] [data-tab]`)).toHaveCount(tabsBefore)

  // Opening it again from the story's panel focuses the open one.
  // (The link focused the story's tab, which kept its Workshop panel.)
  await expect(page).toHaveURL(/[?&]panel=workshop/)
  const pop = sidePanel(page).getByRole("link", { name: POP })
  await expect(pop).toBeVisible()
  await pop.click()
  await expect(page).toHaveURL(new RegExp(`/chats/${workshop.id}`))
  await expect(frames(page)).toHaveCount(2)
  await expect(page.getByRole("link", { name: "About “Pop ledger”" })).toHaveCount(1)

  await page.reload()
  await expect(frames(page)).toHaveCount(2)
  await expect(frames(page).first().getByText(STORY_LINE)).toBeVisible()
  await expect(frames(page).nth(1).getByRole("link", { name: "About “Pop ledger”" })).toBeVisible()
})

test("with a split, the workshop lands as a tab in the other pane", async ({ page }) => {
  test.setTimeout(120_000)
  const { workshop } = await start(page, 1440, "Split ledger")
  await page.getByRole("button", { name: "Split right" }).first().click()
  await expect(frames(page)).toHaveCount(2)
  await frames(page).first().getByText(STORY_LINE).click()
  await sidePanel(page).getByRole("link", { name: POP }).click()
  await expect(frames(page)).toHaveCount(2)
  // The right pane has the story's copy and the workshop as tabs; the left still shows the story.
  await expect(frames(page).nth(1).locator("[data-tab]")).toHaveCount(2)
  await expect(frames(page).first().getByText(STORY_LINE)).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`/chats/${workshop.id}`))
  await audit(page, "workshop-tab-1440")
})

test("on a phone, it opens on its own page and Back returns to the story", async ({ page }) => {
  test.setTimeout(120_000)
  const { story, workshop } = await start(page, 390, "Phone ledger")
  await sidePanel(page).getByRole("link", { name: POP }).click()
  await expect(page).toHaveURL(new RegExp(`/chats/${workshop.id}`))
  const back = page.getByRole("link", { name: "About “Phone ledger”" })
  await expect(back).toBeVisible()
  await audit(page, "workshop-page-390")
  await page.goBack()
  await expect(page).toHaveURL(new RegExp(`/chats/${story.id}`))
  await expect(page.getByTestId("messages").getByText(STORY_LINE)).toBeVisible()
  // The link from the workshop opens the story too.
  await page.goForward()
  await page.getByRole("link", { name: "About “Phone ledger”" }).click()
  await expect(page).toHaveURL(new RegExp(`/chats/${story.id}`))
  await expect(page.getByTestId("messages").getByText(STORY_LINE)).toBeVisible()
})

for (const width of [1440, 390])
  test(`the chat list names each workshop's story, and a deleted story is plain text at ${width}`, async ({ page }) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width, height: 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const story = await makeStory(server, `Listed ledger ${width}`)
    const workshop = await attach(story.id)
    await page.goto(`${server().url}/chats`)
    await expect(page.locator("[data-workshop-story-name]").filter({ hasText: `Listed ledger ${width}` })).toHaveCount(
      1
    )
    await audit(page, `workshop-list-${width}`)
    await asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.DeleteChat({ chatId: story.id }))
    await page.goto(`${server().url}/chats/${workshop.id}`)
    await expect(page.locator('[data-workshop-story="deleted"]')).toContainText("(deleted)")
    await expect(page.getByRole("link", { name: /About “Listed ledger/ })).toHaveCount(0)
    await audit(page, `workshop-deleted-story-${width}`)
  })

// The chat screens against a server with the fake generator: sending, streaming replies,
// versions, stopping, editing, links to a message, branches, deleting; another user never
// sees the chat; and every chat screen at phone and desktop width, light and dark.
import { join } from "node:path"
import { expect, type Locator, type Page, test } from "@playwright/test"
import type { SlotId } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

// About two seconds a reply: long enough to stop one, short enough to wait for.
const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "80", FAKE_GENERATOR_TOKENS: "160" })

/** A message's text without its layout's whitespace. */
const textOf = async (message: Locator) =>
  ((await message.locator(".markdown").textContent()) ?? "").replace(/\s+/g, "")

const replies = (page: Page) => page.getByRole("article", { name: "Reply" })
const generating = (page: Page) => page.getByText("generating", { exact: true })

/** Waits for the chat to show `count` replies, none still generating. */
const repliesDone = async (page: Page, count: number) => {
  await expect(replies(page)).toHaveCount(count)
  await expect(generating(page)).toHaveCount(0, { timeout: 20_000 })
  // The list followed the reply as it grew.
  await expect(replies(page).last()).toBeInViewport()
}

const newChat = async (page: Page, title: string) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats`)
  await page.getByLabel("Title of the new chat").fill(title)
  await page.getByRole("button", { name: "New chat" }).click()
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible()
}

const send = async (page: Page, text: string) => {
  await page.getByLabel("Message", { exact: true }).fill(text)
  await page.getByRole("button", { name: "Send" }).click()
}

test("a message gets a streamed reply, with versions to swipe through", async ({ page }) => {
  await newChat(page, "Harbor")
  await send(page, "The lantern swings over the *harbor*.")
  await expect(page.getByRole("article", { name: "Your message" }).locator("em")).toHaveText("harbor")
  await expect(generating(page)).toBeVisible()
  // Send waits for the reply (DESIGN §2.2 leaves queueing open); typing doesn't.
  await page.getByLabel("Message", { exact: true }).fill("Next")
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled()
  await expect(generating(page)).toHaveCount(0, { timeout: 20_000 })
  const reply = replies(page).last()
  const first = await textOf(reply)
  expect(first.length).toBeGreaterThan(100)

  // Past the last version, a swipe generates another; swiping back shows the first again.
  await reply.getByRole("button", { name: "Generate another version" }).click()
  await expect(reply.getByText("2 / 2")).toBeVisible()
  await expect(reply.getByText("generating", { exact: true })).toBeVisible()
  await expect(generating(page)).toHaveCount(0, { timeout: 20_000 })
  const second = await textOf(reply)
  expect(second).not.toEqual(first)
  await reply.getByRole("button", { name: "Previous version" }).click()
  await expect(reply.getByText("1 / 2")).toBeVisible()
  await expect.poll(() => textOf(reply)).toBe(first)

  // The reload shows the same, from the server.
  await page.reload()
  await expect.poll(() => textOf(replies(page).last())).toBe(first)
})

test("a stopped reply keeps its text, and a message can be edited, linked to, branched from and deleted", async ({
  page
}) => {
  await newChat(page, "Chapel")
  await send(page, "Knock twice.")
  await expect(generating(page)).toBeVisible()
  await page.waitForTimeout(400)
  // The composer's Stop: the message's own moves as its text grows.
  await page.getByRole("button", { name: "Stop" }).last().click()
  const reply = replies(page).last()
  await expect(reply.getByText("stopped", { exact: true })).toBeVisible()
  expect((await reply.locator(".markdown").innerText()).length).toBeGreaterThan(0)

  // A message the user wrote is changed in place.
  const mine = page.getByRole("article", { name: "Your message" }).first()
  await mine.getByRole("button", { name: "Edit" }).click()
  await mine.getByLabel("Message text").fill("Knock three times.")
  await mine.getByRole("button", { name: "Save" }).click()
  await expect(mine.locator(".markdown")).toHaveText("Knock three times.")
  // Amended in place: still its only version.
  await expect(mine.getByRole("group", { name: "Versions" })).toHaveCount(0)

  // A link opens the chat at that message.
  await mine.getByRole("link", { name: "Link" }).click()
  await expect(page).toHaveURL(/slot=/)
  await page.reload()
  await expect(page.locator("article[data-slot]").first()).toHaveClass(/border-accent/)

  // A branch from the first message: the reply below it isn't on it.
  await page
    .getByRole("article", { name: "Your message" })
    .first()
    .getByRole("link", { name: "Branch from here" })
    .click()
  await expect(page).toHaveURL(/leaf=/)
  await expect(replies(page)).toHaveCount(0)
  await send(page, "Walk away instead.")
  await expect(page.getByRole("article", { name: "Your message" })).toHaveCount(2)
  await repliesDone(page, 1)
  // The branch is now the chat's latest: the chat's own URL opens on it.
  await page.goto(page.url().split("?")[0]!)
  await expect(page.getByText("Walk away instead.")).toBeVisible()
  await expect(page.getByRole("article", { name: "Your message" })).toHaveCount(2)

  // Deleting goes to the bin; the message is gone from the path.
  const walk = page.getByRole("article", { name: "Your message" }).filter({ hasText: "Walk away" })
  await walk.getByRole("button", { name: "Delete", exact: true }).click()
  await expect(page.getByText("Walk away instead.")).toHaveCount(0)
})

test("a message sent from an older part of the chat lands at the end, with its reply", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const { chat, first } = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title: "Long enough" })
      let parent: SlotId | null = null
      let first: SlotId | null = null
      for (let i = 0; i < 90; i++) {
        const sent: { entry: { slotId: SlotId } } = yield* api.SendMessage({
          chatId: chat.id,
          parentSlotId: parent,
          branch: false,
          content: `Message ${i}`
        })
        parent = sent.entry.slotId
        first ??= parent
      }
      return { chat, first: first! }
    })
  )
  await page.goto(`${server().url}/chats/${chat.id}?slot=${first}`)
  await expect(page.getByText("Message 0", { exact: true })).toBeVisible()
  await send(page, "From the start")
  await expect(page.getByText("From the start")).toBeVisible()
  await repliesDone(page, 1)
  const path = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 3 })
  )
  expect(path.entries.map((e) => e.version.writer)).toEqual(["human", "human", "model"])
  expect(path.entries[1]!.version.content).toBe("From the start")
})

test("a branch's URL follows the messages sent on it", async ({ page }) => {
  await newChat(page, "Fork")
  await send(page, "First")
  await repliesDone(page, 1)
  await page.getByRole("article", { name: "Your message" }).getByRole("link", { name: "Branch from here" }).click()
  await expect(replies(page)).toHaveCount(0)
  await send(page, "Second, on the branch")
  await repliesDone(page, 1)
  await expect(page).not.toHaveURL(/leaf=/)
  await page.reload()
  await expect(page.getByText("Second, on the branch")).toBeVisible()
  await expect(page.getByRole("article", { name: "Your message" })).toHaveCount(2)
})

test("another user can't open someone's chat", async ({ browser }) => {
  await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.CreateUser({ handle: "dana", displayName: "Dana", role: "user", password: "dana-password-1" })
  )
  const chat = await asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.CreateChat({ title: "Private" }))
  const dana = await browser.newPage()
  await apiLogin(dana.request, server(), "dana", "dana-password-1")
  await dana.goto(`${server().url}/chats`)
  await expect(dana.getByText("No chats yet")).toBeVisible()
  await dana.goto(`${server().url}/chats/${chat.id}`)
  await expect(dana.getByRole("alert")).toContainText("doesn't exist")
  await expect(dana.getByText("Private")).toHaveCount(0)
})

const noSidewaysScroll = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)

for (const scheme of ["light", "dark"] as const) {
  for (const [width, height, device] of [
    [390, 844, "phone"],
    [1280, 800, "desktop"]
  ] as const) {
    test(`chat screens: ${device}, ${scheme}`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width, height }, colorScheme: scheme })
      const page = await context.newPage()
      const shoot = async (name: string) => {
        await noSidewaysScroll(page)
        const dir = process.env.SCREENSHOT_DIR
        if (dir) await page.screenshot({ path: join(dir, `${name}-${device}-${scheme}.png`) })
      }
      await newChat(page, `Layout ${device} ${scheme}`)
      await send(page, "A list:\n\n- one\n- two\n\n> and a quote, with `code`.")
      await repliesDone(page, 1)
      await shoot("chat")
      await page.goto(`${server().url}/chats`)
      await expect(page.getByRole("heading", { name: "Chats" })).toBeVisible()
      await shoot("chats")
      await context.close()
    })
  }
}

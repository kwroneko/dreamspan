// Branches, the recycle bin and notifications in the browser: switching between the
// alternates at a message (each with its own composer), deleting with Undo, the bin's restore
// and delete for good, recovered text, and a reply finishing in a chat not being looked at.
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import type { ChatId, SlotId } from "@rp/shared/chat.ts"
import type { SendResult } from "@rp/shared/chatApi.ts"
import { Effect } from "effect"
import { typeInto } from "./support/composer.ts"
import { asUser } from "./support/rpc.ts"
import { showActions } from "./support/message.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

// About two seconds a reply.
const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "80", FAKE_GENERATOR_TOKENS: "160" })

type Api = Parameters<Parameters<typeof asUser>[3]>[0]

const admin = <A>(use: (api: Api) => Effect.Effect<A, unknown>) => asUser(server(), ADMIN.handle, ADMIN.password, use)

const slotOf = (result: SendResult) => {
  if (result._tag !== "Posted") throw new Error("expected it to post")
  return result.entry.slotId
}

/** Sends `content` under `parent` (a branch when it isn't the leaf). */
const send = (api: Api, chatId: ChatId, parent: SlotId | null, content: string, branch = false) =>
  Effect.map(api.SendMessage({ chatId, parentSlotId: parent, branch, content }), slotOf)

const login = (page: Page) => apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)

const box = (page: Page) => page.getByLabel("Message", { exact: true })
const message = (page: Page, text: string) =>
  page.getByRole("article", { name: "Your message" }).filter({ hasText: text })

test("switching between branches moves the chat to them, each with its own composer", async ({ page }) => {
  const chatId = await admin((api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title: "Fork" })
      const m0 = yield* send(api, chat.id, null, "At the crossroads.")
      const m1 = yield* send(api, chat.id, m0, "Take the left road.")
      yield* send(api, chat.id, m1, "The left road floods.")
      yield* send(api, chat.id, m0, "Take the right road.", true)
      return chat.id
    })
  )
  await login(page)
  await page.goto(`${server().url}/chats/${chatId}`)
  const right = message(page, "Take the right road.")
  await expect(right.getByRole("group", { name: "Branches: 2 of 2" })).toBeVisible()
  await expect(message(page, "The left road floods.")).toHaveCount(0)
  await box(page).fill("On the right, a toll.")
  await expect
    .poll(async () => {
      const tip = (await admin((api) => api.GetChat({ chatId }))).activeLeafSlotId
      return (await admin((api) => api.OpenComposer({ chatId, tipSlotId: tip }))).content
    })
    .toBe("On the right, a toll.")

  await right.getByRole("button", { name: "Previous branch" }).click()
  const left = message(page, "Take the left road.")
  await expect(left.getByRole("group", { name: "Branches: 1 of 2" })).toBeVisible()
  await expect(message(page, "The left road floods.")).toBeVisible()
  await expect(box(page)).toHaveValue("")
  // The chat opens on the branch switched to from now on.
  await page.goto(`${server().url}/chats/${chatId}`)
  await expect(message(page, "The left road floods.")).toBeVisible()
  await expect(box(page)).toBeEditable()
  await expect(box(page)).toHaveValue("")

  await left.getByRole("button", { name: "Next branch" }).click()
  await expect(message(page, "Take the right road.")).toBeVisible()
  await expect(box(page)).toHaveValue("On the right, a toll.")
})

test("a deleted message comes back with Undo, and the bin restores and deletes for good", async ({ page }) => {
  const chatId = await admin((api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title: "Lighthouse" })
      const m0 = yield* send(api, chat.id, null, "The lamp is lit.")
      yield* send(api, chat.id, m0, "A ship answers.")
      return chat.id
    })
  )
  await login(page)
  await page.goto(`${server().url}/chats/${chatId}`)
  await showActions(message(page, "A ship answers."))
  await message(page, "A ship answers.").getByRole("button", { name: "Delete message", exact: true }).click()
  await expect(message(page, "A ship answers.")).toHaveCount(0)
  const toast = page.getByText('Deleted: Message in "Lighthouse"')
  await expect(toast).toBeVisible()
  await page.getByRole("button", { name: "Undo" }).click()
  await expect(toast).toHaveCount(0)
  // Back at the end of the chat, where it was.
  await expect(message(page, "A ship answers.")).toBeVisible()

  await showActions(message(page, "A ship answers."))
  await message(page, "A ship answers.").getByRole("button", { name: "Delete message", exact: true }).click()
  await page.getByRole("button", { name: "Open the bin" }).click()
  await expect(page).toHaveURL(/\/bin$/)
  const item = page.getByRole("listitem", { name: 'Message in "Lighthouse"' })
  await expect(item.getByText("A ship answers.")).toBeVisible()
  await item.getByRole("button", { name: "Delete for good" }).click()
  const confirm = page.getByRole("alertdialog")
  await expect(confirm).toContainText("can't be undone")
  await confirm.getByRole("button", { name: "Delete for good" }).click()
  await expect(item).toHaveCount(0)
  expect(await admin((api) => api.ListBin({ limit: 10, before: null }))).toEqual([])

  // A chat deleted from the list comes back from the bin.
  await page.goto(`${server().url}/chats`)
  await page.getByRole("listitem").filter({ hasText: "Lighthouse" }).hover()
  await page.getByRole("button", { name: "Delete Lighthouse" }).click()
  await expect(page.getByRole("link", { name: "Lighthouse" })).toHaveCount(0)
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Bin" }).click()
  await page.getByRole("listitem", { name: "Lighthouse" }).getByRole("button", { name: "Restore" }).click()
  await page.getByRole("link", { name: "Open it" }).click()
  await expect(page.getByRole("heading", { level: 1, name: "Lighthouse" })).toBeVisible()
  await expect(message(page, "The lamp is lit.")).toBeVisible()
})

test("text wiped and then sent is in the bin's recovered text", async ({ page }) => {
  const long = "Everything the keeper wrote in the logbook that night, line by line. ".repeat(6).trim()
  await admin((api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title: "Logbook" })
      const typed = yield* typeInto(api, chat.id, null, long)
      const wiped = yield* typeInto(api, chat.id, null, "x", typed)
      yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: null,
        branch: false,
        content: "x",
        composer: { draftId: wiped.id, session: wiped.session }
      })
    })
  )
  await login(page)
  await page.goto(`${server().url}/bin`)
  await page.getByRole("tab", { name: "Recovered text" }).click()
  const text = page.getByRole("listitem", { name: 'Recovered from Composer in "Logbook"' })
  await text.getByRole("button", { name: "Show all" }).click()
  await expect(page.getByRole("dialog").getByLabel("Recovered text")).toHaveValue(long)
})

test("a reply finishing in a chat not looked at is counted in the list, the title and the icon", async ({ page }) => {
  // Counts the page's own requests for permission: there must be none until asked for.
  await page.addInitScript(() => {
    const asked = { count: 0 }
    Object.assign(window, { __asked: asked })
    const original = Notification.requestPermission.bind(Notification)
    Notification.requestPermission = () => {
      asked.count++
      return original()
    }
  })
  const chatId = await admin((api) => Effect.map(api.CreateChat({ title: "Elsewhere" }), (chat) => chat.id))
  await login(page)
  await page.goto(`${server().url}/chats`)
  await expect(page.getByRole("link", { name: "Elsewhere" })).toBeVisible()
  await admin((api) =>
    Effect.gen(function* () {
      const m0 = yield* send(api, chatId, null, "Anyone there?")
      yield* api.Generate({ chatId, parentSlotId: m0, branch: false })
    })
  )
  const row = page.getByRole("listitem").filter({ hasText: "Elsewhere" })
  await expect(row.getByText("1 new reply")).toBeVisible({ timeout: 20_000 })
  await expect(page).toHaveTitle(/^\(1\) Chats/)
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute("href", "/favicon-unseen.svg")

  // Opening it sees it; one finishing in the chat open isn't news.
  await page.getByRole("link", { name: "Elsewhere" }).click()
  await expect(page).toHaveTitle(/^Elsewhere/)
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute("href", "/favicon.svg")
  await box(page).fill("And now?")
  await page.getByRole("button", { name: "Send" }).click()
  await expect(page.getByText("generating", { exact: true })).toHaveCount(0, { timeout: 20_000 })
  await page.getByRole("link", { name: "← Chats" }).click()
  await expect(page.getByRole("link", { name: "Elsewhere" })).toBeVisible()
  await expect(page.getByText("new reply")).toHaveCount(0)
  await expect(page).toHaveTitle(/^Chats/)
  expect(await page.evaluate(() => (window as unknown as { __asked: { count: number } }).__asked.count)).toBe(0)
})

test("system notifications are asked for only when turned on in settings", async ({ page }) => {
  // The browser's answer, as the user would give it: first no, then yes.
  await page.addInitScript(() => {
    const answers: Array<NotificationPermission> = ["denied", "granted"]
    const asked = { count: 0 }
    Object.assign(window, { __asked: asked })
    Notification.requestPermission = () => Promise.resolve(answers[asked.count++] ?? "granted")
  })
  const asked = () => page.evaluate(() => (window as unknown as { __asked: { count: number } }).__asked.count)
  await login(page)
  await page.goto(`${server().url}/settings/notifications`)
  const toggle = page.getByRole("switch", { name: /System notifications/ })
  await expect(toggle).not.toBeChecked()
  expect(await asked()).toBe(0)
  await toggle.click()
  await expect(page.getByText("The browser didn't allow notifications")).toBeVisible()
  await expect(toggle).not.toBeChecked()
  await toggle.click()
  await expect(toggle).toBeChecked()
  expect(await asked()).toBe(2)
  expect(await page.evaluate(() => localStorage.getItem("rp.notifications.system"))).toBe("on")
})

const noSidewaysScroll = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)

for (const scheme of ["light", "dark"] as const) {
  for (const [width, height, device] of [
    [390, 844, "phone"],
    [1280, 800, "desktop"]
  ] as const) {
    test(`branches and the bin: ${device}, ${scheme}`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width, height }, colorScheme: scheme })
      const page = await context.newPage()
      const shoot = async (name: string) => {
        await noSidewaysScroll(page)
        const dir = process.env.SCREENSHOT_DIR
        if (dir) await page.screenshot({ path: join(dir, `${name}-${device}-${scheme}.png`) })
      }
      const chatId = await admin((api) =>
        Effect.gen(function* () {
          const chat = yield* api.CreateChat({ title: `Branches ${device} ${scheme}` })
          const m0 = yield* send(api, chat.id, null, "Which way?")
          yield* send(api, chat.id, m0, "Left.")
          const right = yield* send(api, chat.id, m0, "Right.", true)
          const gone = yield* send(api, chat.id, right, "A message to delete.")
          yield* api.DeleteMessage({ slotId: gone })
          return chat.id
        })
      )
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/chats/${chatId}`)
      await expect(page.getByRole("group", { name: "Branches: 2 of 2" })).toBeVisible()
      await shoot("branches")
      await page.goto(`${server().url}/bin`)
      await expect(page.getByText("A message to delete.").first()).toBeVisible()
      await shoot("bin")
      await context.close()
    })
  }
}

test("emptying the bin rejects items added after its confirmation opened", async ({ page }) => {
  const first = await admin((api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title: "Confirmed deletion" })
      return yield* api.DeleteChat({ chatId: chat.id })
    })
  )
  await login(page)
  await page.goto(`${server().url}/bin`)
  await page.getByRole("button", { name: "Empty the bin", exact: true }).click()
  const dialog = page.getByRole("alertdialog")
  await expect(dialog).toBeVisible()
  const late = await admin((api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title: "New deletion in another tab" })
      return yield* api.DeleteChat({ chatId: chat.id })
    })
  )
  await dialog.getByRole("button", { name: "Empty the bin", exact: true }).click()
  await expect(dialog).toContainText("The bin changed")
  expect((await admin((api) => api.ListBin({ limit: 500, before: null }))).map((i) => i.id)).toEqual(
    expect.arrayContaining([first.id, late.id])
  )
  await dialog.getByRole("button", { name: "Cancel" }).click()
  await expect(page.getByRole("listitem", { name: late.title })).toBeVisible()
  await page.getByRole("button", { name: "Empty the bin", exact: true }).click()
  await dialog.getByRole("button", { name: "Empty the bin", exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect(await admin((api) => api.ListBin({ limit: 500, before: null }))).toEqual([])
})

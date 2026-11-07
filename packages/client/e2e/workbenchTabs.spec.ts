// Each browser tab's address decides what that tab shows (owner, 2026-11-07): its frames and
// tabs are its own, kept for its reloads only; a new browser tab or a pasted URL opens just
// that URL; the URL follows the focused frame's tab; the root URL and the Home button show Home.
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)

let fixtures: { chatA: string; chatB: string }

test.beforeAll(async () => {
  fixtures = await admin((api) =>
    Effect.gen(function* () {
      const mira = yield* api.CreateCard({ label: "Mira", name: "Mira" })
      const wren = yield* api.CreateCard({ label: "Wren", name: "Wren" })
      const chat = (title: string, entityId: typeof mira.entityId, line: string) =>
        Effect.gen(function* () {
          const made = yield* api.CreateChat({ title })
          yield* api.ChangeCast({ chatId: made.id, slotId: null, change: { _tag: "Join", entityId } })
          yield* api.SendMessage({ chatId: made.id, parentSlotId: null, branch: false, content: line, reply: false })
          return made.id
        })
      const chatA = yield* chat("Harbour walk", mira.entityId, "The tide is out; the boats lean on the mud.")
      const chatB = yield* chat("Lighthouse night", wren.entityId, "The lamp turns, and the stairs go up forever.")
      return { chatA, chatB }
    })
  )
})

const frames = (page: Page) => page.locator("[data-frame]")
const said = (page: Page, text: string) => frames(page).getByText(text)
/** Home's page shown in a frame (a split copies it, so either frame may show it). */
const home = (page: Page) => frames(page).getByRole("heading", { name: "Characters", exact: true }).first()
const sidebarChat = (page: Page, title: string) =>
  page.getByRole("complementary", { name: "Sidebar" }).getByRole("link", { name: new RegExp(`^Open chat ${title}`) })
const homeButton = (page: Page) => page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Home" })
const path = (page: Page) => new URL(page.url()).pathname
const chatUrl = (id: string) => new RegExp(`/chats/${id}(\\?|$)`)

/** Home in the left frame and chat A opened beside it (Alt-click), as in the owner's report. */
const homeBesideChat = async (page: Page) => {
  await page.goto(`${server().url}/`)
  await expect(home(page)).toBeVisible()
  await sidebarChat(page, "Harbour walk").click({ modifiers: ["Alt"] })
  await expect(frames(page)).toHaveCount(2)
  await expect(said(page, "The tide is out")).toBeVisible()
  await expect(home(page)).toBeVisible()
  await expect(page).toHaveURL(chatUrl(fixtures.chatA))
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
})

test("the root URL opens Home alone, and the Home button shows Home from any layout", async ({ page }) => {
  await page.goto(`${server().url}/`)
  await expect(home(page)).toBeVisible()
  await expect(frames(page)).toHaveCount(1)
  await expect(page.locator("[data-tab-strip]")).toHaveCount(0)
  expect(path(page)).toBe("/")

  // From a chat in the same frame.
  await sidebarChat(page, "Lighthouse night").dblclick()
  await expect(said(page, "The lamp turns")).toBeVisible()
  await homeButton(page).click()
  await expect(home(page)).toBeVisible()
  expect(path(page)).toBe("/")

  // From a chat focused beside Home, and again once the URL is Home's.
  await page.goto(`${server().url}/`)
  await homeBesideChat(page)
  await homeButton(page).click()
  await expect(page).toHaveURL(`${server().url}/`)
  await expect(home(page)).toBeVisible()
  await frames(page).nth(1).getByText("The tide is out").click()
  await expect(page).toHaveURL(chatUrl(fixtures.chatA))
  await homeButton(page).click()
  await expect(page).toHaveURL(`${server().url}/`)
  await expect(home(page)).toBeVisible()
})

test("focusing a frame puts its tab in the URL; Back and Forward go between places", async ({ page }) => {
  await homeBesideChat(page)
  await frames(page).first().getByRole("heading", { name: "Characters", exact: true }).click()
  await expect(page).toHaveURL(`${server().url}/`)
  await frames(page).nth(1).getByText("The tide is out").click()
  await expect(page).toHaveURL(chatUrl(fixtures.chatA))

  // Opened in turn in the focused frame: Back and Forward walk them.
  await sidebarChat(page, "Lighthouse night").click()
  await expect(page).toHaveURL(chatUrl(fixtures.chatB))
  await expect(said(page, "The lamp turns")).toBeVisible()
  await page.goBack()
  await expect(page).toHaveURL(chatUrl(fixtures.chatA))
  await expect(said(page, "The tide is out")).toBeVisible()
  await page.goForward()
  await expect(page).toHaveURL(chatUrl(fixtures.chatB))
  await expect(said(page, "The lamp turns")).toBeVisible()
})

test("a reload keeps this browser tab's frames, with the URL's item focused", async ({ page }) => {
  await homeBesideChat(page)
  await page.reload()
  await expect(frames(page)).toHaveCount(2)
  await expect(home(page)).toBeVisible()
  await expect(said(page, "The tide is out")).toBeVisible()
  await expect(page).toHaveURL(chatUrl(fixtures.chatA))
  // Focus survives too: the URL stays the chat's, and Home is a frame away.
  await frames(page).first().getByRole("heading", { name: "Characters", exact: true }).click()
  await expect(page).toHaveURL(`${server().url}/`)
  await page.reload()
  await expect(frames(page)).toHaveCount(2)
  await expect(page).toHaveURL(`${server().url}/`)
})

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`a fresh root URL replaces the previous frames for subsequent reloads at ${width} ${theme}`, async ({
      page
    }, testInfo) => {
      await page.emulateMedia({ colorScheme: theme })
      await homeBesideChat(page)
      await page.setViewportSize({ width, height: 900 })
      await page.goto(`${server().url}/`)
      await expect(home(page)).toBeVisible()
      await expect(frames(page)).toHaveCount(1)

      // No layout interaction after the fresh navigation: reloading must keep Home alone.
      await page.reload()
      await expect(home(page)).toBeVisible()
      await expect(frames(page)).toHaveCount(1)
      await expect(said(page, "The tide is out")).toHaveCount(0)
      await expect(page.locator("[data-tab-strip]")).toHaveCount(0)
      await expect(frames(page).getByRole("link", { name: "Open Mira", exact: true })).toBeVisible()
      await page.screenshot({ path: testInfo.outputPath("home.png") })
    })

test("browser tabs keep their own frames; a new tab or a pasted URL opens just its URL", async ({ page, context }) => {
  await homeBesideChat(page)

  // A second browser tab of the same browser opens its URL alone.
  const other = await context.newPage()
  await other.setViewportSize({ width: 1440, height: 900 })
  await other.goto(`${server().url}/chats/${fixtures.chatB}`)
  await expect(said(other, "The lamp turns")).toBeVisible()
  await expect(frames(other)).toHaveCount(1)
  await expect(other.locator("[data-tab-strip]")).toHaveCount(0)
  // It changes its own layout; the first tab's reload keeps the first tab's.
  await other.getByRole("button", { name: "Split down" }).click()
  await expect(frames(other)).toHaveCount(2)
  await page.reload()
  await expect(frames(page)).toHaveCount(2)
  await expect(home(page)).toBeVisible()
  await expect(said(page, "The tide is out")).toBeVisible()
  await expect(said(page, "The lamp turns")).toHaveCount(0)
  await other.reload()
  await expect(said(other, "The lamp turns")).toHaveCount(2)
  await expect(home(other)).toHaveCount(0)

  // The root URL in a new tab is Home alone, whatever other tabs have open.
  const third = await context.newPage()
  await third.setViewportSize({ width: 1440, height: 900 })
  await third.goto(`${server().url}/`)
  await expect(home(third)).toBeVisible()
  await expect(frames(third)).toHaveCount(1)
  await expect(said(third, "The tide is out")).toHaveCount(0)

  // A URL pasted into a tab with frames opens just that URL.
  await page.goto(`${server().url}/chats/${fixtures.chatB}`)
  await expect(said(page, "The lamp turns")).toBeVisible()
  await expect(frames(page)).toHaveCount(1)
  await expect(page.locator("[data-tab-strip]")).toHaveCount(0)
})

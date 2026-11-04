// The owner's shell reports of 2026-10-31: no Forks link between chats, a left-panel switch
// the size of its labels, home tiles of one height per row, and breadcrumbs tied to the URL.
import { expect, test, type Page } from "@playwright/test"
import { Effect } from "effect"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
test.setTimeout(120_000)

let chatId = ""
test.beforeAll(async () => {
  chatId = await admin((api) =>
    Effect.gen(function* () {
      const wren = yield* api.CreateCard({ label: "Wren", name: "Wren", version: "main" })
      yield* api.CreateCard({ label: "Plain", name: "Plain" })
      yield* api.CreateCard({ label: "Other", name: "Other", version: "v2" })
      const started = yield* api.StartChat({
        cards: [wren.entityId],
        persona: null,
        greeting: null,
        first: { _tag: "Send", content: "The lamp is lit.", speakerEntityId: wren.entityId }
      })
      const leaf = started.chat.activeLeafSlotId
      // Two forks: the path branches at the second message.
      yield* api.SendMessage({
        chatId: started.chat.id,
        parentSlotId: leaf,
        branch: false,
        content: "North",
        reply: false
      })
      yield* api.SendMessage({
        chatId: started.chat.id,
        parentSlotId: leaf,
        branch: true,
        content: "South",
        reply: false
      })
      yield* api.RenameChat({ chatId: started.chat.id, name: "Lamp story" })
      return started.chat.id
    })
  )
})

const sidebar = (page: Page) => page.getByRole("complementary").first()
const crumbs = (page: Page) => sidebar(page).getByRole("navigation", { name: "Chat breadcrumbs" })
const path = (page: Page) => new URL(page.url()).pathname

test("the sidebar lists chats without a link between them, under a switch that fills its narrow row", async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(server().url)
  await expect(sidebar(page).getByRole("button", { name: "Open chat Lamp story" }).first()).toBeVisible()
  await expect(sidebar(page).getByRole("button", { name: "Forks", exact: true })).toHaveCount(0)
  const left = await sidebar(page).getByRole("group", { name: "Left panel", exact: true }).boundingBox()
  const find = await sidebar(page).getByLabel("Find a chat").boundingBox()
  // DESIGN §10.1 left-panel name filter (2026-11-04): fill the row when stacked.
  expect(Math.abs(left!.width - find!.width)).toBeLessThanOrEqual(1)
  expect(find!.y).toBeGreaterThanOrEqual(left!.y + left!.height)
})

test("home tiles in a row are one height, their last lines aligned", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(server().url)
  const grid = page.getByRole("main").getByLabel("Characters", { exact: true })
  const tile = (label: string) => grid.getByRole("button", { name: new RegExp(`^Open ${label}`) })
  await expect(tile("Plain")).toBeVisible()
  const boxes = await Promise.all(["Wren", "Plain", "Other"].map((label) => tile(label).boundingBox()))
  expect(new Set(boxes.map((b) => Math.round(b!.y))).size).toBe(1)
  expect(new Set(boxes.map((b) => Math.round(b!.height))).size).toBe(1)
  const lasts = await Promise.all(
    ["Wren", "Plain", "Other"].map((label) => tile(label).locator("span > span").last().boundingBox())
  )
  expect(new Set(lasts.map((b) => Math.round(b!.y + b!.height))).size).toBe(1)
})

test("breadcrumbs say what the URL says: home none, a character its card, a chat its chat", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(server().url)
  await expect(crumbs(page)).toHaveCount(0)
  await page.getByRole("main").getByRole("button", { name: "Open Wren", exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/chats/${chatId}`))
  await expect(crumbs(page)).toContainText("Wren")
  const chatPath = path(page)

  // Home from the main navigation: the crumbs go, and come back with the URL.
  await page
    .getByRole("navigation", { name: "Main", exact: true })
    .getByRole("link", { name: "Home", exact: true })
    .click()
  await expect(page).toHaveURL(`${server().url}/`)
  await expect(crumbs(page)).toHaveCount(0)
  await page.goBack()
  await expect(crumbs(page)).toContainText("Wren")
  await page.goForward()
  await expect(crumbs(page)).toHaveCount(0)
  await page.goBack()
  await expect(crumbs(page)).toContainText("Wren")
  await page.reload()
  await expect(crumbs(page)).toContainText("Wren")
  const scoped = page.url()
  await page.goto(scoped)
  await expect(crumbs(page)).toContainText("Wren")

  // A pick in the character's list keeps the list where it is.
  await sidebar(page).getByRole("button", { name: "Open chat Lamp story" }).first().click()
  await expect(crumbs(page)).toContainText("Wren")

  // The root shows all chats; the chat in the middle stays.
  await crumbs(page).getByRole("button", { name: "All chats", exact: true }).click()
  await expect(crumbs(page)).toHaveCount(0)
  expect(path(page)).toBe(chatPath)
  await page.goBack()
  await expect(crumbs(page)).toContainText("Wren")

  // The chat's forks are listed from the branch menu, the chat in the crumbs.
  await page.getByRole("button", { name: /switch branch/ }).click()
  await page.getByRole("link", { name: "Show in the left panel" }).click()
  await expect(crumbs(page)).toContainText("Lamp story")
  await expect(crumbs(page)).not.toContainText("Wren")
  await expect(
    sidebar(page)
      .getByRole("region", { name: /^(Named and pinned|Branches)$/ })
      .first()
  ).toBeVisible()
  expect(path(page)).toBe(chatPath)
  // Moving around the chat keeps the panel on it.
  await page.reload()
  await expect(crumbs(page)).toContainText("Lamp story")
  await page.getByRole("navigation", { name: "Main", exact: true }).getByRole("link", { name: "Library" }).click()
  await expect(crumbs(page)).toHaveCount(0)
})

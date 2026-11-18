// A browser tab's layout is its own and lives in its URL (owner, 2026-11-18: hiding the sidebar
// in one tab hid it in every other). Two pages of one browser context share its storage, so a
// layout kept there would reach the second page; in the URL it can't. Each choice survives a
// reload and navigating inside the app, and a copied URL opens it the same.
import { expect, type BrowserContext, type Locator, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)

let chatId: string

test.beforeAll(async () => {
  chatId = await admin((api) =>
    Effect.gen(function* () {
      const mira = yield* api.CreateCard({ label: "Mira", name: "Mira" })
      yield* api.CreateCard({ label: "Wren", name: "Wren" })
      const made = yield* api.CreateChat({ title: "Harbour walk" })
      yield* api.ChangeCast({ chatId: made.id, slotId: null, change: { _tag: "Join", entityId: mira.entityId } })
      yield* api.SendMessage({
        chatId: made.id,
        parentSlotId: null,
        branch: false,
        content: "The tide is out; the boats lean on the mud.",
        reply: false
      })
      return made.id
    })
  )
})

const chatUrl = () => `${server().url}/chats/${chatId}`
const sidebar = (page: Page) => page.getByRole("complementary", { name: "Sidebar" })
const said = (page: Page) => page.locator("[data-frame]").getByText("The tide is out")
const param = (page: Page, key: string) => new URL(page.url()).searchParams.get(key)
const libraryHeading = (page: Page) =>
  page.locator("[data-frame]").getByRole("heading", { name: "Library", exact: true }).first()

const open = async (context: BrowserContext, url = chatUrl()) => {
  const page = await context.newPage()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(url)
  return page
}

/** Two pages of one context (one storage), both at the chat. */
const twoPages = async (context: BrowserContext) => {
  await apiLogin(context.request, server(), ADMIN.handle, ADMIN.password)
  const one = await open(context)
  const two = await open(context)
  await expect(said(one)).toBeVisible()
  await expect(said(two)).toBeVisible()
  return [one, two] as const
}

/** A whole-pixel width from a separator's value. */
const widthOf = async (handle: Locator) => Number(await handle.getAttribute("aria-valuenow"))

/** Drags a column's grip by `dx`, in steps, as a person would. */
const drag = async (page: Page, handle: Locator, dx: number) => {
  const box = (await handle.boundingBox())!
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  for (let step = 1; step <= 5; step++) await page.mouse.move(x + (dx * step) / 5, y)
  await page.mouse.up()
}

test("hiding the sidebar stays in its own tab, through reload, navigation and a copied URL", async ({ context }) => {
  const [one, two] = await twoPages(context)
  const entries = await one.evaluate(() => history.length)
  await sidebar(one).getByRole("button", { name: "Hide the sidebar", exact: true }).click()
  await expect(sidebar(one)).toHaveCount(0)
  await expect.poll(() => param(one, "sidebar")).toBe("hidden")
  // Replaced, not pushed.
  expect(await one.evaluate(() => history.length)).toBe(entries)

  // The other page, same storage, keeps its sidebar, also after a reload.
  await expect(sidebar(two)).toBeVisible()
  await two.reload()
  await expect(said(two)).toBeVisible()
  await expect(sidebar(two)).toBeVisible()
  expect(param(two, "sidebar")).toBeNull()

  // A reload keeps it hidden.
  await one.reload()
  await expect(said(one)).toBeVisible()
  await expect(sidebar(one)).toHaveCount(0)

  // Navigating inside the app keeps it: an in-app link (the sidebar's would do the same, but
  // it's hidden; a message's links open a new browser tab), followed by the workbench.
  await one.evaluate(() => {
    const link = document.createElement("a")
    link.href = "/library"
    document.body.append(link)
    link.click()
    link.remove()
  })
  await expect(libraryHeading(one)).toBeVisible()
  expect(new URL(one.url()).pathname).toBe("/library")
  expect(param(one, "sidebar")).toBe("hidden")
  await expect(sidebar(one)).toHaveCount(0)

  // A copied URL opens with it hidden.
  const copy = await open(context, one.url())
  await expect(libraryHeading(copy)).toBeVisible()
  await expect(sidebar(copy)).toHaveCount(0)

  // Showing it again removes the param.
  await one.getByRole("button", { name: "Show the sidebar", exact: true }).first().click()
  await expect(sidebar(one)).toBeVisible()
  await expect.poll(() => param(one, "sidebar")).toBeNull()
  await expect(sidebar(copy)).toHaveCount(0)
  if (process.env.LAYOUT_AUDIT) await expectLayout(one, test.info(), "tab-local-sidebar-shown")
})

test("a dragged column width stays in its own tab, through reload, navigation and a copied URL", async ({
  context
}) => {
  const [one, two] = await twoPages(context)
  const grip = (page: Page) => page.getByRole("separator", { name: "Resize sidebar" })
  const before = await widthOf(grip(two))
  const entries = await one.evaluate(() => history.length)
  await drag(one, grip(one), 80)
  const dragged = await widthOf(grip(one))
  expect(dragged).toBeGreaterThan(before + 40)
  // Written once, when the drag ended, in whole pixels; no history entry.
  await expect.poll(() => param(one, "sbw")).toBe(String(dragged))
  expect(await one.evaluate(() => history.length)).toBe(entries)

  // The other page keeps its width, also after a reload.
  expect(await widthOf(grip(two))).toBe(before)
  await two.reload()
  await expect(said(two)).toBeVisible()
  expect(await widthOf(grip(two))).toBe(before)

  await one.reload()
  await expect(said(one)).toBeVisible()
  expect(await widthOf(grip(one))).toBe(dragged)

  // In-app navigation from the sidebar keeps it.
  await sidebar(one).getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Library" }).click()
  await expect(libraryHeading(one)).toBeVisible()
  expect(param(one, "sbw")).toBe(String(dragged))
  expect(await widthOf(grip(one))).toBe(dragged)

  const copy = await open(context, one.url())
  await expect(libraryHeading(copy)).toBeVisible()
  expect(await widthOf(grip(copy))).toBe(dragged)

  // A double click returns to the default and leaves the URL.
  await grip(one).dblclick()
  await expect.poll(() => param(one, "sbw")).toBeNull()
  expect(await widthOf(grip(one))).toBe(before)
  if (process.env.LAYOUT_AUDIT) await expectLayout(one, test.info(), "tab-local-sidebar-width")
})

test("the chat panel's width and its open Add characters section stay in their own tab", async ({ context }) => {
  await apiLogin(context.request, server(), ADMIN.handle, ADMIN.password)
  const one = await open(context, `${chatUrl()}?panel=cast`)
  const two = await open(context, `${chatUrl()}?panel=cast`)
  const panel = (page: Page) => page.getByRole("complementary", { name: "Chat panel" })
  const grip = (page: Page) => page.getByRole("separator", { name: "Resize chat panel" })
  const add = (page: Page) => panel(page).getByRole("button", { name: "Add characters" })
  await expect(add(one)).toBeVisible()
  await expect(add(two)).toBeVisible()
  const before = await widthOf(grip(two))

  await drag(one, grip(one), -60)
  const dragged = await widthOf(grip(one))
  expect(dragged).toBeGreaterThan(before + 30)
  await expect.poll(() => param(one, "cpw")).toBe(String(dragged))
  await add(one).click()
  await expect(add(one)).toHaveAttribute("aria-expanded", "true")
  await expect.poll(() => param(one, "cadd")).toBe("open")

  await expect(add(two)).toHaveAttribute("aria-expanded", "false")
  await two.reload()
  await expect(add(two)).toHaveAttribute("aria-expanded", "false")
  expect(await widthOf(grip(two))).toBe(before)

  await one.reload()
  await expect(add(one)).toHaveAttribute("aria-expanded", "true")
  expect(await widthOf(grip(one))).toBe(dragged)

  const copy = await open(context, one.url())
  await expect(add(copy)).toHaveAttribute("aria-expanded", "true")
  expect(await widthOf(grip(copy))).toBe(dragged)

  await add(one).click()
  await expect.poll(() => param(one, "cadd")).toBeNull()
})

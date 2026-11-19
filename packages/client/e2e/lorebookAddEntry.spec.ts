// "Add entry" scrolls only if needed (owner, 2026-11-02: "I question what the point of scrolling
// is when the new entry is already visible on the screen ... It should only scroll if needed.").
// The new entry leads the table: when its header and title field are in view nothing moves;
// when they aren't, the whole header comes into view below the sticky toolbar. In the large
// editor and the side panel's book, at 1440 and 390. Synthetic books and chat only.
import { expect, type Locator, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import type { RefId } from "@dreamspan/shared/library.ts"
import { openPanel } from "./support/panel.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)

const book = (name: string) => ({
  name,
  entries: Object.fromEntries(
    Array.from({ length: 40 }, (_, uid) => [
      uid,
      { uid, key: [`key${uid}`], comment: `Place ${uid}`, content: `Text of place ${uid}.`, order: uid }
    ])
  )
})

const upload = async (page: Page, name: string) => {
  const response = await page.request.post(`${server().url}/library/import?name=${encodeURIComponent(name)}.json`, {
    data: Buffer.from(JSON.stringify(book(name))),
    headers: { origin: server().url, "content-type": "application/octet-stream" }
  })
  expect(response.status()).toBe(200)
  return (await response.json()).library.ref as { id: RefId }
}

/** Runs `move` on the element's scrolling ancestor (null: the page), and returns where it's scrolled to. */
const onScroller = (element: Locator, move: "read" | "bottom" | number) =>
  element.evaluate((node, move) => {
    let scroller: HTMLElement | null = null
    for (let parent = node.parentElement; parent && !scroller; parent = parent.parentElement) {
      const { overflowY } = getComputedStyle(parent)
      if ((overflowY === "auto" || overflowY === "scroll") && parent.scrollHeight > parent.clientHeight)
        scroller = parent
    }
    const by = (delta: number) => (scroller ? (scroller.scrollTop += delta) : window.scrollBy(0, delta))
    // A number: the element's top at that share of the screen's height, as far as it goes.
    if (typeof move === "number") by(node.getBoundingClientRect().top - innerHeight * move)
    if (move === "bottom") by(100_000)
    return scroller ? scroller.scrollTop : window.scrollY
  }, move)

/** Every corner of the entry's header shows the header itself: nothing covers it, and it's on screen. */
const headerInView = (title: Locator) =>
  title.evaluate((input) => {
    const header = input.closest("[data-entry-header]")!
    const rect = header.getBoundingClientRect()
    const points = [
      [rect.left + 4, rect.top + 2],
      [rect.right - 4, rect.top + 2],
      [rect.left + 4, rect.bottom - 2],
      [rect.right - 4, rect.bottom - 2]
    ] as const
    return points.every(([x, y]) => {
      const hit = document.elementFromPoint(x, y)
      return hit !== null && (header.contains(hit) || hit.contains(header))
    })
  })

/**
 * Add entry with the toolbar in the upper part of the screen: the new entry, at the top of the
 * table, is in view, so nothing moves. Then a copy of an entry at the end of the list, which
 * also leads the table, out of view above: the view moves up until the copy's whole header
 * shows under the sticky toolbar.
 */
const check = async (page: Page, scope: Locator, shot: string) => {
  const add = scope.getByRole("button", { name: "Add entry", exact: true })
  const before = await onScroller(add, 0.3)
  await add.click()
  const title = scope.getByRole("textbox", { name: "Title of Untitled entry", exact: true })
  await expect(title).toBeFocused()
  // Focus is set after the conditional reveal completes.
  await expect.poll(() => headerInView(title)).toBe(true)
  expect(await onScroller(add, "read")).toBe(before)
  if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/${shot}-added.png` })
  await page.keyboard.type("Gulls")

  await onScroller(add, "bottom")
  const last = scope.getByRole("textbox", { name: "Title of Place 0", exact: true })
  await expect(last).toBeVisible()
  const low = await onScroller(add, "read")
  await scope.getByRole("button", { name: "More for Place 0", exact: true }).click()
  await page.getByRole("menuitem", { name: "Duplicate" }).click()
  const copy = scope.getByRole("textbox", { name: "Title of Place 0 (copy)", exact: true })
  await expect(copy).toBeFocused()
  await expect.poll(() => onScroller(add, "read")).toBeLessThan(low)
  await expect.poll(() => headerInView(copy)).toBe(true)
  if (process.env.SCREENSHOT_DIR)
    await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/${shot}-duplicated.png` })
}

for (const theme of ["light", "dark"] as const)
  for (const width of [1440, 390]) {
    test(`the large editor's Add entry scrolls only when the new entry is hidden (${width}px, ${theme})`, async ({
      page
    }) => {
      test.setTimeout(120_000)
      await page.setViewportSize({ width, height: width < 600 ? 844 : 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const ref = await upload(page, `Coast ${width} ${theme}`)
      await page.goto(`${server().url}/library/${ref.id}`)
      const list = page.getByRole("list", { name: "Entries" })
      await expect(list.getByRole("textbox", { name: "Title of Place 39", exact: true })).toBeVisible()
      await check(page, page.locator("main"), `lorebook-large-${width}-${theme}`)
    })

    test(`the side panel's Add entry scrolls only when the new entry is hidden (${width}px, ${theme})`, async ({
      page
    }) => {
      test.setTimeout(120_000)
      await page.setViewportSize({ width, height: width < 600 ? 844 : 1000 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const label = `Tides ${width} ${theme}`
      const ref = await upload(page, label)
      const chatId = await admin((api) =>
        Effect.gen(function* () {
          const chat = yield* api.CreateChat({ title: `Lore ${width}` })
          yield* api.ChangeCast({
            chatId: chat.id,
            slotId: null,
            change: { _tag: "Lorebook", ref: ref.id, active: true }
          })
          return chat.id
        })
      )
      await page.goto(`${server().url}/chats/${chatId}`)
      const panel = await openPanel(page, "Lorebooks")
      await panel
        .getByRole("list", { name: "Lorebooks in this chat" })
        .getByRole("button", { name: new RegExp(`^${label}`) })
        .click()
      const editor = panel.getByRole("region", { name: `Lorebook ${label}` })
      await expect(editor.getByRole("list", { name: "Entries" })).toBeVisible()
      await check(page, editor, `lorebook-panel-${width}-${theme}`)
    })
  }

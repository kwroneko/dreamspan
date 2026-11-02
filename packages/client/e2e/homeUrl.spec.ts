// Home's existing controls belong to the URL: reload, shared links and browser history.
import { expect, test, type Page } from "@playwright/test"
import { Effect } from "effect"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
test.setTimeout(120_000)

let userId = ""
test.beforeAll(async () => {
  userId = await admin((api) =>
    Effect.gen(function* () {
      const alice = yield* api.CreateCard({ label: "Alice", name: "Alice" })
      const bob = yield* api.CreateCard({ label: "Bob", name: "Bob" })
      yield* api.CreateCard({ label: "Unused", name: "Unused" })
      yield* api.SetCardFavourite({ entityId: alice.entityId, favourite: true })
      const group = yield* api.StartChat({
        cards: [alice.entityId, bob.entityId],
        persona: null,
        greeting: null,
        first: { _tag: "Send", content: "A synthetic hello.", speakerEntityId: alice.entityId }
      })
      yield* api.RenameChat({ chatId: group.chat.id, name: "Alice and Bob" })
      yield* api.SetChatPin({ chatId: group.chat.id, leaf: group.chat.activeLeafSlotId, pinned: true })
      return (yield* api.GetSession()).user.id
    })
  )
})

const main = (page: Page) => page.getByRole("main")
const show = (page: Page, name: string) =>
  main(page).getByRole("group", { name: "Show", exact: true }).getByRole("button", { name, exact: true })
const sort = (page: Page, name: string) =>
  main(page).getByRole("group", { name: "Sort by", exact: true }).getByRole("button", { name, exact: true })
const pinsSort = (page: Page, name: string) =>
  main(page).getByRole("group", { name: "Sort pinned chats" }).getByRole("button", { name, exact: true })
const search = (page: Page) => main(page).getByRole("searchbox", { name: "Search characters and groups" })
const historyLength = (page: Page) => page.evaluate(() => history.length)

for (const width of [1440, 390]) {
  test(`${width}: every home choice reloads and a copied link wins over device memory`, async ({ page, browser }) => {
    await page.setViewportSize({ width, height: 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(server().url)
    await expect(show(page, "All")).toHaveAttribute("aria-pressed", "true")
    const length = await historyLength(page)
    await sort(page, "Name").click()
    await main(page).getByRole("button", { name: "Order: A to Z", exact: true }).click()
    await pinsSort(page, "Created").click()
    await search(page).pressSequentially("Alice & Bob?")
    await expect(search(page)).toHaveValue("Alice & Bob?")
    expect(await historyLength(page)).toBe(length)
    await show(page, "Groups").click()
    expect(await historyLength(page)).toBe(length + 1)
    const link = page.url()
    const assertState = async (target: Page) => {
      await expect(show(target, "Groups")).toHaveAttribute("aria-pressed", "true")
      await expect(sort(target, "Name")).toHaveAttribute("aria-pressed", "true")
      await expect(main(target).getByRole("button", { name: "Order: Z to A", exact: true })).toBeVisible()
      await expect(pinsSort(target, "Created")).toHaveAttribute("aria-pressed", "true")
      await expect(search(target)).toHaveValue("Alice & Bob?")
    }
    await page.reload()
    await assertState(page)
    await search(page).fill("Alice")
    await expect(
      main(page).getByLabel("Groups", { exact: true }).getByRole("button", { name: "Open chat Alice and Bob" })
    ).toBeVisible()

    const context = await browser.newContext({ viewport: { width, height: 900 } })
    try {
      await apiLogin(context.request, server(), ADMIN.handle, ADMIN.password)
      await context.addInitScript(
        ({ key }) => localStorage.setItem(key, JSON.stringify({ sort: "added", reversed: false })),
        { key: `rp.cards.home.${userId}` }
      )
      const copied = await context.newPage()
      await copied.goto(link)
      await assertState(copied)
    } finally {
      await context.close()
    }

    for (const tab of ["With chats", "Never used", "Favourites"]) {
      await show(page, tab).click()
      await page.reload()
      await expect(show(page, tab)).toHaveAttribute("aria-pressed", "true")
    }
  })

  test(`${width}: tab history restores defaults and choices; sort and typing replace`, async ({ page }) => {
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.setViewportSize({ width, height: 900 })
    await page.goto(server().url)
    await expect(show(page, "All")).toHaveAttribute("aria-pressed", "true")
    await show(page, "Groups").click()
    await sort(page, "Name").click()
    await main(page).getByRole("button", { name: "Order: A to Z", exact: true }).click()
    await search(page).fill("Alice")
    await page.goBack()
    await expect(page).toHaveURL(`${server().url}/`)
    await expect(show(page, "All")).toHaveAttribute("aria-pressed", "true")
    await expect(sort(page, "Recent")).toHaveAttribute("aria-pressed", "true")
    await expect(search(page)).toHaveValue("")
    await page.reload()
    await expect(sort(page, "Recent")).toHaveAttribute("aria-pressed", "true")
    await page.goForward()
    await expect(show(page, "Groups")).toHaveAttribute("aria-pressed", "true")
    await expect(sort(page, "Name")).toHaveAttribute("aria-pressed", "true")
    await expect(search(page)).toHaveValue("Alice")
    await expect(main(page).getByRole("button", { name: "Order: Z to A", exact: true })).toBeVisible()
    await show(page, "All").click()
    await sort(page, "Recent").click()
    await search(page).fill("")
    await expect(page).toHaveURL(`${server().url}/`)
  })
}

test("bare visits keep the existing device sort; bad parameters use defaults", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.addInitScript(({ key }) => localStorage.setItem(key, JSON.stringify({ sort: "added", reversed: true })), {
    key: `rp.cards.home.${userId}`
  })
  await page.goto(server().url)
  await expect(sort(page, "Added")).toHaveAttribute("aria-pressed", "true")
  await expect(main(page).getByRole("button", { name: "Order: Oldest first", exact: true })).toBeVisible()
  await expect(page).toHaveURL(/sort=added/)
  await page.goto(`${server().url}/?show=gone&sort=gone&reverse=sideways&q=123&pinsSort=gone`)
  await expect(show(page, "All")).toHaveAttribute("aria-pressed", "true")
  await expect(sort(page, "Recent")).toHaveAttribute("aria-pressed", "true")
  await expect(main(page).getByRole("button", { name: "Order: Newest first", exact: true })).toBeVisible()
  await expect(search(page)).toHaveValue("")
  await expect(pinsSort(page, "Recent")).toHaveAttribute("aria-pressed", "true")
  await expect(page).toHaveURL(`${server().url}/`)
  await page.reload()
  await expect(sort(page, "Recent")).toHaveAttribute("aria-pressed", "true")
})

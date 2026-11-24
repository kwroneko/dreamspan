import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { asUser } from "./support/rpc.ts"
import { seedSplitChats } from "./support/splitChats.ts"

const server = serverPerFile(withAdmin)
let seed: Effect.Success<ReturnType<typeof seedSplitChats>>
test.beforeAll(async () => {
  seed = await asUser(server(), ADMIN.handle, ADMIN.password, seedSplitChats)
})

test("the full Chats page opens and deletes individual split groups", async ({ page }) => {
  const f = await asUser(server(), ADMIN.handle, ADMIN.password, seedSplitChats)
  const group = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api
      .RenameChat({ chatId: f.chatId, name: "Full list original" })
      .pipe(
        Effect.andThen(api.NameFork({ forkId: f.harbor, name: "Full list harbor" })),
        Effect.andThen(api.GetSplitChats({ chatId: f.chatId, forkId: f.harbor }))
      )
  )
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats`)
  const list = page.getByRole("main").getByRole("list", { name: "Chats", exact: true })
  await page.getByRole("textbox", { name: "Find a chat", exact: true }).fill("Full list harbor")
  await expect(list.getByRole("listitem")).toHaveCount(1)
  const harbor = list.getByRole("link").filter({ hasText: "Full list harbor" })
  await harbor.click()
  await expect(page).toHaveURL(new RegExp(`/chats/${f.chatId}.*[?&]fork=${group.group.forkId}`))
  await page.goto(`${server().url}/chats`)
  for (const title of ["Full list original", "Full list harbor"]) {
    const row = list.getByRole("listitem").filter({ has: page.getByRole("link").filter({ hasText: title }) })
    await row.hover()
    await row.getByRole("button", { name: `Delete ${title}`, exact: true }).click()
    await expect(row).toHaveCount(0)
    await page.reload()
    await expect(list.getByText("Split demo · Lighthouse", { exact: true }).first()).toBeVisible()
    await expect(row).toHaveCount(0)
  }
})

test("Related chats reveals a parent beyond the first sidebar page", async ({ page }) => {
  await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.forEach(
      Array.from({ length: 100 }, (_, i) => i),
      (i) => api.CreateChat({ title: `Newer chat ${i}` })
    )
  )
  await page.setViewportSize({ width: 1440, height: 1200 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${seed.chatId}?fork=${seed.harbor}`)
  const chats = page.getByRole("region", { name: "Chats", exact: true })
  const parent = chats.locator(`[data-chat-id="${seed.chatId}"]`)
  await expect(chats.getByRole("button", { name: /Show \d+ more/ })).toBeVisible()
  await expect(parent).toHaveCount(0)
  const related = page.getByRole("region", { name: "Related chats", exact: true })
  await related.getByRole("link", { name: "Open chat Split demo · Journeys", exact: true }).click()
  await expect(parent).toHaveAttribute("aria-current", "page")
  await expect(parent).toBeInViewport({ ratio: 1 })
})

test("a split header uses the branch name limit and saves its longest allowed name", async ({ page }) => {
  const f = await asUser(server(), ADMIN.handle, ADMIN.password, seedSplitChats)
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${f.chatId}?fork=${f.harbor}`)
  const title = page.getByRole("main").getByRole("heading", { level: 1 }).getByRole("button")
  await title.click()
  const field = page.getByRole("textbox", { name: "Chat name", exact: true })
  await expect(field).toHaveAttribute("maxlength", "100")
  const name = "Harbor ".padEnd(100, "x")
  await field.fill(name)
  await field.press("Enter")
  await expect(title).toHaveText(name)
  await page.goto(`${server().url}/chats/${f.chatId}?fork=${f.original}`)
  await title.click()
  await expect(field).toHaveAttribute("maxlength", "200")
})

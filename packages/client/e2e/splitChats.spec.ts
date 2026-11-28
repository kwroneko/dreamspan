import { exercisePhoneFooters } from "./support/phoneFooters.ts"
import { expect, type Locator, test } from "@playwright/test"
import { Effect } from "effect"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { asUser } from "./support/rpc.ts"
import { seedSplitChats } from "./support/splitChats.ts"
import { showAppNavigation, hideAppNavigation } from "./support/appMenu.ts"

const server = serverPerFile(withAdmin)
let seed: Effect.Success<ReturnType<typeof seedSplitChats>>
test.beforeAll(async () => {
  seed = await asUser(server(), ADMIN.handle, ADMIN.password, seedSplitChats)
})

const expandRelated = async (section: Locator, count: number) => {
  const header = section.getByRole("button", { name: `Related chats (${count})`, exact: true })
  await expect(header).toBeVisible()
  if ((await header.getAttribute("aria-expanded")) === "false") await header.click()
}

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`split chats navigate between groups at ${width} ${theme}`, async ({ page }) => {
      // Keep enough room to expand both footer lists beside the global pin.
      await page.setViewportSize({ width, height: width === 390 ? 1400 : 1200 })
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        api.SetChatPin({ chatId: seed.groupId, leaf: null, pinned: true })
      )
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/chats/${seed.chatId}?fork=${seed.original}`)
      if (width === 390) await expect(page.getByRole("button", { name: "Chats and menu", exact: true })).toBeVisible()
      await showAppNavigation(page)
      const splits = page.getByRole("region", { name: "Related chats", exact: true })
      const source = splits.getByRole("group", { name: "This chat was split from", exact: true })
      const splitOff = splits.getByRole("group", { name: "Split off from this chat", exact: true })
      const branches = page.getByRole("region", { name: "Branches of the open chat", exact: true })
      const chats = page.getByRole("region", { name: "Chats", exact: true })
      await expandRelated(splits, 3)
      await expect(source).toHaveCount(0)
      await expect(splitOff.locator("[data-fork-row]")).toHaveCount(3)
      const branchHeader = branches.getByRole("button", { name: /^Branches of / })
      await expect(branchHeader).toBeVisible()
      if ((await branchHeader.getAttribute("aria-expanded")) === "false") await branchHeader.click()
      await expect(branches.getByRole("button", { name: /^Open branch / })).toHaveCount(2)
      await splits.getByRole("link", { name: "Open chat Split demo · Harbor", exact: true }).click()
      await showAppNavigation(page)
      await expandRelated(splits, 2)
      const parent = source.getByRole("link", { name: "Open chat Split demo · Journeys", exact: true })
      await expect(parent).toBeVisible()
      await expect(source.locator("[data-row-relation]")).toHaveText(/^Shares messages #1–2 · split /)
      await expect(splitOff.getByRole("link", { name: "Open chat Split demo · Lighthouse", exact: true })).toBeVisible()
      await expect(splitOff.locator("[data-row-relation]")).toHaveText(/^Shares messages #1–3 · split /)
      await expect(branches.getByRole("button", { name: /^Open branch / })).toHaveCount(2)
      const selected = chats.locator(`[data-chat-id="${seed.harbor}"]`)
      await expect(selected).toHaveAttribute("aria-current", "page")
      await expect(selected).toBeInViewport({ ratio: 1 })
      // A shorter split list retains the same reserved height.
      await parent.click()
      await showAppNavigation(page)
      await expect(splits.getByRole("button", { name: "Related chats (3)", exact: true })).toBeVisible()
      await expect(chats.locator(`[data-chat-id="${seed.chatId}"]`)).toHaveAttribute("aria-current", "page")
      await expect(source).toHaveCount(0)
      // The same links are available in the history, and follow the unchanged branch tree.
      await hideAppNavigation(page)
      await expect(
        page.locator("[data-split-divider]").filter({ hasText: "Split off from this chat here" })
      ).toBeVisible()
      await page.locator("[data-split-divider]").getByRole("link", { name: "Split demo · Harbor", exact: true }).click()
      await expect(
        page
          .locator("[data-split-divider]")
          .filter({ hasText: "This chat was split from “Split demo · Journeys” here" })
      ).toBeVisible()
      await showAppNavigation(page)
      await expandRelated(splits, 2)
      await splits.getByRole("link", { name: "Open chat Split demo · Lighthouse", exact: true }).click()
      await showAppNavigation(page)
      await expandRelated(splits, 1)
      await expect(source.getByRole("link", { name: "Open chat Split demo · Harbor", exact: true })).toBeVisible()
      await expect(splitOff).toHaveCount(0)
    })
  }

test("split action acts on the branch shown and supports undo", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${seed.chatId}?fork=${seed.original}`)
  await page.getByRole("button", { name: "Chat actions", exact: true }).click()
  await expect(page.getByRole("menuitem", { name: "Make this branch its own chat", exact: true })).toHaveCount(0)
  await page.keyboard.press("Escape")
  await page.goto(`${server().url}/chats/${seed.chatId}?fork=${seed.market}`)
  await page.getByRole("button", { name: "Chat actions", exact: true }).click()
  await page.getByRole("menuitem", { name: "Make this branch its own chat", exact: true }).click()
  await page
    .getByRole("dialog", { name: "Make this branch its own chat?", exact: true })
    .getByRole("button", { name: "Make its own chat", exact: true })
    .click()
  await expect(page.getByText("Branch is now its own chat", { exact: true })).toBeVisible()
  // The window's height may leave Related chats collapsed to its header: check the count and its source row.
  const related = page.getByRole("region", { name: "Related chats", exact: true })
  await expect(related.getByRole("button", { name: "Related chats (1)", exact: true })).toBeVisible()
  await expect(related.locator(`[aria-label="This chat was split from"] [data-chat-id="${seed.groupId}"]`)).toHaveCount(
    1
  )
  await page.getByRole("button", { name: "Undo", exact: true }).click()
  await expect(
    page
      .getByRole("region", { name: "Related chats", exact: true })
      .getByRole("button", { name: "Related chats (2)", exact: true })
  ).toBeVisible()
})

for (const width of [1440, 390])
  for (const original of [false, true]) {
    test(`deletes and restores only the ${original ? "original" : "split"} group at ${width}`, async ({ page }) => {
      const f = await asUser(server(), ADMIN.handle, ADMIN.password, seedSplitChats)
      const fork = original ? f.original : f.harbor
      await page.setViewportSize({ width, height: 900 })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/chats/${f.chatId}?fork=${fork}`)
      await page.getByRole("button", { name: "Chat actions", exact: true }).click()
      await page.getByRole("menuitem", { name: "Delete chat", exact: true }).click()
      const dialog = page.getByRole("dialog", { name: /^Delete / })
      await expect(dialog).toContainText("Moves 2 branches to the bin.")
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
      await expect(dialog).toHaveCount(0)
      await page.getByRole("button", { name: "Chat actions", exact: true }).click()
      await page.getByRole("menuitem", { name: "Delete chat", exact: true }).click()
      await dialog.getByRole("button", { name: "Delete chat", exact: true }).click()
      await expect(dialog).toHaveCount(0)
      await showAppNavigation(page)
      const chats = page.getByRole("region", { name: "Chats", exact: true })
      const removedId = original ? f.chatId : f.harbor
      await expect(chats.locator(`[data-chat-id="${removedId}"]`)).toHaveCount(0)
      await expect(chats.locator(`[data-chat-id="${f.lighthouse}"]`)).toHaveCount(1)
      const group = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        api.GetSplitChats({ chatId: f.chatId, forkId: f.lighthouse })
      )
      expect(String(group.parent?.id)).toBe(String(original ? f.harbor : f.chatId))
      await hideAppNavigation(page)
      await page.getByRole("button", { name: "Undo", exact: true }).click()
      await showAppNavigation(page)
      await expect(chats.locator(`[data-chat-id="${removedId}"]`)).toHaveCount(1)
      const restored = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        api.GetSplitChats({ chatId: f.chatId, forkId: fork })
      )
      expect(restored.forkIds).toHaveLength(2)
    })
  }

for (const width of [1440, 390]) {
  test(`small and absent related chats give space to Chats at ${width}`, async ({ page }) => {
    await asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.CreateChat({ title: "No split sizing" }))
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/chats/${seed.chatId}?fork=${seed.original}&side=chats`)
    if (width === 390) await expect(page.getByRole("button", { name: "Chats and menu", exact: true })).toBeVisible()
    await showAppNavigation(page)
    const branches = page.getByRole("region", { name: "Branches of the open chat", exact: true })
    await expect(branches).toHaveAttribute("aria-busy", "false")
    const listHeight = () =>
      page
        .locator("[data-shell-list]")
        .filter({ visible: true })
        .evaluate((el) => el.clientHeight)
    for (const title of ["Split demo · Harbor", "Split demo · Hills", "No split sizing", "Split demo · Journeys"]) {
      await page
        .locator("[data-shell-list]")
        .filter({ visible: true })
        .getByRole("link", { name: `Open chat ${title}`, exact: true })
        .first()
        .click()
      await showAppNavigation(page)
      await expect(branches.getByRole("button", { name: new RegExp(`^Branches of ${title}`) })).toBeVisible()
      await expect(branches).toHaveAttribute("aria-busy", "false")
      const threeRows = await page
        .locator("[data-shell-list]")
        .filter({ visible: true })
        .evaluate((el) => {
          const third = el.querySelectorAll<HTMLElement>("[data-fork-row]")[2]!
          return third.getBoundingClientRect().bottom - el.getBoundingClientRect().top + el.scrollTop
        })
      // A short phone with Pinned-chat controls can be too small even after
      // both lists collapse. No expanded footer may take space in that case.
      if ((await listHeight()) < threeRows - 1) {
        const browser = page.locator("[data-shell-list]").filter({ visible: true }).locator("..")
        await expect(browser.locator('[data-foot-body][aria-hidden="false"]')).toHaveCount(0)
      }
      const unused = await page
        .locator("[data-shell-list]")
        .filter({ visible: true })
        .evaluate((el) => {
          const footer = el.parentElement!.querySelector<HTMLElement>("[data-sidebar-feet]")!
          const gap = parseFloat(getComputedStyle(el.parentElement!).rowGap)
          return footer.getBoundingClientRect().top - el.getBoundingClientRect().bottom - gap
        })
      expect(Math.abs(unused)).toBeLessThanOrEqual(1)
    }
  })
}

test("auto-collapsed phone footers open on click and close on the next click", async ({ page }, info) => {
  await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.SetChatPin({ chatId: seed.groupId, leaf: null, pinned: false })
  )
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await exercisePhoneFooters(page, info, `${server().url}/chats/${seed.chatId}?fork=${seed.original}&side=chats`)
})

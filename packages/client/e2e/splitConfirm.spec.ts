// Splitting a branch into its own chat: the explanatory confirmation from every entry point, the
// selected branch row's corner button, the branch pin's side and the composer chips' shape.
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { asUser } from "./support/rpc.ts"
import { seedSplitChats } from "./support/splitChats.ts"
import { showAppNavigation } from "./support/appMenu.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "400", FAKE_GENERATOR_TOKENS: "20" })
const shots = process.env.SPLITCONFIRM_SHOTS
const seed = () => asUser(server(), ADMIN.handle, ADMIN.password, seedSplitChats)

const open = async (page: Page, path: string, width: number, theme: "light" | "dark") => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
  await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}${path}`)
  await expect(page.getByTestId("composer")).toBeVisible()
}

const branches = (page: Page) => page.getByRole("region", { name: "Branches of the open chat", exact: true })
/** Shows the open chat's branches; a phone's short column starts with them collapsed. */
const showBranches = async (page: Page) => {
  await showAppNavigation(page)
  const header = branches(page).getByRole("button", { name: /^Branches of / })
  await expect(header).toBeVisible()
  if ((await header.getAttribute("aria-expanded")) !== "true") await header.click()
  await expect(header).toHaveAttribute("aria-expanded", "true")
}
const branchRow = (page: Page, forkId: string) =>
  branches(page)
    .locator("[data-fork-row]")
    .filter({ has: page.locator(`[data-fork-id="${forkId}"]`) })
const confirm = (page: Page) => page.getByRole("dialog", { name: "Make this branch its own chat?", exact: true })
const chatRow = (page: Page, groupId: string) =>
  page.getByRole("region", { name: "Chats", exact: true }).locator(`button[data-chat-id="${groupId}"]`)

/** An unnamed branch of Market route, shown in the Harbor group's branches. */
const unnamedBranch = (f: Effect.Success<ReturnType<typeof seedSplitChats>>) =>
  asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const { fork } = yield* api.CreateFork({ chatId: f.chatId, fromForkId: f.market, atSlotId: f.quay })
      yield* api.SendMessage({
        chatId: f.chatId,
        forkId: fork.id,
        parentSlotId: f.quay,
        branch: false,
        content: "A quiet lane leads away from the market."
      })
      return fork.id
    })
  )

test("the menu asks first; Cancel changes nothing", async ({ page }) => {
  const f = await seed()
  await open(page, `/chats/${f.chatId}?fork=${f.market}`, 1440, "light")
  await page.getByRole("button", { name: "Chat actions", exact: true }).click()
  await page.getByRole("menuitem", { name: "Make this branch its own chat", exact: true }).click()
  const dialog = confirm(page)
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText("“Market route” and the branches made from it leave “Split demo · Harbor”")
  // A named branch's own name wins over the chat's title.
  await expect(dialog.getByLabel("Chat title", { exact: true })).toHaveValue("Market route")
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByText("Branch is now its own chat", { exact: true })).toHaveCount(0)
  await expect(branchRow(page, f.market)).toBeVisible()
  const state = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.GetSplitChats({ chatId: f.chatId, forkId: f.market })
  )
  expect(state.group.rootForkId).toBe(f.harbor)
})

test("the menu's confirmation applies the edited title", async ({ page }) => {
  const f = await seed()
  await open(page, `/chats/${f.chatId}?fork=${f.market}`, 1440, "dark")
  await page.getByRole("button", { name: "Chat actions", exact: true }).click()
  await page.getByRole("menuitem", { name: "Make this branch its own chat", exact: true }).click()
  const title = confirm(page).getByLabel("Chat title", { exact: true })
  await title.fill("Market days")
  await confirm(page).getByRole("button", { name: "Make its own chat", exact: true }).click()
  await expect(page.getByText("Branch is now its own chat", { exact: true })).toBeVisible()
  await expect(chatRow(page, f.market)).toContainText("Market days")
  await expect(
    page
      .getByRole("region", { name: "Split chats", exact: true })
      .getByRole("link", { name: "From “Split demo · Harbor”" })
  ).toBeVisible()
})

for (const width of [1440, 390])
  test(`the selected branch row's corner button splits after confirming at ${width}`, async ({ page }) => {
    const f = await seed()
    const unnamed = await unnamedBranch(f)
    // The group's own first branch can't be split off: no button on it, even selected.
    await open(page, `/chats/${f.chatId}?fork=${f.harbor}`, width, "light")
    await showBranches(page)
    await expect(branchRow(page, f.harbor)).toBeVisible()
    await expect(branches(page).getByRole("button", { name: /its own chat$/ })).toHaveCount(0)
    await page.goto(`${server().url}/chats/${f.chatId}?fork=${unnamed}`)
    await expect(page.getByTestId("composer")).toBeVisible()
    await showBranches(page)
    // Only the selected row has it.
    const button = branches(page).getByRole("button", { name: /its own chat$/ })
    await expect(button).toHaveCount(1)
    await expect(branchRow(page, unnamed).getByRole("button", { name: /its own chat$/ })).toBeVisible()
    await button.hover()
    await expect(
      page.getByText("Moves this branch and the branches made from it into a chat of their own.", { exact: true })
    ).toBeVisible()
    // The bottom-right corner, under the pin, as a chat row's branch list button sits.
    const row = (await branchRow(page, unnamed).boundingBox())!
    const pin = (await branchRow(page, unnamed)
      .getByRole("button", { name: /^(Pin|Unpin) / })
      .boundingBox())!
    const split = (await button.boundingBox())!
    expect(split.y).toBeGreaterThan(pin.y + pin.height - 1)
    expect(Math.abs(split.x + split.width - (pin.x + pin.width))).toBeLessThanOrEqual(1)
    expect(row.y + row.height - (split.y + split.height)).toBeLessThan(16)
    await button.click()
    const dialog = confirm(page)
    // An unnamed branch starts from the title of the chat it leaves.
    await expect(dialog.getByLabel("Chat title", { exact: true })).toHaveValue("Split demo · Harbor")
    await dialog.getByLabel("Chat title", { exact: true }).fill(`Quiet lane ${width}`)
    await dialog.getByRole("button", { name: "Make its own chat", exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByText("Branch is now its own chat", { exact: true })).toBeVisible()
    await showAppNavigation(page)
    await expect(chatRow(page, unnamed)).toContainText(`Quiet lane ${width}`)
  })

test("the chat's branch list in the panel has the button too; Escape cancels", async ({ page }) => {
  const f = await seed()
  await open(page, `/chats/${f.chatId}?fork=${f.market}&side=chats&forks=${f.harbor}`, 1440, "light")
  const panel = page.getByRole("complementary", { name: "Sidebar", exact: true })
  const button = panel.getByRole("button", { name: "Make Market route its own chat", exact: true })
  await expect(button).toHaveCount(1)
  await button.click()
  await expect(confirm(page)).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(confirm(page)).toHaveCount(0)
  // Still where it was: a branch of Harbor, and the page didn't navigate.
  await expect(page).toHaveURL(new RegExp(`fork=${f.market}`))
  const state = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.GetSplitChats({ chatId: f.chatId, forkId: f.market })
  )
  expect(state.group.rootForkId).toBe(f.harbor)
})

for (const width of [1440, 390])
  test(`branch pins sit in the top-right corner, as chat pins do, at ${width}`, async ({ page }) => {
    const f = await seed()
    await open(page, `/chats/${f.chatId}?fork=${f.market}`, width, "light")
    await showBranches(page)
    const corner = async (row: ReturnType<Page["locator"]>) => {
      const box = (await row.boundingBox())!
      const pin = (await row
        .getByRole("button", { name: /^(Pin|Unpin) / })
        .first()
        .boundingBox())!
      return { top: pin.y - box.y, right: box.x + box.width - (pin.x + pin.width) }
    }
    const chat = await corner(
      page.getByRole("region", { name: "Chats", exact: true }).locator("[data-fork-row]").first()
    )
    for (const forkId of [f.market, f.harbor]) {
      const branch = await corner(branchRow(page, forkId))
      expect(Math.abs(branch.top - chat.top)).toBeLessThanOrEqual(4)
      expect(Math.abs(branch.right - chat.right)).toBeLessThanOrEqual(1)
    }
  })

test("composer row dropdowns are rounded rectangles like buttons", async ({ page }) => {
  const f = await seed()
  await open(page, `/chats/${f.chatId}?fork=${f.market}`, 1440, "light")
  const button = await page
    .getByRole("button", { name: "Chat actions", exact: true })
    .evaluate((node) => getComputedStyle(node).borderTopLeftRadius)
  expect(button).toBe("6px")
  const strip = page.getByRole("group", { name: "Next reply", exact: true })
  await expect(strip.locator("button").first()).toBeVisible()
  const radii = await strip
    .locator("button")
    .evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).borderTopLeftRadius))
  expect(radii.length).toBeGreaterThan(2)
  for (const radius of radii) expect(radius).toBe(button)
  const speaker = page.getByRole("button", { name: /^(Speaking|Playing) as / })
  expect(await speaker.evaluate((node) => getComputedStyle(node).borderTopLeftRadius)).toBe(button)
})

if (shots)
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"] as const)
      test(`captures the sidebar, modal and composer at ${width} ${theme}`, async ({ page }) => {
        const f = await seed()
        mkdirSync(shots, { recursive: true })
        const shot = (name: string) =>
          page.screenshot({ path: join(shots, `${name}-${width}-${theme}.png`), animations: "disabled" })
        await open(page, `/chats/${f.chatId}?fork=${f.market}`, width, theme)
        await page.mouse.move(0, 0)
        await shot("composer")
        await showBranches(page)
        await expect(branchRow(page, f.market).getByRole("button", { name: /its own chat$/ })).toBeVisible()
        await shot("sidebar")
        await branchRow(page, f.market)
          .getByRole("button", { name: /its own chat$/ })
          .click()
        await expect(confirm(page)).toBeVisible()
        await shot("modal")
      })

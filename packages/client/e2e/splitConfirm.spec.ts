// Splitting a branch into its own chat: the explanatory confirmation from every entry point, the
// selected branch row's corner button, the branch pin's side and the composer chips' shape.
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { type Client, loginCookie, withCookie } from "./support/rpc.ts"
import { seedSplitChats } from "./support/splitChats.ts"
import { showAppNavigation } from "./support/appMenu.ts"

const server = serverPerFile({
  ...withAdmin,
  FAKE_GENERATOR_TPS: "10",
  FAKE_GENERATOR_TOKENS: "200",
  ...(process.env.SPLITCONFIRM_CLIENT_DIST ? { CLIENT_DIST: process.env.SPLITCONFIRM_CLIENT_DIST } : {})
})
const shots = process.env.SPLITCONFIRM_SHOTS
let cookie = ""
test.beforeAll(async () => {
  cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
})
const admin = <A>(use: (api: Client) => Effect.Effect<A, unknown>) => withCookie(server(), cookie, use)
const seed = () => admin(seedSplitChats)

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

const openConfirmation = async (page: Page, chatId: string, forkId: string) => {
  await open(page, `/chats/${chatId}?fork=${forkId}`, 1440, "light")
  await page.getByRole("button", { name: "Chat actions", exact: true }).click()
  await page.getByRole("menuitem", { name: "Make this branch its own chat", exact: true }).click()
  await expect(confirm(page)).toBeVisible()
}

test("a refused split never changes the branch title", async ({ page }) => {
  await page.routeWebSocket(/\/rpc$/, (socket) => {
    const upstream = socket.connectToServer()
    socket.onMessage((data) => {
      const request = typeof data === "string" ? (JSON.parse(data) as { tag?: string; id?: string }) : null
      if (request?.tag === "SetSplitChat") {
        socket.send(
          JSON.stringify({
            _tag: "Exit",
            requestId: request.id,
            exit: {
              _tag: "Failure",
              cause: [{ _tag: "Fail", error: { _tag: "ServerError", message: "Split refused" } }]
            }
          })
        )
      } else upstream.send(data)
    })
    upstream.onMessage((data) => socket.send(data))
  })
  const f = await seed()
  await openConfirmation(page, f.chatId, f.market)
  await confirm(page).getByLabel("Chat title", { exact: true }).fill("Refused title")
  await confirm(page).getByRole("button", { name: "Make its own chat", exact: true }).click()
  await expect(confirm(page).getByRole("alert")).toBeVisible()
  const forks = await admin((api) => api.ListForks({ chatId: f.chatId }))
  expect(forks.find((fork) => fork.id === f.market)!.name).toBe("Market route")
})

test("a rename in another tab is preserved when confirming an older title", async ({ page }) => {
  const f = await seed()
  await openConfirmation(page, f.chatId, f.market)
  await admin((api) => api.NameFork({ forkId: f.market, name: "Other tab" }))
  await confirm(page).getByLabel("Chat title", { exact: true }).fill("Stale title")
  await confirm(page).getByRole("button", { name: "Make its own chat", exact: true }).click()
  await expect(confirm(page).getByRole("alert")).toBeVisible()
  const forks = await admin((api) => api.ListForks({ chatId: f.chatId }))
  expect(forks.find((fork) => fork.id === f.market)!.name).toBe("Other tab")
  const state = await admin((api) => api.GetSplitChats({ chatId: f.chatId, forkId: f.market }))
  expect(state.group.rootForkId).toBe(f.harbor)
})

test("Undo preserves a title changed after the split", async ({ page }) => {
  const f = await seed()
  await openConfirmation(page, f.chatId, f.market)
  await confirm(page).getByLabel("Chat title", { exact: true }).fill("Split title")
  await confirm(page).getByRole("button", { name: "Make its own chat", exact: true }).click()
  await expect(page.getByText("Branch is now its own chat", { exact: true })).toBeVisible()
  await admin((api) => api.NameFork({ forkId: f.market, name: "Later title" }))
  await page.getByRole("button", { name: "Undo", exact: true }).click()
  await expect(page.getByText("Couldn't restore the branch", { exact: true })).toBeVisible()
  const forks = await admin((api) => api.ListForks({ chatId: f.chatId }))
  expect(forks.find((fork) => fork.id === f.market)!.name).toBe("Later title")
  const state = await admin((api) => api.GetSplitChats({ chatId: f.chatId, forkId: f.market }))
  expect(state.group.rootForkId).toBe(f.market)
})

test("two same-turn submits split once and Undo restores the original name", async ({ page }) => {
  let splits = 0
  await page.routeWebSocket(/\/rpc$/, (socket) => {
    const upstream = socket.connectToServer()
    socket.onMessage((data) => {
      if (typeof data === "string") {
        const request = JSON.parse(data) as { tag?: string; payload?: { split?: boolean } }
        if (request.tag === "SetSplitChat" && request.payload?.split) splits++
      }
      upstream.send(data)
    })
    upstream.onMessage((data) => socket.send(data))
  })
  const f = await seed()
  await openConfirmation(page, f.chatId, f.market)
  await confirm(page).getByLabel("Chat title", { exact: true }).fill("  Split   title  ")
  await confirm(page)
    .locator("form")
    .evaluate((form: HTMLFormElement) => {
      form.requestSubmit()
      form.requestSubmit()
    })
  await expect(page.getByText("Branch is now its own chat", { exact: true })).toHaveCount(1)
  // The commit queue drains before the next read through the same browser socket.
  await page.getByRole("button", { name: "Chat actions", exact: true }).click()
  await expect(page.getByRole("menuitem", { name: "Make this branch its own chat", exact: true })).toHaveCount(0)
  expect(splits).toBe(1)
  await page.keyboard.press("Escape")
  await page.getByRole("button", { name: "Undo", exact: true }).click()
  await expect
    .poll(async () => {
      const forks = await admin((api) => api.ListForks({ chatId: f.chatId }))
      return forks.find((fork) => fork.id === f.market)!.name
    })
    .toBe("Market route")
})

test("an unnamed branch keeps a long parent chat title", async ({ page }) => {
  const f = await seed()
  const title = "A long story title ".repeat(9).trim()
  await admin((api) => api.RenameChat({ chatId: f.chatId, name: title }))
  // Use a child of the original chat, whose title supports 200 characters.
  const fork = await admin((api) => api.CreateFork({ chatId: f.chatId, fromForkId: f.original, atSlotId: f.splitAt }))
  await openConfirmation(page, f.chatId, fork.fork.id)
  await expect(confirm(page).getByLabel("Chat title", { exact: true })).toHaveValue(title)
  await confirm(page).getByRole("button", { name: "Make its own chat", exact: true }).click()
  await expect(confirm(page)).toHaveCount(0)
  await expect(chatRow(page, fork.fork.id)).toContainText(title)
})

test("a branch deleted in another tab cannot be split", async ({ page }) => {
  const f = await seed()
  await openConfirmation(page, f.chatId, f.market)
  await admin((api) => api.DeleteFork({ forkId: f.market }))
  // A live reload may already have dismissed the deleted branch's dialog.
  await confirm(page)
    .locator("form")
    .evaluateAll((forms) => forms.forEach((form) => (form as HTMLFormElement).requestSubmit()))
  await expect
    .poll(async () => (await confirm(page).count()) === 0 || (await confirm(page).getByRole("alert").count()) > 0)
    .toBe(true)
  await expect(page.getByText("Branch is now its own chat", { exact: true })).toHaveCount(0)
  const forks = await admin((api) => api.ListForks({ chatId: f.chatId }))
  expect(forks.some((fork) => fork.id === f.market)).toBe(false)
})

test("splitting while generating keeps the reply on the same branch", async ({ page }) => {
  const f = await seed()
  await openConfirmation(page, f.chatId, f.market)
  const generated = await admin((api) =>
    Effect.gen(function* () {
      const fork = (yield* api.ListForks({ chatId: f.chatId })).find((branch) => branch.id === f.market)!
      return yield* api.Generate({ chatId: f.chatId, forkId: f.market, parentSlotId: fork.tipSlotId, branch: false })
    })
  )
  if (generated._tag !== "Posted") throw new Error("Expected a running reply")
  expect(generated.entry.version.status).toBe("generating")
  await confirm(page).getByLabel("Chat title", { exact: true }).fill("Still writing")
  await confirm(page).getByRole("button", { name: "Make its own chat", exact: true }).click()
  await expect(confirm(page)).toHaveCount(0)
  await expect
    .poll(
      async () => {
        const path = await admin((api) =>
          api.ReadPath({ chatId: f.chatId, forkId: f.market, leafSlotId: null, range: { _tag: "Bottom" }, limit: 100 })
        )
        return path.entries.find((entry) => entry.version.id === generated.entry.version.id)?.version.status
      },
      { timeout: 40_000 }
    )
    .toBe("complete")
  const state = await admin((api) => api.GetSplitChats({ chatId: f.chatId, forkId: f.market }))
  expect(state.group.rootForkId).toBe(f.market)
  expect(state.group.title).toBe("Still writing")
})

/** An unnamed branch of Market route, shown in the Harbor group's branches. */
const unnamedBranch = (f: Effect.Success<ReturnType<typeof seedSplitChats>>) =>
  admin((api) =>
    Effect.gen(function* () {
      const { fork } = yield* api.CreateFork({ chatId: f.chatId, fromForkId: f.market, atSlotId: f.quay })
      const companion = yield* api.CreateCard({ label: "Synthetic companion", name: "Companion" })
      yield* api.ChangeCast({
        chatId: f.chatId,
        forkId: fork.id,
        slotId: f.quay,
        change: { _tag: "Join", entityId: companion.entityId }
      })
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
  const state = await admin((api) => api.GetSplitChats({ chatId: f.chatId, forkId: f.market }))
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

for (const width of [1440, 1024, 390])
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
  const state = await admin((api) => api.GetSplitChats({ chatId: f.chatId, forkId: f.market }))
  expect(state.group.rootForkId).toBe(f.harbor)
})

for (const width of [1440, 1024, 390])
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

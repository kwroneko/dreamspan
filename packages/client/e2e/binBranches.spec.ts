// The branches a "delete for good" affects (owner, 2026-11-01): the confirmation lists every one,
// marked as still showing the text or holding it only in the bin, each a link to that branch at
// that message, highlighted, which opens in a new tab and leaves the dialog as it was; hundreds of
// branches scroll inside a dialog that stays within the screen. With BIN_BRANCH_SHOTS set, the
// dialog is saved in both themes.
import { expect, test, type Page } from "@playwright/test"
import { Effect } from "effect"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile({ ...withAdmin, DB_WORKERS: "bundle" })
type Api = Parameters<Parameters<typeof asUser>[3]>[0]
const admin = <A>(use: (api: Api) => Effect.Effect<A, unknown>) => asUser(server(), ADMIN.handle, ADMIN.password, use)

const shots = async (page: Page, name: string, width: number) => {
  const dir = process.env.BIN_BRANCH_SHOTS
  if (!dir) return
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme })
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${dir}/${name}-${width}-${colorScheme}.png`, animations: "disabled" })
  }
  await page.emulateMedia({ colorScheme: "light" })
}

/**
 * A chat `Common root → A shared message → …` whose first branch deleted the shared message,
 * with "Side road" still showing it and "Old road", which showed it, in the bin; and `extra`
 * more branches made at it.
 */
const seeded = (title: string, extra = 0) =>
  admin((api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title })
      const send = (
        parentSlotId: Parameters<typeof api.SendMessage>[0]["parentSlotId"],
        content: string,
        branch = false
      ) =>
        Effect.map(api.SendMessage({ chatId: chat.id, parentSlotId, content, branch }), (result) => {
          if (result._tag !== "Posted") throw new Error("expected posted")
          return result.entry
        })
      const root = (yield* send(null, "Common root")).slotId
      const shared = (yield* send(root, "A shared message")).slotId
      yield* send(shared, "Only the first branch has this")
      const old = yield* send(shared, "Down the old road", true)
      yield* api.NameFork({ forkId: old.startsForkId!, name: "Old road" })
      const side = yield* send(shared, "Down the side road", true)
      yield* api.NameFork({ forkId: side.startsForkId!, name: "Side road" })
      for (let i = 0; i < extra; i++) {
        const made = yield* api.CreateFork({ chatId: chat.id, fromForkId: side.startsForkId!, atSlotId: shared })
        yield* api.NameFork({ forkId: made.fork.id, name: `Road ${i + 1}` })
      }
      yield* api.DeleteFork({ forkId: old.startsForkId! })
      const first = (yield* api.ListForks({ chatId: chat.id })).find((fork) => fork.parentForkId === null)!
      yield* api.DeleteMessage({ slotId: shared, forkId: first.id })
      return { chatId: chat.id, root, shared, first: first.id, side: side.startsForkId! }
    })
  )

const messageRow = (page: Page, title: string) =>
  page.getByRole("listitem", { name: new RegExp(`^Message \\d+ in “${title}”$`) })

for (const width of [1440, 390]) {
  test(`the confirmation lists and links every affected branch, at ${width}`, async ({ page, context }) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const title = `Harbor road ${width}`
    const { chatId, root, shared, first, side } = await seeded(title)

    await page.goto(`${server().url}/bin`)
    await messageRow(page, title).getByRole("button", { name: "Delete for good" }).click()
    const dialog = page.getByRole("alertdialog")
    // Plain words, the chat named in the body.
    await expect(dialog.getByRole("heading", { name: "Delete message 2 for good?" })).toBeVisible()
    await expect(dialog.getByText(`From the chat “${title}”.`, { exact: false })).toBeVisible()
    const list = dialog.getByRole("list", { name: /^Affected branches/ })
    await expect(list.getByRole("listitem")).toHaveCount(3)
    await expect(dialog.getByText("3 branches affected")).toBeVisible()
    await expect(
      dialog.getByText(/1 still shows the text and loses it too\. 2 hold it only in the bin\./)
    ).toBeVisible()

    // Side road still shows it, as message 2, and links there.
    const sideEntry = list.getByRole("listitem").filter({ hasText: "Side road" })
    await expect(sideEntry.getByText("Shows it", { exact: true })).toBeVisible()
    await expect(sideEntry.getByText("Message 2", { exact: false })).toBeVisible()
    const sideLink = sideEntry.getByRole("link")
    await expect(sideLink).toHaveAttribute("href", `/chats/${chatId}?slot=${shared}&fork=${side}`)
    await expect(sideLink).toHaveAttribute("target", "_blank")
    // The first branch deleted it: in the bin there, its link at the message above.
    const firstEntry = list.getByRole("listitem").filter({ hasText: "Original" })
    await expect(firstEntry.getByText("In the bin", { exact: true })).toBeVisible()
    await expect(firstEntry.getByText(/Message 2, deleted in this branch · opens at message 1, above it/)).toBeVisible()
    await expect(firstEntry.getByRole("link")).toHaveAttribute("href", `/chats/${chatId}?slot=${root}&fork=${first}`)
    // Old road is in the bin itself: nothing to open.
    const oldEntry = list.getByRole("listitem").filter({ hasText: "Old road" })
    await expect(oldEntry.getByText("In the bin", { exact: true })).toBeVisible()
    await expect(oldEntry.getByText("The branch is in the bin", { exact: false })).toBeVisible()
    await expect(oldEntry.getByRole("link")).toHaveCount(0)
    await shots(page, "purge-branches", width)

    // A plain click opens the branch at the message, highlighted, in a new tab; the dialog stays.
    const opened = context.waitForEvent("page")
    await sideLink.click()
    const tab = await opened
    await tab.waitForLoadState()
    const article = tab.locator(`article[data-slot="${shared}"]`)
    await expect(article).toBeVisible()
    await expect(article).toHaveClass(/border-accent/)
    await expect(tab.getByTestId("messages").getByText("Down the side road")).toBeVisible()
    await tab.close()
    const above = context.waitForEvent("page")
    await firstEntry.getByRole("link").click()
    const firstTab = await above
    await expect(firstTab.locator(`article[data-slot="${root}"]`)).toHaveClass(/border-accent/)
    await expect(firstTab.getByTestId("messages").getByText("Only the first branch has this")).toBeVisible()
    await firstTab.close()
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole("button", { name: "Delete for good" })).toBeEnabled()

    // Confirming still erases it everywhere.
    await dialog.getByRole("button", { name: "Delete for good" }).click()
    await expect(messageRow(page, title)).toHaveCount(0)
  })

  test(`three hundred branches scroll inside a dialog within the screen, at ${width}`, async ({ page }) => {
    test.setTimeout(300_000)
    const height = width === 390 ? 844 : 900
    await page.setViewportSize({ width, height })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const title = `Many roads ${width}`
    await seeded(title, 298)
    await page.goto(`${server().url}/bin`)
    await messageRow(page, title).getByRole("button", { name: "Delete for good" }).click()
    const dialog = page.getByRole("alertdialog")
    const list = dialog.getByRole("list", { name: /^Affected branches/ })
    await expect(list.getByRole("listitem")).toHaveCount(301)
    await expect(dialog.getByText("301 branches affected")).toBeVisible()
    const box = (await dialog.boundingBox())!
    expect(box.y).toBeGreaterThanOrEqual(0)
    expect(box.y + box.height).toBeLessThanOrEqual(height)
    expect(box.x + box.width).toBeLessThanOrEqual(width)
    // The buttons stay on screen; the list scrolls to its last branch.
    await expect(dialog.getByRole("button", { name: "Delete for good" })).toBeInViewport()
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeInViewport()
    const last = list.getByRole("listitem").filter({ hasText: "Road 298" })
    await last.scrollIntoViewIfNeeded()
    await expect(last).toBeInViewport()
    await expect(dialog.getByRole("button", { name: "Delete for good" })).toBeInViewport()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    await shots(page, "purge-branches-300", width)
  })
}

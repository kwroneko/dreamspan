// Deleting per fork (spec/FORK-INDEPENDENCE-DELTA.md §2.4): the chat's branch menu deletes the fork
// shown, and only it; the bin names a deleted fork; and deleting a message for good, in the bin, warns
// which other forks show its text before erasing it everywhere (owner, 2026-10-27). With
// FI5_SCREENSHOTS set, each step saves a screenshot.
import { expect, test, type Page } from "@playwright/test"
import { Effect } from "effect"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile({ ...withAdmin, DB_WORKERS: "bundle" })
type Api = Parameters<Parameters<typeof asUser>[3]>[0]
const admin = <A>(use: (api: Api) => Effect.Effect<A, unknown>) => asUser(server(), ADMIN.handle, ADMIN.password, use)

const shot = async (page: Page, name: string, width: number) => {
  if (process.env.FI5_SCREENSHOTS) {
    // Menus, dialogs and toasts fade in: wait for the end of it.
    await page.waitForTimeout(500)
    await page.screenshot({ path: `${process.env.FI5_SCREENSHOTS}/${name}-${width}.png`, animations: "disabled" })
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
}

/** A chat of three forks that share "A shared message"; the first forks's copy of it is deleted. */
const seeded = (title: string) =>
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
      yield* send(shared, "Only the first fork has this")
      const old = yield* send(shared, "Down the old road", true)
      yield* api.NameFork({ forkId: old.startsForkId!, name: "Old road" })
      const side = yield* send(shared, "Down the side road", true)
      yield* api.NameFork({ forkId: side.startsForkId!, name: "Side road" })
      const first = (yield* api.ListForks({ chatId: chat.id })).find((fork) => fork.name === null)!
      yield* api.DeleteMessage({ slotId: shared, forkId: first.id })
      return { chatId: chat.id, shared, old: old.startsForkId!, side: side.startsForkId! }
    })
  )

for (const width of [1440, 390]) {
  test(`deleting a fork, then a message's text for good, at ${width}`, async ({ page }) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const title = `Harbor road ${width}`
    const { chatId, old, side } = await seeded(title)

    // The first fork lost the shared message; the others still show it.
    await page.goto(`${server().url}/chats/${chatId}?fork=${side}`)
    await expect(page.getByTestId("messages").getByText("A shared message")).toBeVisible()
    await page.goto(`${server().url}/chats/${chatId}?fork=${old}`)
    await expect(page.getByTestId("messages").getByText("Down the old road")).toBeVisible()
    await page.getByRole("button", { name: /switch branch/ }).click()
    const list = page.getByRole("list", { name: "Branches" })
    await expect(list.getByRole("button", { name: "Delete Old road", exact: true })).toBeVisible()
    await shot(page, "fork-menu", width)
    await list.getByRole("button", { name: "Delete Old road", exact: true }).click()
    await expect(page.getByText(`Branch “Old road” in “${title}” moved to the bin.`)).toBeVisible()
    await shot(page, "fork-deleted-toast", width)

    // The fork went, and the other forks and their messages are as they were.
    await page.goto(`${server().url}/chats/${chatId}?fork=${side}`)
    await expect(page.getByTestId("messages").getByText("A shared message")).toBeVisible()
    await expect(page.getByTestId("messages").getByText("Down the side road")).toBeVisible()

    // Another tab already showing the affected fork must hear about the global purge.
    const watching = await page.context().newPage()
    await watching.goto(`${server().url}/chats/${chatId}?fork=${side}`)
    await expect(watching.getByTestId("messages").getByText("A shared message")).toBeVisible()
    // The bin names the fork and the message, and warns before deleting the message for good.
    await page.goto(`${server().url}/bin`)
    await expect(page.getByRole("listitem", { name: `Branch “Old road” in “${title}”` })).toBeVisible()
    await shot(page, "bin", width)
    const message = page.getByRole("listitem", { name: new RegExp(`^Message \\d+ in “${title}”$`) })
    await message.getByRole("button", { name: "Delete for good" }).click()
    const dialog = page.getByRole("alertdialog")
    await expect(dialog.getByText(/still shows? the text/)).toBeVisible()
    await expect(dialog.getByText("Side road", { exact: true })).toBeVisible()
    await expect(dialog.getByText("Old road", { exact: true })).toBeVisible()
    await shot(page, "delete-for-good-warning", width)
    await dialog.getByRole("button", { name: "Delete for good" }).click()
    await expect(page.getByRole("listitem", { name: new RegExp(`^Message \\d+ in “${title}”$`) })).toHaveCount(0)

    await expect(watching.getByTestId("messages").getByText("A shared message")).toHaveCount(0)
    await expect(watching.getByTestId("messages").getByText("Down the side road")).toBeVisible()
    await watching.close()
    // Erased everywhere: the side fork lost the message too.
    await page.goto(`${server().url}/chats/${chatId}?fork=${side}`)
    await expect(page.getByTestId("messages").getByText("Down the side road")).toBeVisible()
    await expect(page.getByTestId("messages").getByText("A shared message")).toHaveCount(0)
    await shot(page, "side-fork-after", width)
  })
}

test("destructive actions wait for the affected-forks warning", async ({ page }) => {
  const { chatId } = await seeded("Delayed fork warning")
  let release: (() => void) | null = null
  await page.routeWebSocket("**/rpc", (socket) => {
    const upstream = socket.connectToServer()
    socket.onMessage((message) => {
      if (String(message).includes('"tag":"BinItemBranches"')) release = () => upstream.send(message)
      else upstream.send(message)
    })
    upstream.onMessage((message) => socket.send(message))
  })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/bin`)
  const row = page.getByRole("listitem", { name: /^Message \d+ in “Delayed fork warning”$/ })
  await row.getByRole("button", { name: "Delete for good" }).click()
  const dialog = page.getByRole("alertdialog")
  await expect.poll(() => release !== null).toBe(true)
  await expect(dialog.getByRole("button", { name: "Delete for good" })).toBeDisabled()
  release!()
  await expect(dialog.getByText("Side road", { exact: true })).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Delete for good" })).toBeEnabled()
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
  release = null
  await page.getByRole("button", { name: "Empty the bin", exact: true }).click()
  await expect.poll(() => release !== null).toBe(true)
  await expect(dialog.getByRole("button", { name: "Empty the bin", exact: true })).toBeDisabled()
  release!()
  await expect(dialog.getByText("Side road", { exact: true })).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Empty the bin", exact: true })).toBeEnabled()
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
  await page.goto(`${server().url}/chats/${chatId}`)
})

test("the warning names every affected fork, including the ninth", async ({ page }) => {
  const { chatId, side, shared } = await seeded("Many forks")
  await admin((api) =>
    Effect.gen(function* () {
      for (let i = 0; i < 9; i++) {
        const made = yield* api.CreateFork({ chatId, fromForkId: side, atSlotId: shared })
        yield* api.NameFork({ forkId: made.fork.id, name: `Affected ${i + 1}` })
      }
    })
  )
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/bin`)
  await page
    .getByRole("listitem", { name: /^Message \d+ in “Many forks”$/ })
    .getByRole("button", { name: "Delete for good" })
    .click()
  const dialog = page.getByRole("alertdialog")
  for (let i = 0; i < 9; i++) await expect(dialog.getByText(`Affected ${i + 1}`, { exact: true })).toBeAttached()
  await expect(dialog.getByText("Old road", { exact: true })).toBeAttached()
  await expect(dialog.getByText("Side road", { exact: true })).toBeAttached()
})

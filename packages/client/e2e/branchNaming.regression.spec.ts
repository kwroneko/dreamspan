import { expect, test, type Page } from "@playwright/test"
import { Effect } from "effect"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile({ ...withAdmin, DB_WORKERS: "bundle" })
type Api = Parameters<Parameters<typeof asUser>[3]>[0]
const admin = <A>(use: (api: Api) => Effect.Effect<A, unknown>) => asUser(server(), ADMIN.handle, ADMIN.password, use)

const shot = async (page: Page, name: string, width: number) => {
  if (process.env.R4D_SCREENSHOTS) {
    await expect(page.getByRole("dialog")).toHaveCount(0)
    const scheme = await page.evaluate(() => (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"))
    await page.screenshot({ path: `${process.env.R4D_SCREENSHOTS}/${name}-${width}-${scheme}.png` })
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
}

const forked = (long = false) =>
  admin((api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title: "Review named branches" })
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
      const first = yield* send(root, "Other branch")
      const second = yield* send(root, "The named road", true)
      yield* api.NameFork({ forkId: second.startsForkId!, name: "Old road" })
      let tip = second.slotId
      if (long) {
        for (let i = 0; i < 90; i++) tip = (yield* send(tip, "Continuation " + i)).slotId
      }
      // The forks the two lines are: the chat's first, and the one made for the named road.
      return { chatId: chat.id, first: first.forkId!, second: second.startsForkId! }
    })
  )

for (const scheme of ["light", "dark"] as const)
  for (const width of [1440, 390]) {
    test(
      "an off-window branch name updates in the other open tab at " + width + ` (${scheme})`,
      async ({ page, context }) => {
        test.setTimeout(120_000)
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
        await page.emulateMedia({ colorScheme: scheme })
        await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
        const { chatId } = await forked(true)
        await page.goto(server().url + "/chats/" + chatId)
        const branch = page.getByRole("button", { name: /switch branch/ })
        await expect(branch).toHaveAccessibleName(/Old road/)
        const other = await context.newPage()
        await other.setViewportSize({ width, height: width === 390 ? 844 : 900 })
        await other.emulateMedia({ colorScheme: scheme })
        await other.goto(page.url())
        const rename = async (from: string, to: string) => {
          await other.getByRole("button", { name: /switch branch/ }).click()
          const list = other.getByRole("list", { name: "Branches" })
          await list.getByRole("button", { name: `Rename ${from}`, exact: true }).click()
          await list.getByRole("textbox", { name: `Name of branch ${from}` }).fill(to)
          await list.getByRole("button", { name: "Save the name", exact: true }).click()
          await other.keyboard.press("Escape")
        }
        await rename("Old road", "New road")
        await expect(other.getByRole("button", { name: /switch branch/ })).toHaveAccessibleName(/New road/)
        await expect(branch).toHaveAccessibleName(/New road/)
        await shot(page, "live-off-window-name", width)
        // Clearing a name also propagates, without opening the observer's list.
        await rename("New road", "")
        await expect(branch).toHaveAccessibleName(/Branch: Split .+ at #\d+, 1 of 2/)
        await shot(page, "live-cleared-name", width)
      }
    )

    test(
      "the last surviving named branch remains identifiable and editable at " + width + ` (${scheme})`,
      async ({ page }) => {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
        await page.emulateMedia({ colorScheme: scheme })
        await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
        const { chatId } = await forked()
        await page.goto(server().url + "/chats/" + chatId)
        const branch = page.getByRole("button", { name: /switch branch/ })
        const list = page.getByRole("list", { name: "Branches" })
        await branch.click()
        await list.getByRole("button", { name: "Delete Original", exact: true }).click()
        await expect(page.getByTestId("messages").getByText("The named road", { exact: true })).toBeVisible()
        // One branch left: the header keeps its disabled control; ⋯ Branches… still lists it.
        await expect(branch).toBeDisabled()
        const branches = async () => {
          await page.getByRole("button", { name: "Chat actions", exact: true }).click()
          await page.getByRole("menuitem", { name: "Branches…" }).click()
        }
        await branches()
        await expect(list.getByRole("link", { name: /^Old road/ })).toBeVisible()
        await expect(list.getByRole("button", { name: "Rename Old road", exact: true })).toBeVisible()
        await expect(list.getByRole("button", { name: "Delete Old road", exact: true })).toBeDisabled()
        await expect(page.getByText("The only branch: delete the chat instead")).toBeVisible()
        await page.keyboard.press("Escape")
        await page.reload()
        await expect(page.getByTestId("messages").getByText("The named road", { exact: true })).toBeVisible()
        await branches()
        await list.getByRole("button", { name: "Rename Old road", exact: true }).click()
        await list.getByRole("textbox", { name: "Name of branch Old road" }).fill("Only road")
        await list.getByRole("button", { name: "Save the name", exact: true }).click()
        await expect(list.getByRole("link", { name: /^Only road/ })).toBeVisible()
        await expect(list.getByRole("button", { name: "Delete Only road", exact: true })).toBeDisabled()
        await page.keyboard.press("Escape")
        await shot(page, "single-named-reloaded-renamed", width)
        await expect(page.getByTestId("messages").getByText("The named road", { exact: true })).toBeVisible()
      }
    )
  }

for (const scheme of ["light", "dark"] as const)
  for (const width of [1440, 390]) {
    test(
      "Delete branch and Undo preserve the unsent draft when returning to that branch at " + width + ` (${scheme})`,
      async ({ page }) => {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
        await page.emulateMedia({ colorScheme: scheme })
        await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
        const { chatId, first, second } = await forked()
        await page.goto(server().url + "/chats/" + chatId)
        const message = page.getByLabel("Message", { exact: true })
        await message.fill("Important unsent paragraph")
        await expect
          .poll(() =>
            admin((api) => Effect.map(api.OpenComposer({ chatId, forkId: second }), (draft) => draft.content))
          )
          .toBe("Important unsent paragraph")
        const branch = page.getByRole("button", { name: /switch branch/ })
        const list = page.getByRole("list", { name: "Branches" })
        await branch.click()
        await list.getByRole("button", { name: "Delete Old road", exact: true }).click()
        await expect(page.getByTestId("messages").getByText("Other branch", { exact: true })).toBeVisible()
        // Undo immediately, with a survivor save still pending; changing paths must flush it.
        await message.fill("Draft typed on the surviving branch")
        await page.getByRole("button", { name: "Undo", exact: true }).click()
        await branch.click()
        await list.getByRole("link", { name: /^Old road/ }).click()
        await expect(page.getByTestId("messages").getByText("The named road", { exact: true })).toBeVisible()
        await expect(message).toHaveValue("Important unsent paragraph")
        await shot(page, "restored-branch-original-draft", width)
        await branch.click()
        await list.getByRole("link", { name: /^Original/ }).click()
        await expect(message).toHaveValue("Draft typed on the surviving branch")
        await expect
          .poll(() => admin((api) => Effect.map(api.OpenComposer({ chatId, forkId: first }), (draft) => draft.content)))
          .toBe("Draft typed on the surviving branch")
        await shot(page, "survivor-draft-after-undo", width)
      }
    )
  }

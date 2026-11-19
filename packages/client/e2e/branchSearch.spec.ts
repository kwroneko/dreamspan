// Finding a branch among many (stgapfix1, 2026-11-16): the header's branch menu, the left
// panel's foot list of the open chat's branches and the panel's list of one chat's branches
// each filter by the words in a branch's name or last message. Synthetic chat; layout audit
// on each surface with the filter in use, at 1440 and 390.
import type { ForkId, SlotId } from "@dreamspan/shared/chat.ts"
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
test.use({ locale: "en-GB", timezoneId: "UTC" })

const PLACES = [
  "quay",
  "market",
  "chapel",
  "orchard",
  "bridge",
  "mill",
  "forge",
  "harbour",
  "tower",
  "meadow",
  "cellar"
]

let chat = ""
test.beforeAll(async () => {
  chat = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const made = yield* api.CreateChat({ title: "Wren's errands" })
      const root = made.currentForkId!
      const send = (forkId: ForkId, parent: SlotId | null, content: string) =>
        Effect.map(
          api.SendMessage({ chatId: made.id, forkId, parentSlotId: parent, branch: false, content }),
          (sent) => (sent as { entry?: { slotId: SlotId } }).entry!.slotId
        )
      const first = yield* send(root, null, "Wren sets out at dawn.")
      for (const [i, place] of PLACES.entries()) {
        const { fork } = yield* api.CreateFork({ chatId: made.id, fromForkId: root, atSlotId: first })
        yield* send(fork.id, first, `Wren waits at the ${place} until the bells ring.`)
        if (i === 3) yield* api.NameFork({ forkId: fork.id, name: "Apple thieves" })
      }
      return made.id
    })
  )
})

const openChat = async (page: Page, width: number, theme: "light" | "dark") => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
  await page.emulateMedia({ colorScheme: theme })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chat}`)
  await expect(
    page
      .getByRole("main")
      .getByText(/Wren waits at the /)
      .first()
  ).toBeVisible()
}

for (const width of [1440, 390] as const)
  for (const theme of ["light", "dark"] as const) {
    test(`the branch menu filters its branches at ${width} ${theme}`, async ({ page }, info) => {
      await openChat(page, width, theme)
      await page.getByRole("button", { name: /^Branch:.*switch branch$/ }).click()
      const menu = page.getByRole("dialog", { name: "Branches of this chat" })
      const items = menu.getByRole("list", { name: "Branches" }).getByRole("listitem")
      await expect(items).toHaveCount(PLACES.length + 1)
      const field = menu.getByRole("searchbox", { name: "Find a branch" })
      await field.hover()
      await expect(page.getByText("Shows the branches whose name or last message has these words.")).toBeVisible()
      await field.fill("ORCHARD")
      await expect(items).toHaveCount(1)
      await expect(items.first()).toContainText("Apple thieves")
      await field.fill("apple")
      await expect(items).toHaveCount(1)
      await field.fill("waits bells")
      await expect(items).toHaveCount(PLACES.length)
      await field.fill("market")
      await expect(items).toHaveCount(1)
      await expectLayout(page, info, `branch-menu-filtered-${width}-${theme}`, { scope: '[role="dialog"]' })
      await field.fill("nowhere")
      await expect(items).toHaveCount(0)
      await expect(menu.getByText("No branch has those words.")).toBeVisible()
      await expectLayout(page, info, `branch-menu-none-${width}-${theme}`, { scope: '[role="dialog"]' })
      // A branch found opens.
      await field.fill("tower")
      await items.first().getByRole("link").click()
      await expect(page.getByRole("main").getByText("Wren waits at the tower until the bells ring.")).toBeVisible()
    })

    test(`the left panel's branch lists filter by name and last message at ${width} ${theme}`, async ({
      page
    }, info) => {
      await openChat(page, width, theme)
      const phone = width === 390
      if (phone) await page.getByRole("button", { name: "Chats and menu" }).click()
      const panel = phone ? page : page.getByRole("complementary").first()
      const foot = panel.getByRole("region", { name: "Branches of the open chat" })
      await expect(foot).toBeVisible()
      const toggle = foot.getByRole("button", { name: /^Branches of / })
      if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click()
      const footRows = foot.getByRole("button", { name: /^Open branch / })
      await expect(footRows).toHaveCount(PLACES.length + 1)
      const footField = foot.getByRole("searchbox", { name: "Find a branch" })
      await footField.fill("chapel")
      await expect(footRows).toHaveCount(1)
      await expectLayout(page, info, `branch-foot-filtered-${width}-${theme}`, {
        scope: '[aria-label="Branches of the open chat"]'
      })
      await footField.fill("nowhere")
      await expect(footRows).toHaveCount(0)
      await expect(foot.getByText("No branch has those words.")).toBeVisible()

      // The panel's own list of the chat's branches: its search field finds branches, not chats.
      await panel.getByRole("button", { name: "List these branches in the panel", exact: true }).click()
      const crumbs = panel.getByRole("navigation", { name: "Chat breadcrumbs" })
      await expect(crumbs).toContainText("Wren's errands")
      const rows = panel.getByRole("button", { name: /^Open branch / })
      await expect(rows).toHaveCount(PLACES.length + 1)
      const field = panel.getByRole("textbox", { name: "Find a branch" })
      await field.fill("forge bells")
      await expect(rows).toHaveCount(1)
      await expect(rows.first()).toContainText("forge")
      await field.fill("nowhere at all")
      await expect(rows).toHaveCount(0)
      await expect(panel.getByText("No branch has those words.")).toBeVisible()
      await expect(crumbs).toContainText("Wren's errands")
      await field.fill("")
      await expect(rows).toHaveCount(PLACES.length + 1)
      await field.fill("orchard")
      await expect(rows).toHaveCount(1)
      await expectLayout(page, info, `branch-panel-filtered-${width}-${theme}`, phone ? {} : { scope: "aside" })
      // Back to all chats: the chat search has its own words.
      await crumbs.getByRole("button", { name: "All chats" }).click()
      await expect(panel.getByRole("textbox", { name: "Find a chat" })).toHaveValue("")
    })
  }

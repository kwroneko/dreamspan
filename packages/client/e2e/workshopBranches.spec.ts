// A workshop beside a story as a thread of its story branch (spec/WORKSHOP-BRANCHES.md) in the
// browser: "Branch from here" offers each workshop as it was then or as it is now, with the
// messages "then" leaves out; the side panel lists only the workshop branches that go with the
// story branch shown; the workshop's own page names each branch's story branch and links back to
// it. At 1440 and 390; with LAYOUT_AUDIT=1 each surface is audited. Synthetic data, no provider.
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import type { ChatId, ForkId, SlotId } from "@dreamspan/shared/chat.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { messageMenu } from "./support/message.ts"
import { closePanel, openPanel } from "./support/panel.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { sidePanel } from "./support/workshopSideChat.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)

const audit = async (page: Page, name: string) => {
  if (process.env.LAYOUT_AUDIT) await expectLayout(page, test.info(), name)
}

/** A story of two messages and a workshop that talked about each as it was written. */
const fixture = (title: string) =>
  admin((api) =>
    Effect.gen(function* () {
      const story = yield* api.CreateChat({ title })
      const say = (chatId: ChatId, parentSlotId: SlotId | null, content: string, forkId?: ForkId) =>
        Effect.gen(function* () {
          const sent = yield* api.SendMessage({
            chatId,
            ...(forkId ? { forkId } : {}),
            parentSlotId,
            branch: false,
            content,
            reply: false
          })
          if (sent._tag !== "Posted") return yield* Effect.die("unexpected queue")
          return sent.entry.slotId
        })
      const first = yield* say(story.id, null, "The caravan leaves at dawn.")
      const workshop = yield* api.CreateWorkshop({ attachTo: story.id, title: `About ${title}` })
      const w1 = yield* say(workshop.id, workshop.activeLeafSlotId, "Is the dawn start believable?")
      yield* say(story.id, first, "Bandits wait at the pass.")
      yield* say(workshop.id, w1, "The bandits feel sudden.")
      return { story, workshop, first }
    })
  )

test("a popped-out workshop cannot send the side panel to a stale story branch", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1000 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const { story, workshop } = await fixture("Workshop branch cache")
  await page.goto(`${server().url}/chats/${story.id}?panel=workshop`)
  await expect(sidePanel(page).getByText("The bandits feel sudden.")).toBeVisible()
  await sidePanel(page).getByRole("link", { name: "Open beside the story" }).click()
  const frames = page.locator("[data-frame]")
  await expect(frames).toHaveCount(2)
  const headerLink = frames.nth(1).locator(`[data-workshop-story="${story.id}"]`)
  await expect(headerLink).toContainText("branch Original")
  const opening = frames.first().getByRole("article").filter({ hasText: "The caravan leaves at dawn." })
  await opening.click()
  await closePanel(page)

  await messageMenu(opening, "Branch from here")
  const dialog = page.getByRole("dialog", { name: "Branch from here" })
  await expect(dialog.locator(`[data-fork-workshop="${workshop.id}"]`)).toBeVisible()
  await dialog.getByRole("button", { name: "Create branch" }).click()
  await expect(dialog).toHaveCount(0)
  await expect(headerLink).toContainText("branch Original")
  const panel = await openPanel(page, "Workshop")
  const side = panel.locator(`[data-side-chat="${workshop.id}"]`)
  await expect(side.getByLabel("Message", { exact: true })).toBeVisible()
  await expect(side.getByText("Is the dawn start believable?")).toBeVisible()
  await expect(side.getByText("The bandits feel sudden.")).toHaveCount(0)
})

for (const width of [1440, 390])
  test(`branching the story offers its workshop then or now, and the panel follows the branch at ${width}`, async ({
    page
  }) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const { story, workshop } = await fixture(`Caravan ${width}`)

    await page.goto(`${server().url}/chats/${story.id}`)
    const opening = page.getByRole("article").filter({ hasText: "The caravan leaves at dawn." })
    await expect(opening).toBeVisible()
    await messageMenu(opening, "Branch from here")
    const dialog = page.getByRole("dialog", { name: "Branch from here" })
    const row = dialog.locator(`[data-fork-workshop="${workshop.id}"]`)
    await expect(row).toContainText(`About Caravan ${width}`)
    await expect(row).toContainText("1 message after this point")
    // With a workshop the set-all switch is "Set all".
    await expect(dialog.getByText("Set all", { exact: true })).toBeVisible()
    await row.getByText("Messages left out").click()
    await expect(row.locator("[data-left-out]")).toContainText("The bandits feel sudden.")
    await audit(page, `workshop-branch-dialog-${width}`)
    await expect(row.getByRole("button", { name: "As it was then" })).toHaveAttribute("aria-pressed", "true")
    await dialog.getByRole("button", { name: "Create branch" }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page).toHaveURL(/[?&]slot=/)

    // The new story branch's workshop branch: what was said by message 1 only.
    const made = await admin((api) =>
      Effect.gen(function* () {
        const branches = yield* api.ListWorkshopBranches({ chatId: workshop.id })
        const chat = yield* api.GetChat({ chatId: story.id })
        const onNew = branches.find((b) => b.story?.forkId === chat.currentForkId)!
        // A second workshop branch for that story branch, branched from the workshop's own.
        const path = yield* api.ReadPath({
          chatId: workshop.id,
          forkId: onNew.forkId,
          leafSlotId: null,
          range: { _tag: "Bottom" },
          limit: 10
        })
        const second = yield* api.CreateFork({
          chatId: workshop.id,
          fromForkId: onNew.forkId,
          atSlotId: path.entries.at(-1)!.slotId
        })
        yield* api.NameFork({ forkId: second.fork.id, name: "Second look" })
        return { storyFork: chat.currentForkId!, onNew: onNew.forkId, second: second.fork.id }
      })
    )
    await page.goto(`${server().url}/chats/${story.id}?fork=${made.storyFork}&panel=workshop`)
    const panel = sidePanel(page)
    const side = panel.locator(`[data-side-chat="${workshop.id}"]`)
    await expect(side).toBeVisible()
    await expect(side.getByText("Is the dawn start believable?")).toBeVisible()
    await expect(side.getByText("The bandits feel sudden.")).toHaveCount(0)
    // Two workshop branches go with this story branch: the menu lists those two only.
    const menu = side.locator("[data-side-chat-branches]")
    await expect(menu).toBeVisible()
    await menu.getByRole("button", { name: /^Workshop branch: / }).click()
    await expect(page.getByRole("menuitem")).toHaveCount(2)
    await audit(page, `workshop-branch-menu-${width}`)
    await page.getByRole("menuitem", { name: "Second look" }).click()
    await expect(page).toHaveURL(new RegExp(`side\\.fork=${made.second}`))

    // The original story branch shows the workshop's own branch, with all it said.
    await page.goto(`${server().url}/chats/${story.id}?fork=${story.currentForkId}&panel=workshop`)
    await expect(sidePanel(page).getByText("The bandits feel sudden.")).toBeVisible()
    await expect(sidePanel(page).locator("[data-side-chat-branches]")).toHaveCount(0)

    // In its own page: the link back names the story branch, and each branch row names its own.
    await page.goto(`${server().url}/chats/${workshop.id}?fork=${made.onNew}`)
    const back = page.locator(`[data-workshop-story="${story.id}"]`)
    await expect(back).toContainText(`About “Caravan ${width}” · branch`)
    await expect(back).toHaveAttribute("href", `/chats/${story.id}?fork=${made.storyFork}`)
    await page
      .getByRole("button", { name: /^Branch: .*switch branch$/ })
      .first()
      .click()
    await expect(page.locator("[data-workshop-story-branch]").first()).toBeVisible()
    await expect(page.locator("[data-workshop-story-branch]").filter({ hasText: "“Original”" })).toHaveCount(1)
    await audit(page, `workshop-branch-list-${width}`)
  })

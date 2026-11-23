// The left panel's message search (owner, 2026-11-23): the chat list's filter narrows the chats it
// looks through, it has a sort (Best match, Newest, Oldest, Chat with A to Z or Z to A), it stays
// in a character's chats with the breadcrumbs, a muted line counts what it found, and the URL
// keeps all of it through a reload. At 1440 and 390, with the layout audit.
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
let mira = ""
let wren = ""
test.beforeAll(async () => {
  await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      mira = (yield* api.CreateCard({ label: "Mira", name: "Mira" })).entityId
      wren = (yield* api.CreateCard({ label: "Wren", name: "Wren" })).entityId
      // Started in this order: Newest lists them the other way round.
      for (const [name, cards] of [
        ["Zulu solo", [mira]],
        ["Alpha pair", [mira, wren]],
        ["Middle wren", [wren]]
      ] as const) {
        const started = yield* api.StartChat({
          cards: cards as never,
          persona: null,
          greeting: null,
          first: { _tag: "Send", content: `The lantern in ${name}.`, speakerEntityId: null }
        })
        yield* api.RenameChat({ chatId: started.chat.id, name })
        if (name === "Zulu solo") yield* api.SetChatPin({ chatId: started.chat.id, leaf: null, pinned: true })
      }
    })
  )
})

for (const width of [1440, 390])
  test(`message search sorts, filters, scope, count and reload at ${width}`, async ({ page }, info) => {
    test.setTimeout(180_000)
    await page.setViewportSize({ width, height: 900 })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const scope = width === 390 ? ".fixed.inset-0" : '[aria-label="Sidebar"]'
    const panel = page.locator(scope)
    const visit = async (query: string) => {
      await page.goto(`${server().url}/${query}`)
      if (width === 390) await page.getByRole("button", { name: "Chats and menu", exact: true }).click()
    }
    const results = panel.getByRole("list", { name: "Messages found", exact: true })
    const names = () => results.locator("[data-hit-chat]").allTextContents()
    const count = panel.locator("[data-message-count]")
    const filter = async (label: RegExp) => {
      await panel.getByRole("combobox", { name: "Show chats" }).click()
      await page.getByRole("option", { name: label }).click()
    }
    const sort = async (label: string) => {
      await panel.getByRole("button", { name: /^Sort messages:/ }).click()
      await page.getByRole("menuitemcheckbox", { name: label, exact: true }).click()
    }
    const audit = (name: string) =>
      process.env.LAYOUT_AUDIT ? expectLayout(page, info, `msgsearch-${width}-${name}`, { scope }) : null

    await visit("?sideIn=messages&sideQ=lantern")
    const toggle = panel.getByRole("button", { name: "Search message text", exact: true })
    await expect(toggle).toHaveAttribute("aria-pressed", "true")
    await expect.poll(names).toHaveLength(3)
    await expect(count).toHaveText("3 messages in 3 chats")
    // The count is muted and small, on its own line right above the results.
    expect(await count.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeLessThanOrEqual(12)
    const countBox = (await count.boundingBox())!
    const listBox = (await results.boundingBox())!
    expect(listBox.y).toBeGreaterThanOrEqual(countBox.y + countBox.height)
    await expect(panel.getByRole("button", { name: "Sort messages: Best match", exact: true })).toBeVisible()
    await audit("best")

    // Each sort.
    await sort("Newest")
    await expect.poll(names).toEqual(["Middle wren", "Alpha pair", "Zulu solo"])
    await sort("Oldest")
    await expect.poll(names).toEqual(["Zulu solo", "Alpha pair", "Middle wren"])
    await panel.getByRole("button", { name: "Order: Oldest first", exact: true }).click()
    await expect(panel.getByRole("button", { name: "Sort messages: Newest", exact: true })).toBeVisible()
    await expect.poll(names).toEqual(["Middle wren", "Alpha pair", "Zulu solo"])
    await sort("Chat")
    await expect.poll(names).toEqual(["Alpha pair", "Middle wren", "Zulu solo"])
    await panel.getByRole("button", { name: "Order: A to Z", exact: true }).click()
    await expect.poll(names).toEqual(["Zulu solo", "Middle wren", "Alpha pair"])
    await expect(page).toHaveURL(/sideMsgSort=chat/)
    await expect(page).toHaveURL(/sideMsgReverse=true/)
    await audit("chat")
    await sort("Best match")
    await expect(panel.getByRole("button", { name: "Order: Newest first", exact: true })).toBeDisabled()
    await expect.poll(names).toHaveLength(3)

    // Each filter narrows the chats searched; the count follows.
    for (const [label, expected, counted] of [
      [/^Pinned ·/, ["Zulu solo"], "1 message in 1 chat"],
      [/^Group chats ·/, ["Alpha pair"], "1 message in 1 chat"],
      [/^One-on-one ·/, ["Middle wren", "Zulu solo"], "2 messages in 2 chats"],
      [/^With branches ·/, [], "0 messages in 0 chats"],
      [/^Workshops ·/, [], "0 messages in 0 chats"],
      [/^All ·/, ["Alpha pair", "Middle wren", "Zulu solo"], "3 messages in 3 chats"]
    ] as const) {
      await filter(label)
      await expect(count).toHaveText(counted)
      if (expected.length === 0) await expect(results).toContainText("No message in these chats has")
      else await expect.poll(async () => (await names()).sort()).toEqual([...expected])
    }

    // The count's line is kept while the search is on: a search that finds nothing starts where the list did.
    const before = (await results.boundingBox())!.y
    await panel.getByRole("textbox", { name: "Find in messages", exact: true }).fill("lanterns")
    await expect(results).toContainText("No message in your chats has")
    expect((await results.boundingBox())!.y).toBe(before)
    await panel.getByRole("textbox", { name: "Find in messages", exact: true }).fill("lantern")
    await expect.poll(names).toHaveLength(3)

    // A character's chats: the search button stays, the crumbs say where, only its chats are searched.
    await visit(`?character=${mira}&sideIn=messages&sideQ=lantern`)
    const crumbs = panel.getByRole("navigation", { name: "Chat breadcrumbs", exact: true })
    await expect(crumbs).toContainText("Mira")
    await expect(toggle).toHaveAttribute("aria-pressed", "true")
    await expect.poll(async () => (await names()).sort()).toEqual(["Alpha pair", "Zulu solo"])
    await expect(count).toHaveText("2 messages in 2 chats")
    // Filters, then the crumbs, then the count and the results.
    const bar = (await panel.getByLabel("Chat filters and sorting", { exact: true }).boundingBox())!
    const crumbBox = (await crumbs.boundingBox())!
    expect(crumbBox.y).toBeGreaterThanOrEqual(bar.y + bar.height)
    expect((await count.boundingBox())!.y).toBeGreaterThanOrEqual(crumbBox.y + crumbBox.height)
    await audit("character")

    // Everything in the URL survives a reload.
    await sort("Chat")
    await panel.getByRole("button", { name: "Order: A to Z", exact: true }).click()
    await filter(/^Group chats ·/)
    await expect.poll(names).toEqual(["Alpha pair"])
    await page.reload()
    if (width === 390) await page.getByRole("button", { name: "Chats and menu", exact: true }).click()
    await expect(panel.getByRole("textbox", { name: "Find in messages", exact: true })).toHaveValue("lantern")
    await expect(toggle).toHaveAttribute("aria-pressed", "true")
    await expect(crumbs).toContainText("Mira")
    await expect(panel.getByRole("button", { name: "Sort messages: Chat", exact: true })).toBeVisible()
    await expect(panel.getByRole("button", { name: "Order: Z to A", exact: true })).toBeVisible()
    await expect(panel.getByRole("combobox", { name: "Show chats" })).toContainText("Group chats")
    await expect.poll(names).toEqual(["Alpha pair"])
    await expect(count).toHaveText("1 message in 1 chat")

    // Wren's chats, one-on-one: one chat.
    await visit(`?character=${wren}&sideIn=messages&sideQ=lantern&sideChatsShow=solo`)
    await expect.poll(names).toEqual(["Middle wren"])
  })

import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
let userId = ""
let chatId = ""
test.beforeAll(async () => {
  await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      userId = (yield* api.Whoami()).id
      const mira = yield* api.CreateCard({ label: "Mira", name: "Mira" })
      const wren = yield* api.CreateCard({ label: "Wren", name: "Wren" })
      for (const [name, cards] of [
        ["Zulu solo", [mira.entityId]],
        ["Alpha pair", [mira.entityId, wren.entityId]]
      ] as const) {
        const started = yield* api.StartChat({
          cards,
          persona: null,
          greeting: null,
          first: { _tag: "Send", content: "A synthetic start.", speakerEntityId: null }
        })
        yield* api.RenameChat({ chatId: started.chat.id, name })
        if (name === "Zulu solo") {
          chatId = started.chat.id
          yield* api.SetChatPin({ chatId: started.chat.id, leaf: null, pinned: true })
          yield* api.CreateFork({
            chatId: started.chat.id,
            fromForkId: null,
            atSlotId: started.chat.activeLeafSlotId,
            name: "Another path"
          })
        }
      }
    })
  )
})

for (const width of [1440, 390])
  test(`Chats browse row and persistence at ${width}`, async ({ page }) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width, height: 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const open = async () => {
      if (width === 390) await page.getByRole("button", { name: "Chats and menu", exact: true }).click()
    }
    const panel =
      width === 390 ? page.locator(".fixed.inset-0") : page.getByRole("complementary", { name: "Sidebar", exact: true })
    const chats = panel.getByRole("region", { name: "Chats", exact: true })
    const names = () => chats.locator("[data-chat-id]").allTextContents()
    const filter = async (label: string) => {
      await panel.getByRole("combobox", { name: "Show chats" }).click()
      await page.getByRole("option", { name: label, exact: true }).click()
    }
    const sort = async (label: string) => {
      await panel.getByRole("button", { name: /^Sort chats:/ }).click()
      await page.getByRole("menuitemcheckbox", { name: label, exact: true }).click()
    }
    await page.goto(`${server().url}/`)
    await open()
    await expect(panel.getByRole("combobox", { name: "Show chats" })).toHaveText("All · 2")
    const initialHistory = await page.evaluate(() => history.length)
    await panel.getByRole("combobox", { name: "Show chats" }).click()
    await expect(page.getByRole("option")).toHaveText([
      /^All · 2/,
      /^Pinned · 1/,
      /^Group chats · 1/,
      /^One-on-one · 1/,
      /^With branches · 1/,
      /^Workshops · 0/
    ])
    await page.keyboard.press("Escape")
    for (const [label, name] of [
      ["Pinned · 1", "Zulu solo"],
      ["Group chats · 1", "Alpha pair"],
      ["One-on-one · 1", "Zulu solo"],
      ["With branches · 1", "Zulu solo"]
    ]) {
      await filter(label!)
      await expect.poll(names).toHaveLength(1)
      await expect(chats.locator("[data-chat-id]")).toContainText(name!)
    }
    await filter("All · 2")
    for (const label of ["Recent", "Started", "Name", "Messages", "Branches"]) {
      await sort(label)
      const order =
        label === "Name" ? "A to Z" : label === "Messages" || label === "Branches" ? "Most first" : "Newest first"
      await expect(panel.getByRole("button", { name: `Order: ${order}`, exact: true })).toBeVisible()
      const pin = panel.getByRole("region", { name: "Pinned chats", exact: true })
      await expect(pin).toBeVisible()
      expect((await pin.boundingBox())!.y).toBeLessThan((await chats.boundingBox())!.y)
    }
    await sort("Name")
    await expect.poll(names).toEqual([expect.stringContaining("Alpha pair"), expect.stringContaining("Zulu solo")])
    await panel.getByRole("button", { name: "Order: A to Z", exact: true }).click()
    await expect.poll(names).toEqual([expect.stringContaining("Zulu solo"), expect.stringContaining("Alpha pair")])
    await filter("One-on-one · 1")
    await expect(page).toHaveURL(/sideChatsShow=solo/)
    await expect(page).toHaveURL(/sideChatsSort=name/)
    await expect(page).toHaveURL(/sideChatsReverse=true/)
    expect(await page.evaluate(() => history.length)).toBe(initialHistory)
    const key = `dreamspan.chats.sidebar.${userId}`
    expect(await page.evaluate((k) => localStorage.getItem(k), key)).toBeNull()
    await page.reload()
    await open()
    await expect(panel.getByRole("combobox", { name: "Show chats" })).toHaveText("One-on-one · 1")
    await expect(panel.getByRole("button", { name: "Sort chats: Name", exact: true })).toBeVisible()
    await expect(panel.getByRole("button", { name: "Order: Z to A", exact: true })).toBeVisible()
    // A chat link keeps the current tab's URL choices.
    await chats.locator(`[data-chat-id="${chatId}"]`).click()
    await expect(page).toHaveURL(new RegExp(`/chats/${chatId}.*sideChatsSort=name`))
    // An unqualified visit uses defaults, even if an older build left device memory.
    await page.evaluate(
      (k) =>
        localStorage.setItem(
          k,
          JSON.stringify({ sideChatsShow: "solo", sideChatsSort: "name", sideChatsReverse: true })
        ),
      key
    )
    await page.goto(`${server().url}/`)
    await open()
    await expect(panel.getByRole("combobox", { name: "Show chats" })).toHaveText("All · 2")
    await expect(panel.getByRole("button", { name: "Sort chats: Recent", exact: true })).toBeVisible()
    await expect(panel.getByRole("button", { name: "Order: Newest first", exact: true })).toBeVisible()
    // Explicit link choices carry their own state; switching sorts resets direction.
    await page.goto(`${server().url}/?sideChatsShow=all&sideChatsSort=started`)
    await open()
    await expect(panel.getByRole("combobox", { name: "Show chats" })).toHaveText("All · 2")
    await expect(panel.getByRole("button", { name: "Order: Newest first", exact: true })).toBeVisible()
    await sort("Name")
    await expect(panel.getByRole("button", { name: "Order: A to Z", exact: true })).toBeVisible()
    // The row matches Characters: one line below search, contained at both viewport widths.
    const row = panel.getByLabel("Chat filters and sorting", { exact: true })
    const search = panel.getByRole("textbox", { name: "Find a chat" })
    const box = (await row.boundingBox())!,
      input = (await search.boundingBox())!
    expect(box.y).toBeGreaterThanOrEqual(input.y + input.height)
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(width)
    const controls = row.getByRole("button").or(row.getByRole("combobox"))
    for (const control of await controls.all()) {
      const rect = (await control.boundingBox())!
      expect(rect.y).toBeGreaterThanOrEqual(box.y)
      expect(rect.y + rect.height).toBeLessThanOrEqual(box.y + box.height + 1)
    }
    if (process.env.SCREENSHOT_DIR) {
      mkdirSync(process.env.SCREENSHOT_DIR, { recursive: true })
      await page.screenshot({ path: join(process.env.SCREENSHOT_DIR, `chatsort-${width}.png`), animations: "disabled" })
    }
  })

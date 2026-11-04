// Each browsing surface restores its place after reload and follows browser history.
// All cards, messages and books below are synthetic.
import { readFileSync } from "node:fs"
import { expect, test, type Page } from "@playwright/test"
import type { ChatId, EntityId, ForkId, SlotId } from "@rp/shared/chat.ts"
import type { SendResult } from "@rp/shared/chatApi.ts"
import type { RefId } from "@rp/shared/library.ts"
import { Effect } from "effect"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { openPanel, openPresetAt, closePanel } from "./support/panel.ts"
import { shapeCard } from "./support/shapes.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
let chat: ChatId, fork: ForkId, card: EntityId, cardRef: RefId, preset: RefId, book: RefId
const slots: SlotId[] = []
test.setTimeout(120_000)

test.beforeAll(async () => {
  const login = await fetch(`${server().url}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(ADMIN)
  })
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!
  const upload = async (name: string, data: string | Buffer) => {
    const response = await fetch(`${server().url}/library/import?name=${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { cookie, origin: server().url, "content-type": "application/octet-stream" },
      body: typeof data === "string" ? data : new Uint8Array(data)
    })
    expect(response.status).toBe(200)
  }
  await upload("Url Wren.png", shapeCard({ name: "Url Wren", width: 300, height: 450 }, 0))
  await upload(
    "Url Preset.json",
    readFileSync(new URL("../../server/test/fixtures/presets/default.json", import.meta.url), "utf8")
  )
  await upload(
    "Url Book.json",
    JSON.stringify({
      name: "Url Book",
      entries: {
        1: { uid: 1, key: ["harbor"], comment: "Harbor", content: "Synthetic boats in the harbor.", order: 1 }
      }
    })
  )
  await admin((api) =>
    Effect.gen(function* () {
      const ref = (yield* api.ListLibrary({ kind: "card" })).find((r) => r.label === "Url Wren")!
      card = ref.entityId
      cardRef = ref.id
      preset = (yield* api.ListLibrary({ kind: "preset" })).find((r) => r.label === "Url Preset")!.id
      book = (yield* api.ListLibrary({ kind: "lorebook" })).find((r) => r.label === "Url Book")!.id
      yield* api.ChangeGenerationDefaults({ change: { preset } })
      const made = yield* api.CreateChat({ title: "URL harbor" })
      chat = made.id
      yield* api.ChangeCast({ chatId: chat, slotId: null, change: { _tag: "Join", entityId: card } })
      yield* api.ChangeCast({ chatId: chat, slotId: null, change: { _tag: "Lorebook", ref: book, active: true } })
      let parent: SlotId | null = null
      for (let i = 0; i < 85; i++) {
        const sent: SendResult = yield* api.SendMessage({
          chatId: chat,
          parentSlotId: parent,
          branch: false,
          content: `Reading ${i + 1}. ${"The harbor lamps burn over synthetic water. ".repeat(8)}`,
          speakerEntityId: card
        })
        if (sent._tag !== "Posted") throw new Error("message queued")
        parent = sent.entry.slotId
        slots.push(sent.entry.slotId)
      }
      fork = (yield* api.GetChat({ chatId: chat })).currentForkId!
      yield* api.SetChatPin({ chatId: chat, forkId: fork, leaf: parent, pinned: true })
    })
  )
})

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
})
const open = async (page: Page, extra = "") => {
  await page.goto(`${server().url}/chats/${chat}?fork=${fork}${extra}`)
  await expect(page.getByLabel("Message", { exact: true })).toBeEditable()
}
const reload = async (page: Page) => {
  const url = page.url()
  await page.reload()
  expect(page.url()).toBe(url)
}

test("sidebar: scope, grid, search, filter, sorts and direction reload; filters replace", async ({ page }) => {
  await open(page)
  const left = page.getByRole("group", { name: "Left panel", exact: true })
  await left.getByRole("button", { name: "Characters", exact: true }).click()
  const find = page.getByRole("textbox", { name: "Find a character", exact: true })
  await find.fill("Url")
  const before = await page.evaluate(() => history.length)
  await page.getByRole("button", { name: /^Sort by:/ }).click()
  await page.getByRole("menuitemcheckbox", { name: /^Name/ }).click()
  await page.getByRole("button", { name: "Order: A to Z", exact: true }).click()
  await expect(page).toHaveURL(/sideSort=name/)
  expect(await page.evaluate(() => history.length)).toBe(before)
  await reload(page)
  await expect(find).toHaveValue("Url")
  await expect(page.getByRole("button", { name: "Order: Z to A", exact: true })).toBeVisible()
  await page.goBack()
  await expect(left.getByRole("button", { name: "Chats", exact: true })).toHaveAttribute("aria-pressed", "true")
  await page.goForward()
  await expect(find).toHaveValue("Url")
  // Scopes travel in links independently from the grid's filters.
  await page.goto(`${server().url}/chats/${chat}?fork=${fork}&character=${card}&forks=${chat}`)
  await reload(page)
  await expect(page.getByRole("navigation", { name: "Chat breadcrumbs" })).toContainText("URL harbor")
})

test("panel: tab, card sub-tab and closed state survive reload and Back/Forward", async ({ page }) => {
  await open(page)
  await openPanel(page, "Notes")
  await page.goBack()
  await expect(page.getByRole("tabpanel", { name: "This chat", exact: true })).toBeVisible()
  await page.goBack()
  await expect(page.getByRole("tablist", { name: "Chat panel" })).toHaveCount(0)
  await page.goForward()
  await expect(page.getByRole("tabpanel", { name: "This chat", exact: true })).toBeVisible()
  await page.goForward()
  await expect(page.getByRole("tabpanel", { name: "Notes", exact: true })).toBeVisible()
  const cardPanel = await openPanel(page, "Url Wren")
  await cardPanel.getByRole("tab", { name: "Metadata", exact: true }).click()
  await reload(page)
  await expect(cardPanel.getByRole("tab", { name: "Metadata", exact: true })).toHaveAttribute("aria-selected", "true")
  await page.goBack()
  await expect(cardPanel.getByRole("tab", { name: "Definition", exact: true })).toHaveAttribute("aria-selected", "true")
  await page.goForward()
  await expect(cardPanel.getByRole("tab", { name: "Metadata", exact: true })).toHaveAttribute("aria-selected", "true")
  await closePanel(page)
  await reload(page)
  await expect(page.getByRole("tablist", { name: "Chat panel" })).toHaveCount(0)
})

test("preset overlay: focused prompt, expansion and revision-history dialog reload", async ({ page }) => {
  await open(page)
  const panel = await openPanel(page, "Prompt preset")
  await openPresetAt(page, panel, "Main Prompt")
  await expect(page.getByRole("dialog", { name: "Preset editor", exact: true })).toBeVisible()
  await expect(page).toHaveURL(/editor=/)
  await reload(page)
  const overlay = page.getByRole("dialog", { name: "Preset editor", exact: true })
  await expect(overlay).toBeVisible()
  await expect(overlay.locator('[data-prompt="main"]')).toBeVisible()
  await overlay.getByRole("button", { name: "History", exact: true }).click()
  await reload(page)
  await expect(page.getByRole("dialog", { name: "History", exact: true })).toBeVisible()
  await page.goBack()
  await expect(page.getByRole("dialog", { name: "History", exact: true })).toHaveCount(0)
  await page.goBack()
  await expect(overlay).toHaveCount(0)
  await page.goForward()
  await expect(overlay).toBeVisible()
})

test("lorebook panel and overlay: opened book, entry and filter reload; stale entries explain", async ({ page }) => {
  await open(page)
  const panel = await openPanel(page, "Lorebooks")
  await panel.getByRole("button", { name: /^Url Book/ }).click()
  const editor = panel.getByRole("region", { name: "Lorebook Url Book" })
  await expect(editor).toBeVisible()
  await editor.getByRole("button", { name: /Open Harbor/ }).click()
  await reload(page)
  await expect(editor.getByRole("group", { name: /^Lorebook entry / })).toBeVisible()
  await editor.getByRole("button", { name: "Large editor", exact: true }).click()
  await reload(page)
  await expect(page.getByRole("dialog", { name: "Lorebook editor", exact: true })).toBeVisible()
  const url = new URL(page.url())
  url.searchParams.set(`entries:${book}::entry`, JSON.stringify("999999"))
  await page.goto(url.href)
  await expect(page.getByText("This entry is no longer in the lorebook.", { exact: true })).toBeVisible()
})

test("card overlay: item and sub-tab restore from a copied link; missing ref is explained", async ({
  page,
  browser
}) => {
  await open(page, `&editor=${cardRef}`)
  const overlay = page.getByRole("dialog", { name: "Card editor", exact: true })
  await overlay.getByRole("tab", { name: "Metadata", exact: true }).click()
  const url = page.url()
  await reload(page)
  await expect(overlay.getByRole("tab", { name: "Metadata", exact: true })).toHaveAttribute("aria-selected", "true")
  const context = await browser.newContext()
  try {
    await apiLogin(context.request, server(), ADMIN.handle, ADMIN.password)
    const copied = await context.newPage()
    await copied.goto(url)
    await expect(
      copied
        .getByRole("dialog", { name: "Card editor", exact: true })
        .getByRole("tab", { name: "Metadata", exact: true })
    ).toHaveAttribute("aria-selected", "true")
  } finally {
    await context.close()
  }
  await open(page, "&editor=missing-ref")
  await expect(page.getByText(/This item was deleted or never existed/)).toBeVisible()
})

for (const width of [1440, 390])
  test(`portraits: viewer reloads and Back closes it at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await open(page)
    const panel = await openPanel(page, "Cast")
    await panel.getByRole("button", { name: "View Url Wren's portrait", exact: true }).click()
    await expect(page.getByRole("img", { name: "Url Wren's full portrait", exact: true })).toBeVisible()
    await reload(page)
    await expect(page.getByRole("img", { name: "Url Wren's full portrait", exact: true })).toBeVisible()
    await page.goBack()
    await expect(page.getByRole("img", { name: "Url Wren's full portrait", exact: true })).toHaveCount(0)
    await page.goForward()
    await expect(page.getByRole("img", { name: "Url Wren's full portrait", exact: true })).toBeVisible()
  })

test("library: kind, search, filter, sort, direction and view reload, with history", async ({ page }) => {
  await page.goto(`${server().url}/library`)
  const main = page.getByRole("main")
  const search = main.getByRole("searchbox", { name: "Search cards", exact: true })
  await search.fill("Url")
  await main
    .getByRole("group", { name: "View", exact: true })
    .getByRole("button", { name: "Grid", exact: true })
    .click()
  await reload(page)
  await expect(search).toHaveValue("Url")
  await expect(main.getByRole("button", { name: "Grid", exact: true })).toHaveAttribute("aria-pressed", "true")
  await main.getByRole("tab", { name: /^Presets/ }).click()
  await main.getByRole("group", { name: "Show presets" }).getByRole("button", { name: "Archived", exact: true }).click()
  await reload(page)
  await expect(main.getByRole("button", { name: "Archived", exact: true })).toHaveAttribute("aria-pressed", "true")
  await page.goBack()
  await expect(main.getByRole("tab", { name: /^Cards/ })).toHaveAttribute("aria-selected", "true")
  await expect(search).toHaveValue("Url")
})

test("settings: section path survives reload and Back/Forward", async ({ page }) => {
  await page.goto(`${server().url}/settings/chats`)
  await expect(page.getByRole("heading", { name: "Chats", exact: true })).toBeVisible()
  await page.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "Interface", exact: true }).click()
  await reload(page)
  await expect(page).toHaveURL(/\/settings\/interface$/)
  await page.goBack()
  await expect(page).toHaveURL(/\/settings\/chats$/)
  await page.goForward()
  await expect(page).toHaveURL(/\/settings\/interface$/)
})

test("import: target and missing selected folder job restore with an explanation", async ({ page }) => {
  await page.goto(`${server().url}/import?into=${preset}`)
  await reload(page)
  await expect(page.getByRole("main")).toContainText("Url Preset")
  await page.goto(`${server().url}/import/st?job=removed-job`)
  await reload(page)
  await expect(page.getByText("That import isn't in the list", { exact: true })).toBeVisible()
  await page.goBack()
  await expect(page).toHaveURL(new RegExp(`/import\\?into=${preset}$`))
})

test("bin: section follows the URL after reload and Back/Forward", async ({ page }) => {
  await page.goto(`${server().url}/bin`)
  await page.getByRole("tab", { name: "Recovered text", exact: true }).click()
  await expect(page).toHaveURL(/section=recovered/)
  await reload(page)
  await expect(page.getByRole("tab", { name: "Recovered text", exact: true })).toHaveAttribute("aria-selected", "true")
  await page.goBack()
  await expect(page.getByRole("tab", { name: "Deleted", exact: true })).toHaveAttribute("aria-selected", "true")
  await page.goForward()
  await expect(page.getByRole("tab", { name: "Recovered text", exact: true })).toHaveAttribute("aria-selected", "true")
})

test("chat: branch, message link and reading offset restore; missing branch falls back", async ({ page }) => {
  await open(page, `&slot=${slots[40]}`)
  const list = page.getByTestId("messages")
  const target = page.locator(`article[data-slot="${slots[40]}"]`)
  await expect(target).toBeVisible()
  await list.evaluate((el) => {
    el.scrollTop -= 140
    el.dispatchEvent(new Event("scroll"))
  })
  await expect.poll(() => page.evaluate(() => Boolean(history.state.chatReading?.slot))).toBe(true)
  const position = await page.evaluate(() => history.state.chatReading as { slot: string; offset: number })
  await reload(page)
  const restored = page.locator(`article[data-slot="${position.slot}"]`)
  await expect(restored).toBeVisible()
  await expect
    .poll(async () =>
      restored.evaluate(
        (el) => el.getBoundingClientRect().top - el.closest('[data-testid="messages"]')!.getBoundingClientRect().top
      )
    )
    .toBeCloseTo(position.offset, 0)
  await page.goto(`${server().url}/chats/${chat}?fork=missing-branch`)
  await expect(
    page.getByText("This branch is no longer available. Showing the current branch.", { exact: true })
  ).toBeVisible()
  await expect(page.locator("article[data-slot]").last()).toBeVisible()
})

for (const width of [1440, 390]) {
  test(`Interface links preserve legacy addresses at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(`${server().url}/settings/display?from=legacy`)
    await expect(page).toHaveURL(/\/settings\/interface\?from=legacy$/)
    if (width === 390) await expect(page.getByRole("heading", { name: "Interface", exact: true })).toBeVisible()
    else
      await expect(page.getByRole("link", { name: "Interface", exact: true })).toHaveAttribute("aria-current", "page")
    await page.goto(`${server().url}/chats/${chat}?panel=display`)
    await expect(page.getByRole("tabpanel", { name: "Interface", exact: true })).toBeVisible()
    await expect(page).toHaveURL(/panel=interface/)
    const tab = page.getByRole("tab", { name: "Interface", exact: true })
    await expect(tab).toHaveAttribute("aria-selected", "true")
    await expect(page.getByRole("tab", { name: "Display", exact: true })).toHaveCount(0)
    await reload(page)
    await expect(page.getByRole("tabpanel", { name: "Interface", exact: true })).toBeVisible()
  })
}

// Synthetic lists, measured against the scrollport (clientWidth excludes a classic
// scrollbar). Also keep the action clear of its own row/card's edge. Leading accessories
// such as a portrait, checkbox or drag handle aren't horizontal content padding.
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, type Locator, test } from "@playwright/test"
import type { ChatId } from "@dreamspan/shared/chat.ts"
import { Effect } from "effect"
import { type Client, loginCookie, withCookie } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { closePanel, openPanel } from "./support/panel.ts"
import { modelChip, presetChip } from "./support/strip.ts"

test.use({
  reducedMotion: "reduce",
  launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"], args: ["--disable-features=OverlayScrollbar"] }
})

const server = serverPerFile(withAdmin)
let cookie: string
let chatId: ChatId
const rpc = <A>(run: (api: Client) => Effect.Effect<A, unknown>) => withCookie(server(), cookie, run)
const before = process.env.ROW_EDGES_BEFORE === "1"
const shots = process.env.SCREENSHOT_DIR

test.beforeAll(async () => {
  cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
  chatId = await rpc((api) =>
    Effect.gen(function* () {
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: "Synthetic models",
          baseUrl: "http://127.0.0.1:9/v1",
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        },
        apiKey: null
      })
      const preset = yield* api.CreatePreset({ label: "Harbour style 00" })
      const model = yield* api.AddUserModel({ connectionId: connection.id, key: "harbour-00", overrides: {} })
      yield* api.SetGenerationDefaults({
        defaults: { model: { connection: connection.id, model: model.id }, preset: preset.id }
      })
      const chat = yield* api.CreateChat({ title: "Harbour notebook" })
      const sent = yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: null,
        branch: false,
        content: "The lanterns are lit.",
        reply: false
      })
      if (sent._tag !== "Posted") throw new Error("fixture send queued")
      let entry = sent.entry
      const slotId = entry.slotId
      for (let i = 1; i <= 20; i++) {
        const n = String(i).padStart(2, "0")
        yield* api.CreatePreset({ label: `Harbour style ${n}` })
        yield* api.CreateChat({ title: `Harbour visit ${n}` })
        yield* api.AddUserModel({ connectionId: connection.id, key: `harbour-${n}`, overrides: {} })
        const card = yield* api.CreateCard({ label: `Harbour keeper ${n}`, name: `Harbour keeper ${n}` })
        yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: card.entityId } })
        yield* api.CreateChatNote({ chatId: chat.id, title: `Harbour note ${n}` })
        yield* api.CreateSnippet({
          chatId: chat.id,
          title: `Harbour snippet ${n}`,
          content: "Lanterns along the quay."
        })
        const version = yield* api.WriteVersion({
          slotId,
          content: `Lantern version ${n}`,
          expectedRowVersion: entry.rowVersion
        })
        entry = version
      }
      for (let i = 1; i <= 16; i++) {
        const fork = yield* api.CreateFork({ chatId: chat.id, fromForkId: null, atSlotId: slotId })
        yield* api.NameFork({ forkId: fork.fork.id, name: `Harbour branch ${String(i).padStart(2, "0")}` })
      }
      return chat.id
    })
  )
  // The import endpoint parses public ST-format synthetic books. No direct database work.
  for (let i = 0; i < 20; i++) {
    const label = `Harbour lore ${String(i).padStart(2, "0")}`
    const response = await fetch(`${server().url}/library/import?name=${encodeURIComponent(label)}.json`, {
      method: "POST",
      headers: { cookie, origin: server().url, "content-type": "application/octet-stream" },
      body: JSON.stringify({
        name: label,
        entries: Object.fromEntries(
          Array.from({ length: 20 }, (_, uid) => [
            uid,
            {
              uid,
              comment: `Harbour entry ${uid}`,
              key: ["lantern"],
              content: "A synthetic harbour.",
              position: 0,
              order: 100
            }
          ])
        )
      })
    })
    expect(response.ok).toBe(true)
  }
  await rpc((api) =>
    Effect.gen(function* () {
      for (const book of yield* api.ListLibrary({ kind: "lorebook" }))
        yield* api.ChangeCast({
          chatId,
          slotId: null,
          change: { _tag: "Lorebook", ref: book.id, active: true }
        })
    })
  )
})

/** Check rendered geometry, not a class name or a fixed expected padding value. */
async function measure(action: Locator, row: Locator, primary: Locator, text?: Locator) {
  const rowBox = await row.boundingBox()
  const primaryBox = await primary.boundingBox()
  const textBox = await text?.boundingBox()
  expect(rowBox).not.toBeNull()
  expect(primaryBox).not.toBeNull()
  const padding = await primary.evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft))
  // Blocks lead with switches/handles. Compare their content padding, without
  // counting those accessories as empty space at the edge.
  const blockHeader = await row.evaluate((el) => el.tagName === "HEADER" || el.hasAttribute("data-entry-header"))
  // Rows led by a control (a block's header: prompts, notes, snippets; sidebar, branch and
  // version rows) have the layout audit's 8 px on both sides, from the row's edge to the box of
  // its first and of its last control (layoutlint, layoutfixes); the leading control's own
  // padding isn't edge space the action must match. Rows led by text (presets, lorebook entry
  // titles) match the text's inset.
  const header = await row.evaluate((el) => el.tagName === "HEADER")
  const rowPadding = await row.evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft))
  const leftInset = textBox
    ? textBox.x - rowBox!.x
    : blockHeader
      ? rowPadding + (header ? 0 : padding)
      : primaryBox!.x - rowBox!.x
  const geometry = await action.evaluate((el) => {
    let scroll = el.parentElement!
    let fallback: HTMLElement | null = null
    while (scroll.parentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(scroll).overflowY)) {
        fallback ??= scroll
        if (scroll.scrollHeight > scroll.clientHeight) break
      }
      scroll = scroll.parentElement
    }
    if (!scroll.parentElement) scroll = fallback ?? scroll
    const box = scroll.getBoundingClientRect()
    return {
      right: el.getBoundingClientRect().right,
      innerRight: box.left + scroll.clientLeft + scroll.clientWidth,
      scrolling: scroll.scrollHeight > scroll.clientHeight,
      overflow: scroll.scrollWidth - scroll.clientWidth
    }
  })
  if (!before) {
    expect(geometry.innerRight - geometry.right, "action inset from scrollport").toBeGreaterThanOrEqual(leftInset - 1)
    expect(rowBox!.x + rowBox!.width - geometry.right, "action inset from row").toBeGreaterThanOrEqual(leftInset - 1)
    expect(geometry.overflow, "no horizontal overflow").toBeLessThanOrEqual(1)
  }
  return { leftInset, rightInset: rowBox!.x + rowBox!.width - geometry.right, ...geometry }
}

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`row actions keep their inset, ${width} ${theme}`, async ({ page }) => {
      test.setTimeout(180_000)
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const results: Record<string, { scrolling?: boolean }> = {}
      const shot = async (name: string) => {
        if (shots) {
          mkdirSync(shots, { recursive: true })
          await page.screenshot({ path: join(shots, `${name}-${width}-${theme}.png`) })
        }
      }
      const go = async () => {
        await page.goto(`${server().url}/chats/${chatId}`)
        await expect(page.getByLabel("Message", { exact: true })).toBeEditable()
      }
      await go()
      const panel = await openPanel(page, "Prompt preset")
      await panel.getByRole("button", { name: /^Prompt preset for the next reply:/ }).click()
      const presets = page.getByRole("radiogroup", { name: "Prompt preset", exact: true })
      const presetRow = presets
        .locator("[data-picker-row]")
        .filter({ has: page.getByRole("radio", { name: "Harbour style 01", exact: true }) })
      const archive = presetRow.getByRole("button", { name: "Archive Harbour style 01", exact: true })
      await expect(archive).toBeVisible()
      results.presets = await measure(
        archive,
        presetRow,
        presetRow.getByRole("radio"),
        presetRow.getByText("Harbour style 01", { exact: true })
      )
      await archive.hover()
      const tooltip = page.getByText("Archive: hide it from these lists; nothing is deleted", { exact: true })
      await expect(tooltip).toBeVisible()
      const tipBox = await tooltip.boundingBox()
      if (!before) {
        expect(tipBox!.x).toBeGreaterThanOrEqual(0)
        expect(tipBox!.x + tipBox!.width).toBeLessThanOrEqual(width)
        expect(tipBox!.y).toBeGreaterThanOrEqual(0)
        expect(tipBox!.y + tipBox!.height).toBeLessThanOrEqual(900)
      }
      await shot("preset-picker")
      // A filtered list has no scrollbar; its inset must be the same.
      await page.getByRole("searchbox", { name: "Find a prompt preset" }).fill("Harbour style 01")
      results.presetsFiltered = await measure(
        archive,
        presetRow,
        presetRow.getByRole("radio"),
        presetRow.getByText("Harbour style 01", { exact: true })
      )
      await page.keyboard.press("Escape")
      await closePanel(page)
      await modelChip(page).click()
      const models = page.getByRole("radiogroup", { name: "Model", exact: true })
      const modelRow = models.locator("[data-picker-row]").first()
      // Models use the same rows but currently contribute no secondary action.
      await expect(modelRow).toBeVisible()
      await expect(models.locator("[data-picker-action]")).toHaveCount(0)
      results.models = {}
      await shot("model-picker")
      await page.keyboard.press("Escape")

      for (const [tab, prefix, actionName] of [
        ["Notes", "Note Harbour note", /^Actions for Harbour note/],
        ["Snippets", "Snippet Harbour snippet", /^Copy Harbour snippet/]
      ] as const) {
        const tabPanel = await openPanel(page, tab)
        const block = tabPanel.getByRole("region", { name: new RegExp(`^${prefix}`) }).first()
        const header = block.locator("header")
        const toggle = header.getByRole("button", { name: /^(Expand|Collapse)/ })
        await expect(toggle).toBeVisible()
        results[tab] = await measure(header.getByRole("button", { name: actionName }).last(), header, toggle)
        await shot(tab.toLowerCase())
      }
      const cast = await openPanel(page, "Cast")
      const member = cast.getByRole("listitem", { name: "Harbour keeper 01", exact: true })
      await expect(member).toBeVisible()
      // The first visible content is a portrait; the panel already has symmetric gutters.
      results.cast = await measure(member.getByRole("button").last(), cast, member.locator(":scope > span").first())
      await shot("cast")
      const lore = await openPanel(page, "Lorebooks")
      const loreRow = lore.getByRole("list", { name: "Lorebooks in this chat" }).getByRole("listitem").first()
      await expect(loreRow).toBeVisible()
      results.lorebooks = await measure(
        loreRow.getByRole("button", { name: /^More for/ }),
        loreRow,
        loreRow.locator(":scope > span").first()
      )
      await shot("lorebooks")
      await loreRow.getByRole("button").first().click()
      const entryHeader = lore.locator("[data-entry-header]").first()
      await expect(entryHeader).toBeAttached()
      await entryHeader.scrollIntoViewIfNeeded()
      results.lorebookEntries = await measure(
        entryHeader.getByRole("button", { name: /^More for/ }),
        entryHeader,
        entryHeader.getByRole("textbox", { name: /^Title of/ })
      )
      await shot("lorebook-entries")
      const prompts = await openPanel(page, "Prompt preset")
      const prompt = prompts.locator("[data-prompt]").first()
      await expect(prompt).toBeVisible()
      const promptHeader = prompt.locator("header")
      results.prompts = await measure(
        promptHeader.getByRole("button", { name: /^Actions for/ }),
        promptHeader,
        promptHeader
      )
      await shot("prompts")
      await closePanel(page)

      await page.getByRole("button", { name: /^Branch:.*switch branch$/ }).click()
      const branches = page.getByRole("dialog", { name: "Branches of this chat" })
      const branchRow = branches.locator("[data-fork]").first()
      await expect(branchRow).toBeVisible()
      results.branches = await measure(
        branchRow.getByRole("button", { name: /^Delete/ }),
        branchRow,
        // Its text block: the title line leads with the name, its pencil after it.
        branchRow.locator("[data-row-text]")
      )
      await shot("branch-picker")
      await page.keyboard.press("Escape")
      const message = page.getByRole("article").first()
      await message.getByRole("button", { name: /choose a swipe/ }).click()
      const versionRow = page.locator("[data-version]").first()
      await expect(versionRow).toBeVisible()
      results.versions = await measure(
        versionRow.getByRole("button", { name: /from the arrows/ }),
        versionRow,
        versionRow.getByRole("button").first()
      )
      await shot("version-picker")
      await page.keyboard.press("Escape")

      if (width === 390) await page.getByRole("button", { name: "Chats and menu" }).click()
      const sidebarChat = page.getByRole("link", { name: "Open chat Harbour notebook", exact: true }).first()
      await expect(sidebarChat).toBeVisible()
      const shellRow = sidebarChat.locator("..")
      results.sidebar = await measure(shellRow.getByRole("button", { name: /^Pin / }), shellRow, sidebarChat)
      await shot("sidebar-chats")
      await page.goto(`${server().url}/chats`)
      const chats = page.getByRole("list", { name: "Chats", exact: true })
      const chatRow = chats.getByRole("listitem").first()
      await expect(chatRow).toBeVisible()
      await chatRow.hover()
      results.chatList = await measure(
        chatRow.getByRole("button", { name: /^Delete/ }),
        chatRow,
        chatRow.getByRole("link")
      )
      await shot("chat-list")

      await page.goto(`${server().url}/library`)
      await page.getByRole("tab", { name: /^Presets/ }).click()
      const libraryRow = page.getByRole("list", { name: "Presets", exact: true }).getByRole("listitem").first()
      await expect(libraryRow).toBeVisible()
      results.library = await measure(
        libraryRow.getByRole("button").last(),
        libraryRow.locator("../.."),
        libraryRow.locator("a").first()
      )
      await shot("library-presets")
      for (const [name, geometry] of Object.entries(results)) {
        if (name !== "models" && name !== "presetsFiltered")
          expect(geometry.scrolling, `${name} has a scrollbar`).toBe(true)
      }
      expect(results.presetsFiltered?.scrolling).toBe(false)
      if (shots) writeFileSync(join(shots, `geometry-${width}-${theme}.json`), JSON.stringify(results, null, 2))
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
    })
  }

test("preset action insets at narrow and intermediate widths, with and without scrolling", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  for (const width of [320, 480, 768, 1024]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(`${server().url}/chats/${chatId}`)
    await expect(page.getByLabel("Message", { exact: true })).toBeEditable()
    await presetChip(page).click()
    const list = page.getByRole("radiogroup", { name: "Prompt preset", exact: true })
    const row = list
      .locator("[data-picker-row]")
      .filter({ has: page.getByRole("radio", { name: "Harbour style 01", exact: true }) })
    const label = row.getByText("Harbour style 01", { exact: true })
    const action = row.getByRole("button", { name: "Archive Harbour style 01", exact: true })
    await expect(action).toBeVisible()
    const full = await measure(action, row, row.getByRole("radio"), label)
    expect(full.scrolling).toBe(true)
    await page.getByRole("searchbox", { name: "Find a prompt preset" }).fill("Harbour style 01")
    const filtered = await measure(action, row, row.getByRole("radio"), label)
    expect(filtered.scrolling).toBe(false)
    expect(filtered.rightInset).toBe(full.rightInset)
    await row.getByRole("radio").focus()
    await page.keyboard.press("Tab")
    await expect(action).toBeFocused()
    const tooltip = page.getByText("Archive: hide it from these lists; nothing is deleted", { exact: true })
    await expect(tooltip).toBeVisible()
    const box = await tooltip.boundingBox()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(width)
  }
})

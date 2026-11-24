// The center column's frames and tabs (owner, 2026-11-05; DESIGN §10.1): one item looks as a
// single view did; single-click opens are preview tabs, a double click or an edit keeps them;
// splits show two chats, or a chat and an editor, side by side; the side panel follows the
// frame focused last; the layout survives a reload of its browser tab; phones switch tabs from a strip.
// SCREENSHOT_DIR saves full-surface screenshots for the report.
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
import { openPanel } from "./support/panel.ts"
import { expectTextBox, replaceEditorText, textBoxValue } from "./support/textbox.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { gotoWithLayout, storedLayout } from "./support/workbench.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)

const shots = process.env.SCREENSHOT_DIR
const shot = async (page: Page, name: string) => {
  if (!shots) return
  mkdirSync(shots, { recursive: true })
  await page.mouse.move(0, 0)
  await page.screenshot({ path: join(shots, `${name}.png`) })
}

let fixtures: { chatA: string; chatB: string; presetA: string; presetB: string; theme: string }

test.beforeAll(async () => {
  fixtures = await admin((api) =>
    Effect.gen(function* () {
      const mira = yield* api.CreateCard({ label: "Mira", name: "Mira" })
      const wren = yield* api.CreateCard({ label: "Wren", name: "Wren" })
      const presetA = yield* api.CreatePreset({ label: "Harbour preset" })
      const presetB = yield* api.CreatePreset({ label: "Lighthouse preset" })
      const chat = (title: string, entityId: typeof mira.entityId, line: string) =>
        Effect.gen(function* () {
          const made = yield* api.CreateChat({ title })
          yield* api.ChangeCast({ chatId: made.id, slotId: null, change: { _tag: "Join", entityId } })
          yield* api.SendMessage({ chatId: made.id, parentSlotId: null, branch: false, content: line, reply: false })
          return made.id
        })
      // The chats use the Harbour preset, so the preset tab can open it large.
      yield* api.ChangeGenerationDefaults({ change: { preset: presetA.id } })
      const chatA = yield* chat("Harbour walk", mira.entityId, "The tide is out; the boats lean on the mud.")
      const chatB = yield* chat("Lighthouse night", wren.entityId, "The lamp turns, and the stairs go up forever.")
      return { chatA, chatB, presetA: presetA.id, presetB: presetB.id, theme: "light" }
    })
  )
})

// A message in a frame, not the sidebar's preview of it.
const said = (page: Page, text: string) => page.locator("[data-frame]").getByText(text)
const strip = (page: Page) => page.locator("[data-tab-strip]")
const tabs = (page: Page) => page.getByRole("tab").and(page.locator("[data-tab] [role=tab]"))
/** The sidebar on a character's chats (owner, 2026-11-06: opening a character shows them). */
const expectCharacterSidebar = async (page: Page, name: string, chat: string, other: string) => {
  const sidebar = page.getByRole("complementary", { name: "Sidebar" })
  const crumbs = sidebar.getByRole("navigation", { name: "Chat breadcrumbs" })
  await expect(crumbs).toContainText("All chats")
  await expect(crumbs).toContainText(name)
  await expect(sidebar.getByRole("button", { name: `New Roleplay with ${name}`, exact: true })).toBeVisible()
  await expect(sidebar.getByRole("link", { name: new RegExp(`^Open chat ${chat}`) })).toBeVisible()
  await expect(sidebar.getByRole("link", { name: new RegExp(`^Open chat ${other}`) })).toHaveCount(0)
}
const sidebarChat = (page: Page, title: string) =>
  page.getByRole("complementary", { name: "Sidebar" }).getByRole("link", { name: new RegExp(`^Open chat ${title}`) })

const fresh = async (page: Page, width: number, theme: "light" | "dark" = "light") => {
  await page.setViewportSize({ width, height: 900 })
  await page.emulateMedia({ colorScheme: theme })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
}

test("one chat looks as a single view; opens are previews until kept", async ({ page }) => {
  test.setTimeout(120_000)
  await fresh(page, 1440)
  await page.goto(`${server().url}/chats/${fixtures.chatA}`)
  await expect(said(page, "The tide is out")).toBeVisible()
  // No strip for one tab; the split buttons sit in the header.
  await expect(strip(page)).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Split right" })).toBeVisible()
  await shot(page, "single-chat-1440-light")

  // A single click on another chat replaces the preview tab, as navigating did.
  await sidebarChat(page, "Lighthouse night").click()
  await expect(said(page, "The lamp turns")).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`/chats/${fixtures.chatB}`))
  await expect(strip(page)).toHaveCount(0)

  // A double click keeps it; the next open gets a tab of its own beside it.
  await sidebarChat(page, "Lighthouse night").dblclick()
  await sidebarChat(page, "Harbour walk").click()
  await expect(said(page, "The tide is out")).toBeVisible()
  await expect(tabs(page)).toHaveCount(2)
  await expect(page.locator("[data-tab][data-preview]")).toHaveCount(1)

  // Back returns to the chat shown before, as a browser's would.
  await page.goBack()
  await expect(said(page, "The lamp turns")).toBeVisible()
  await expect(said(page, "The tide is out")).toHaveCount(0)
  await page.goForward()
  await expect(said(page, "The tide is out")).toBeVisible()

  // Typing in the composer keeps a preview tab open.
  await page.getByRole("textbox", { name: "Message" }).fill("Draft for the harbour")
  await expect(page.locator("[data-tab][data-preview]")).toHaveCount(0)

  // Each tab keeps its own draft.
  await page.getByRole("tab", { name: "Lighthouse night" }).click()
  await expect(said(page, "The lamp turns")).toBeVisible()
  await expect
    .poll(() => textBoxValue(page.getByRole("textbox", { name: "Message" })))
    .not.toBe("Draft for the harbour")
  await page.getByRole("tab", { name: "Harbour walk" }).click()
  await expectTextBox(page.getByRole("textbox", { name: "Message" }), "Draft for the harbour")

  // Closing a tab shows the one focused before.
  await page.getByRole("button", { name: "Close Harbour walk" }).click()
  await expect(said(page, "The lamp turns")).toBeVisible()
  await expect(strip(page)).toHaveCount(0)
})

test("two chats side by side; the side panel follows the frame focused last; it all survives a reload", async ({
  page
}) => {
  test.setTimeout(150_000)
  await fresh(page, 1440)
  await page.goto(`${server().url}/chats/${fixtures.chatA}`)
  await expect(said(page, "The tide is out")).toBeVisible()
  await openPanel(page, "This chat")
  // Split right shows the chat in both frames (VS Code's Split Editor); the next open goes
  // beside the copy, in the frame focused now.
  await page.getByRole("button", { name: "Split right" }).click()
  await expect(page.locator("[data-frame]")).toHaveCount(2)
  await expect(said(page, "The tide is out")).toHaveCount(2)
  await sidebarChat(page, "Lighthouse night").click()
  await expect(said(page, "The lamp turns")).toBeVisible()
  await expect(said(page, "The tide is out")).toBeVisible()
  // The panel shows the chat focused last.
  const panel = page.getByRole("complementary", { name: "Chat panel" })
  await expect(panel).toHaveCount(1)
  await expect(page).toHaveURL(new RegExp(`/chats/${fixtures.chatB}`))
  await shot(page, "two-chats-1440-light")
  if (process.env.LAYOUT_AUDIT) await expectLayout(page, test.info(), "two-chats")
  await page.locator("[data-frame]").first().getByText("The tide is out").click()
  await expect(page).toHaveURL(new RegExp(`/chats/${fixtures.chatA}`))

  // A tab moves with a visible control, not only by dragging.
  await page.locator("[data-frame]").nth(1).getByRole("button", { name: "Tab and frame actions" }).click()
  await page.getByRole("menuitem", { name: "Move to the frame on the left" }).click()
  await expect(page.locator("[data-frame]").first().locator("[data-tab]")).toHaveCount(2)
  // The right frame kept its own view of the first chat; closing it closes the frame.
  await page.locator("[data-frame]").nth(1).getByRole("button", { name: "Close Harbour walk" }).click()
  await expect(page.locator("[data-frame]")).toHaveCount(1)
  await expect(tabs(page)).toHaveCount(2)
  await page.getByRole("button", { name: "Tab and frame actions" }).click()
  await page.getByRole("menuitem", { name: "Move to a new frame on the right" }).click()
  await expect(page.locator("[data-frame]")).toHaveCount(2)

  // A reload brings back the frames and their tabs.
  await expect.poll(() => storedLayout(page)).toContain('["r",')
  await page.reload()
  await expect(page.locator("[data-frame]")).toHaveCount(2)
  await expect(said(page, "The lamp turns")).toBeVisible()
  await expect(said(page, "The tide is out")).toBeVisible()
})

test("old editor links and modified opener clicks keep their browser navigation", async ({ page, context }) => {
  test.setTimeout(120_000)
  await fresh(page, 1440)
  await page.goto(`${server().url}/chats/${fixtures.chatA}?editor=${fixtures.presetA}`)
  await expect(page.getByRole("region", { name: "Preset editor", exact: true })).toBeVisible()
  await expect(tabs(page)).toHaveCount(2)
  await expect(page).toHaveURL(new RegExp(`/library/${fixtures.presetA}`))
  await page.getByRole("tab", { name: "Harbour walk", exact: true }).click()
  const original = page.url()
  for (const click of [{ button: "middle" as const }, { modifiers: ["Control" as const] }]) {
    const opened = context.waitForEvent("page")
    await sidebarChat(page, "Lighthouse night").click(click)
    const other = await opened
    await expect(other).toHaveURL(new RegExp(`/chats/${fixtures.chatB}`))
    await expect(said(other, "The lamp turns")).toBeVisible()
    await expect(page).toHaveURL(original)
    await other.close()
  }
})

test("stale layouts keep deleted items closable and unknown versions start fresh", async ({ page }) => {
  test.setTimeout(120_000)
  await fresh(page, 1440)
  await page.goto(`${server().url}/chats/${fixtures.chatA}`)
  await expect(said(page, "The tide is out")).toBeVisible()
  const missing = "00000000-0000-4000-8000-000000000000"
  // A copied URL naming tabs whose items are gone: the URL's own chat and two others.
  await gotoWithLayout(page, server().url, `/chats/${fixtures.chatA}`, [
    0,
    "=",
    `/chats/${missing}`,
    `/library/${missing}`
  ])
  await expect(tabs(page)).toHaveCount(3)
  const missingItem = page.locator("[data-tab]").nth(2)
  await missingItem.getByRole("tab").click()
  await expect(page.getByText("This item was deleted or never existed", { exact: false })).toBeVisible()
  await missingItem.getByRole("button", { name: /^Close / }).click()
  await expect(tabs(page)).toHaveCount(2)
  const missingChat = page.locator("[data-tab]").nth(1)
  await missingChat.getByRole("tab").click()
  await expect(page.getByRole("alert").first()).toBeVisible()
  await missingChat.getByRole("button", { name: /^Close / }).click()
  await expect(said(page, "The tide is out")).toBeVisible()
  // One tab left: the URL is the whole layout.
  await expect.poll(() => storedLayout(page)).toBeNull()
  // Junk in the param: the URL's page alone.
  await page.goto(`${server().url}/chats/${fixtures.chatA}?wb=${encodeURIComponent('{"version":0}')}`)
  await expect(said(page, "The tide is out")).toBeVisible()
  await expect(tabs(page)).toHaveCount(0)
})

test("an editor opened from one of two chat views shares that view's panel store", async ({ page }) => {
  test.setTimeout(120_000)
  await fresh(page, 1440)
  await page.goto(`${server().url}/chats/${fixtures.chatA}`)
  await openPanel(page, "Prompt preset")
  await page.getByRole("button", { name: "Split right", exact: true }).click()
  const left = page.locator("[data-frame]").first()
  await left.getByRole("textbox", { name: "Message", exact: true }).click()
  await page.getByRole("link", { name: "Open the preset in the large editor" }).click()
  const editor = page.getByRole("region", { name: "Preset editor", exact: true })
  await expect(editor).toBeVisible()
  const panel = page.getByRole("tabpanel", { name: "Prompt preset", exact: true })
  await panel.getByRole("button", { name: "Expand Main Prompt", exact: true }).click()
  const field = panel.getByRole("textbox", { name: "Prompt: Main Prompt", exact: true })
  await replaceEditorText(field, "Shared with the originating chat view.")
  await expectTextBox(
    editor.getByRole("textbox", { name: "Prompt: Main Prompt", exact: true }),
    "Shared with the originating chat view."
  )
  await page.locator("[data-frame]").nth(1).getByRole("button", { name: "Close Harbour walk", exact: true }).click()
  await replaceEditorText(field, "Still shared after the other view closes.")
  await expectTextBox(
    editor.getByRole("textbox", { name: "Prompt: Main Prompt", exact: true }),
    "Still shared after the other view closes."
  )
})

// Half-width frames keep their header and composer readable: the branch picker shows its name
// or, where there's no room, only its icon (the name in its explanation), never a name cut to a
// letter; the speaker chip keeps a picture.
for (const width of [1440, 1024])
  for (const theme of ["light", "dark"] as const)
    test(`half-width frames at ${width} ${theme}: header and composer controls stay readable`, async ({ page }) => {
      test.setTimeout(120_000)
      await fresh(page, width, theme)
      await page.goto(`${server().url}/chats/${fixtures.chatA}`)
      await expect(said(page, "The tide is out")).toBeVisible()
      if (width === 1440) await openPanel(page, "This chat")
      await page.getByRole("button", { name: "Split right" }).click()
      await sidebarChat(page, "Lighthouse night").click()
      await expect(said(page, "The lamp turns")).toBeVisible()
      await expect(said(page, "The tide is out")).toBeVisible()
      const frames = page.locator("[data-frame]")
      await expect(frames).toHaveCount(2)
      for (const frame of await frames.all()) {
        const branch = frame.getByRole("button", { name: /^Branch:.*switch branch$/ })
        await expect(branch).toBeVisible()
        // The name is either hidden or wide enough to read (at least 4rem), not "O" or "Orig…".
        const label = await branch.evaluate((button) => {
          const name = [...button.querySelectorAll("span")].find((span) => span.classList.contains("truncate"))
          if (!name || getComputedStyle(name).display === "none") return null
          return name.getBoundingClientRect().width
        })
        if (label !== null) expect(label).toBeGreaterThanOrEqual(64)
        const speaker = frame.getByRole("button", { name: /^(Speaking as|Playing as) / })
        await expect(speaker).toBeVisible()
        const picture = speaker.locator("img, svg, [data-avatar]").first()
        await expect(picture).toBeVisible()
        expect((await picture.boundingBox())!.width).toBeGreaterThanOrEqual(14)
      }
      await shot(page, `half-frames-${width}-${theme}`)
      await expectLayout(page, test.info(), `half-frames-${width}-${theme}`, { scope: "[data-frame]" })
    })

test("a chat beside its preset editor, two preset editors side by side, and a horizontal split", async ({ page }) => {
  test.setTimeout(150_000)
  for (const theme of ["light", "dark"] as const) {
    await fresh(page, 1440, theme)
    await page.goto(`${server().url}/chats/${fixtures.chatA}`)
    await expect(said(page, "The tide is out")).toBeVisible()
    const tab = await openPanel(page, "Prompt preset")
    await expect(tab).toBeVisible()
    await page.getByRole("link", { name: "Open the preset in the large editor" }).click()
    // The editor opens in a tab beside the chat, which stays open.
    await expect(tabs(page)).toHaveCount(2)
    await expect(page.getByRole("tab", { name: "Harbour walk" })).toBeVisible()
    await page.getByRole("button", { name: "Tab and frame actions" }).click()
    await page.getByRole("menuitem", { name: "Move to a new frame on the right" }).click()
    await expect(page.locator("[data-frame]")).toHaveCount(2)
    await expect(said(page, "The tide is out")).toBeVisible()
    await shot(page, `chat-and-preset-1440-${theme}`)

    // Two presets side by side: the library's editors in two frames.
    await fresh(page, 1440, theme)
    await page.goto(`${server().url}/library/${fixtures.presetA}`)
    await expect(page.getByRole("button", { name: "Switch preset", exact: true })).toBeVisible()
    // The new frame shows the preset too; the library opens beside it there, then the other preset.
    await page.getByRole("button", { name: "Split right" }).click()
    await page.getByRole("navigation", { name: "Main", exact: true }).getByRole("link", { name: "Library" }).click()
    const library = page.locator("[data-frame]").nth(1)
    await library.getByRole("tab", { name: /^Presets/ }).click()
    await library.getByRole("link", { name: "Lighthouse preset", exact: true }).first().click()
    await expect(page.locator("[data-frame]")).toHaveCount(2)
    await expect(page.getByRole("button", { name: "Switch preset", exact: true })).toHaveCount(2)
    await shot(page, `two-presets-1440-${theme}`)
    if (process.env.LAYOUT_AUDIT) await expectLayout(page, test.info(), `two-presets-${theme}`)

    // A horizontal split: a chat above another.
    await fresh(page, 1440, theme)
    await page.goto(`${server().url}/chats/${fixtures.chatA}`)
    await expect(said(page, "The tide is out")).toBeVisible()
    await page.getByRole("button", { name: "Split down" }).click()
    await sidebarChat(page, "Lighthouse night").click()
    await expect(said(page, "The lamp turns")).toBeVisible()
    await expect(said(page, "The tide is out")).toBeVisible()
    await shot(page, `horizontal-split-1440-${theme}`)
  }
})

for (const width of [1024, 390])
  test(`one chat and two tabs at ${width}`, async ({ page }) => {
    test.setTimeout(120_000)
    for (const theme of ["light", "dark"] as const) {
      await fresh(page, width, theme)
      await page.goto(`${server().url}/chats/${fixtures.chatA}`)
      await expect(said(page, "The tide is out")).toBeVisible()
      await expect(strip(page)).toHaveCount(0)
      await shot(page, `single-chat-${width}-${theme}`)
      if (process.env.LAYOUT_AUDIT) await expectLayout(page, test.info(), `single-chat-${width}-${theme}`)
      await page.getByRole("textbox", { name: "Message" }).fill("Kept")
      // Typing kept the tab: the next chat opens beside it, and the URL's layout has it kept.
      if (width < 1024) await page.getByRole("button", { name: "Chats and menu" }).click()
      await page.getByRole("link", { name: /^Open chat Lighthouse night/ }).click()
      await expect(said(page, "The lamp turns")).toBeVisible()
      // Phones have no splits; the strip switches between the open tabs.
      await expect(page.getByRole("button", { name: "Split right" })).toHaveCount(width < 1024 ? 0 : 1)
      await expect(tabs(page)).toHaveCount(2)
      await expect.poll(() => storedLayout(page)).toContain(`"/chats/${fixtures.chatA}?`)
      await shot(page, `two-tabs-${width}-${theme}`)
      await page.getByRole("tab", { name: "Harbour walk" }).click()
      await expect(said(page, "The tide is out")).toBeVisible()
      await expect(said(page, "The lamp turns")).toHaveCount(0)
    }
  })

// VS Code's editor groups: Open beside and Alt-click open in a frame on the right, a chat can
// show in two frames, and a tab dragged to a frame's edge splits there.
test("open beside, one chat in two frames, and a tab dropped on an edge", async ({ page }) => {
  test.setTimeout(150_000)
  await fresh(page, 1440)
  await page.goto(`${server().url}/chats/${fixtures.chatA}`)
  await expect(said(page, "The tide is out")).toBeVisible()
  // A chat row's right-click menu: Open beside.
  await sidebarChat(page, "Lighthouse night").click({ button: "right" })
  await page
    .getByRole("menu", { name: "Actions for Lighthouse night" })
    .getByRole("menuitem", { name: "Open beside" })
    .click()
  const frames = page.locator("[data-frame]")
  await expect(frames).toHaveCount(2)
  await expect(frames.nth(1).getByText("The lamp turns")).toBeVisible()
  await expect(said(page, "The tide is out")).toBeVisible()

  // Alt-click from the right frame: a third frame, the first chat in two of them.
  await sidebarChat(page, "Harbour walk").click({ modifiers: ["Alt"] })
  await expect(frames).toHaveCount(3)
  await expect(said(page, "The tide is out")).toHaveCount(2)
  await shot(page, "open-beside-1440-light")

  // The third frame's tab, dropped on the first frame's bottom edge: a frame below it.
  const tab = frames.nth(2).locator("[data-tab] [role=tab]")
  const target = (await frames.first().boundingBox())!
  await tab.dragTo(frames.first(), { targetPosition: { x: target.width / 2, y: target.height - 30 } })
  await expect(frames).toHaveCount(3)
  const [top, below] = [(await frames.nth(0).boundingBox())!, (await frames.nth(1).boundingBox())!]
  expect(below.x).toBeCloseTo(top.x, 0)
  expect(below.y).toBeGreaterThan(top.y + top.height - 2)
  await expect(said(page, "The tide is out")).toHaveCount(2)
  await expect(said(page, "The lamp turns")).toBeVisible()
  if (process.env.LAYOUT_AUDIT) await expectLayout(page, test.info(), "three-frames")

  // The lower frame's tab menu: its moves (up, right) each show an arrow pointing that way.
  await frames.nth(1).locator("[data-tab] [role=tab]").first().click({ button: "right" })
  const menu = page.getByRole("menu", { name: /^Actions for / })
  const arrow = (name: string) =>
    menu
      .getByRole("menuitem", { name: new RegExp(`^${name}`) })
      .locator("svg.menu-mark path")
      .last()
  await expect(arrow("Move to the frame above")).toHaveAttribute("d", "M12 16V8")
  await expect(arrow("Move to the frame on the right")).toHaveAttribute("d", "m12 16 4-4-4-4")
  await expect(menu.getByRole("menuitem", { name: /^Move to the frame on the left/ })).toBeDisabled()
  await shot(page, "tab-menu-moves-1440-light")
  if (process.env.LAYOUT_AUDIT) await expectLayout(page, test.info(), "tab-menu-moves")
  await page.keyboard.press("Escape")
})

// A link in a frame opens in that frame (VS Code opens in the group clicked in): a frame showing
// the same item elsewhere keeps its place, scroll and focus (owner, 2026-11-06: a character
// tile in a Characters tab scrolled the chat in the other frame).
test("links open in their own frame, never another frame's tab of the item", async ({ page }) => {
  test.setTimeout(150_000)
  const frames = page.locator("[data-frame]")
  const [left, right] = [frames.nth(0), frames.nth(1)]
  await fresh(page, 1440)
  // Home in two frames; Mira's tile in the left opens her latest chat there.
  await page.goto(`${server().url}/`)
  await expect(page.getByRole("main").getByRole("link", { name: "Open Mira", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Split right" }).click()
  await expect(frames).toHaveCount(2)
  await left.getByRole("link", { name: "Open Mira", exact: true }).click()
  await expect(left.getByText("The tide is out")).toBeVisible()
  // Opening a character shows her chats in the sidebar, as before frames.
  await expectCharacterSidebar(page, "Mira", "Harbour walk", "Lighthouse night")
  await page.getByRole("complementary", { name: "Sidebar" }).getByRole("button", { name: "All chats" }).click()
  await expect(sidebarChat(page, "Lighthouse night")).toBeVisible()
  // The same tile in the right frame opens it there too: the left chat keeps its place.
  await right.getByRole("link", { name: "Open Mira", exact: true }).click()
  await expect(right.getByText("The tide is out")).toBeVisible()
  await expect(left.getByText("The tide is out")).toBeVisible()
  await expect(right).toHaveAttribute("data-focused", "")
  await expect(frames).toHaveCount(2)
  await expectCharacterSidebar(page, "Mira", "Harbour walk", "Lighthouse night")

  // A library entry the same way: the editor open on the left, its row clicked on the right.
  await fresh(page, 1440)
  await page.goto(`${server().url}/library?kind=preset`)
  const edit = (frame: typeof left) =>
    frame.getByRole("list", { name: "Presets" }).getByRole("link", { name: "Edit Harbour preset", exact: true })
  await expect(edit(page.locator("[data-frame]").first())).toBeVisible()
  await page.getByRole("button", { name: "Split right" }).click()
  await expect(frames).toHaveCount(2)
  await edit(left).click()
  await expect(left.getByRole("region", { name: "Preset editor", exact: true })).toBeVisible()
  await edit(right).click()
  await expect(right.getByRole("region", { name: "Preset editor", exact: true })).toBeVisible()
  await expect(left.getByRole("region", { name: "Preset editor", exact: true })).toBeVisible()
  await expect(right).toHaveAttribute("data-focused", "")
})

// A character tile has no Open beside button (owner, 2026-11-06: "Remove the 'open in a frame on
// the right' button... it's redundant with the context menu"); its right-click menu matches a
// chat row's, and Open beside is there.
test("a character tile opens beside from a chat row's menu, with no button for it", async ({ page }) => {
  test.setTimeout(120_000)
  await fresh(page, 1440)
  await page.goto(`${server().url}/`)
  const main = page.getByRole("main")
  const tile = main.getByRole("link", { name: "Open Wren", exact: true })
  await expect(tile).toBeVisible()
  await tile.hover()
  await expect(main.getByRole("button", { name: /beside/ })).toHaveCount(0)

  await tile.click({ button: "right" })
  const menu = page.getByRole("menu", { name: "Actions for Wren" })
  for (const item of ["Open", "Open beside", "Open in a new browser tab"])
    await expect(menu.getByRole("menuitem", { name: item, exact: true })).toBeVisible()
  if (process.env.LAYOUT_AUDIT) await expectLayout(page, test.info(), "tile-menu")
  await menu.getByRole("menuitem", { name: "Open beside", exact: true }).click()
  const frames = page.locator("[data-frame]")
  await expect(frames).toHaveCount(2)
  await expect(frames.nth(1).getByText("The lamp turns")).toBeVisible()
  // Beside, the character opens as a click opens her: the sidebar on her chats.
  await expectCharacterSidebar(page, "Wren", "Lighthouse night", "Harbour walk")

  // An Alt-click and the menu's Open do the same, from the Home tab on the left.
  const home = frames.nth(0)
  await home.getByRole("link", { name: "Open Mira", exact: true }).click({ modifiers: ["Alt"] })
  await expect(frames.nth(1).getByText("The tide is out")).toBeVisible()
  await expectCharacterSidebar(page, "Mira", "Harbour walk", "Lighthouse night")
  await home.getByRole("link", { name: "Open Wren", exact: true }).click({ button: "right" })
  await page
    .getByRole("menu", { name: "Actions for Wren" })
    .getByRole("menuitem", { name: "Open", exact: true })
    .click()
  await expect(home.getByText("The lamp turns")).toBeVisible()
  await expectCharacterSidebar(page, "Wren", "Lighthouse night", "Harbour walk")
})

// A tab's right-click menu (the frame's ⋯ has the same): pin, the Close variants, Reopen
// closed tab, maximize; and the dot of a tab with changes not yet saved.
test("tab menu: pin, close many, reopen, maximize, and the unsaved dot", async ({ page }) => {
  test.setTimeout(150_000)
  await fresh(page, 1440)
  await page.goto(`${server().url}/chats/${fixtures.chatA}`)
  await expect(said(page, "The tide is out")).toBeVisible()
  // The panel first: once two chats show, each header has its own panel toggle.
  await openPanel(page, "Prompt preset")
  await page.getByRole("button", { name: "Split right" }).click()
  await sidebarChat(page, "Lighthouse night").dblclick()
  const right = page.locator("[data-frame]").nth(1)
  await expect(right.locator("[data-tab]")).toHaveCount(2)
  await page.getByRole("tab", { name: "Prompt preset" }).click()
  await page.getByRole("link", { name: "Open the preset in the large editor" }).click()
  await expect(right.locator("[data-tab]")).toHaveCount(3)
  const tab = (name: string) => right.getByRole("tab", { name: new RegExp(`^${name}`) })

  // Pin the first chat's view in the right frame: it moves first and survives Close all.
  await tab("Harbour walk").click({ button: "right" })
  const menu = page.getByRole("menu", { name: "Actions for Harbour walk" })
  await menu.getByRole("menuitem", { name: "Pin tab" }).click()
  await expect(right.locator("[data-tab]").first()).toHaveAttribute("data-sticky", "")
  await expect(right.getByRole("button", { name: "Unpin Harbour walk" })).toBeVisible()

  // The editor's unsaved text shows as a dot in place of its close button (the chat's tab too:
  // its panel holds the same preset).
  const editor = page.getByRole("region", { name: "Preset editor", exact: true })
  await editor.getByRole("textbox", { name: "Prompt: Main Prompt", exact: true }).fill("Unsaved for the dot.")
  const editorTab = right.locator("[data-tab]").last()
  await expect(editorTab.locator("[data-unsaved-dot]")).toHaveCount(1)
  await expect(right.locator("[data-tab]").first().locator("[data-unsaved-dot]")).toHaveCount(0)
  await shot(page, "tab-unsaved-pinned-1440-light")

  // Close to the right, Reopen closed tab, then Close all, which keeps the pinned tab.
  await tab("Lighthouse night").click({ button: "right" })
  await page.getByRole("menuitem", { name: "Close tabs to the right" }).click()
  await expect(right.locator("[data-tab]")).toHaveCount(2)
  await right.getByRole("button", { name: "Tab and frame actions" }).click()
  await page.getByRole("menuitem", { name: "Reopen closed tab" }).click()
  await expect(right.locator("[data-tab]")).toHaveCount(3)
  await expect(page.getByRole("region", { name: "Preset editor", exact: true })).toBeVisible()
  await right.getByRole("button", { name: "Tab and frame actions" }).click()
  await page.getByRole("menuitem", { name: "Close all tabs" }).click()
  await expect(right.locator("[data-tab]")).toHaveCount(1)
  await expect(right.locator("[data-tab]").first()).toHaveAttribute("data-sticky", "")

  // Maximize shows the frame alone until restored.
  await right.getByRole("button", { name: "Maximize frame" }).click()
  await expect(page.locator("[data-frame]")).toHaveCount(1)
  await page.getByRole("button", { name: "Restore frames" }).click()
  await expect(page.locator("[data-frame]")).toHaveCount(2)
  if (process.env.LAYOUT_AUDIT) await expectLayout(page, test.info(), "tab-menu")
})

// The center column's frames and tabs (owner, 2026-11-05; DESIGN §10.1): one item looks as a
// single view did; single-click opens are preview tabs, a double click or an edit keeps them;
// splits show two chats, or a chat and an editor, side by side; the side panel follows the
// frame focused last; the layout survives a reload, per device; phones switch tabs from a strip.
// SCREENSHOT_DIR saves full-surface screenshots for the report.
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
import { openPanel } from "./support/panel.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

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
const sidebarChat = (page: Page, title: string) =>
  page.getByRole("complementary", { name: "Sidebar" }).getByRole("link", { name: new RegExp(`^Open chat ${title}`) })

/** The layout the server keeps for this page's browser (features/workbench/device.ts). */
const savedLayout = async (page: Page) => {
  const device = await page.evaluate(() => localStorage.getItem("rp.device"))
  return admin((api) => api.GetWorkbenchLayout({ device: device ?? "shared" }))
}

const fresh = async (page: Page, width: number, theme: "light" | "dark" = "light") => {
  await page.setViewportSize({ width, height: 900 })
  await page.emulateMedia({ colorScheme: theme })
  // Logging in starts the account's layouts over at one tab (support/rpc.ts forgetWorkbench).
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
  await expect(page.getByRole("textbox", { name: "Message" })).not.toHaveValue("Draft for the harbour")
  await page.getByRole("tab", { name: "Harbour walk" }).click()
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("Draft for the harbour")

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
  await page.getByRole("button", { name: "Split right" }).click()
  await expect(page.locator("[data-frame]")).toHaveCount(2)
  await expect(page.getByText("Open a chat, a card or an editor from the sidebar")).toBeVisible()
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
  await expect(page.locator("[data-frame]")).toHaveCount(1)
  await expect(tabs(page)).toHaveCount(2)
  await page.getByRole("button", { name: "Tab and frame actions" }).click()
  await page.getByRole("menuitem", { name: "Move to a new frame on the right" }).click()
  await expect(page.locator("[data-frame]")).toHaveCount(2)

  // A reload brings back the frames and their tabs.
  await expect.poll(() => savedLayout(page)).toContain('"type":"split"')
  await page.reload()
  await expect(page.locator("[data-frame]")).toHaveCount(2)
  await expect(said(page, "The lamp turns")).toBeVisible()
  await expect(said(page, "The tide is out")).toBeVisible()
})

// A phone and a desktop on one account keep their own layouts: neither's saves undo the other's.
test("each device restores its own layout", async ({ page, browser }) => {
  test.setTimeout(120_000)
  await fresh(page, 1440)
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 800 } })
  const phone = await phoneContext.newPage()
  await apiLogin(phone.request, server(), ADMIN.handle, ADMIN.password)
  try {
    await page.goto(`${server().url}/chats/${fixtures.chatA}`)
    await expect(said(page, "The tide is out")).toBeVisible()
    await page.getByRole("button", { name: "Split right" }).click()
    await sidebarChat(page, "Lighthouse night").click()
    await expect(page.locator("[data-frame]")).toHaveCount(2)
    await expect.poll(() => savedLayout(page)).toContain('"type":"split"')

    // The phone keeps the other chat, then opens Home beside it.
    await phone.goto(`${server().url}/chats/${fixtures.chatB}`)
    await expect(said(phone, "The lamp turns")).toBeVisible()
    const composer = phone.getByRole("textbox", { name: "Message" })
    await composer.fill("Kept")
    await expect.poll(() => savedLayout(phone)).toContain('"preview":false')
    await composer.fill("")
    await phone.goto(`${server().url}/`)
    await expect(tabs(phone)).toHaveCount(2)
    await expect.poll(() => savedLayout(phone)).not.toContain(fixtures.chatA)
    expect(await savedLayout(page)).toContain('"type":"split"')

    await page.reload()
    await expect(page.locator("[data-frame]")).toHaveCount(2)
    await expect(said(page, "The tide is out")).toBeVisible()
    await expect(said(page, "The lamp turns")).toBeVisible()
    await phone.reload()
    await expect(tabs(phone)).toHaveCount(2)
    await expect(tabs(phone).filter({ hasText: "Lighthouse night" })).toHaveCount(1)
    await expect(tabs(phone).filter({ hasText: "Harbour walk" })).toHaveCount(0)
  } finally {
    await phoneContext.close()
  }
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
    await expect(page.getByRole("combobox", { name: "Switch preset" })).toBeVisible()
    // The new frame waits for the next open: the library, then the other preset from it.
    await page.getByRole("button", { name: "Split right" }).click()
    await page.getByRole("navigation", { name: "Main", exact: true }).getByRole("link", { name: "Library" }).click()
    const library = page.locator("[data-frame]").nth(1)
    await library.getByRole("tab", { name: /^Presets/ }).click()
    await library.getByRole("link", { name: "Lighthouse preset", exact: true }).first().click()
    await expect(page.locator("[data-frame]")).toHaveCount(2)
    await expect(page.getByRole("combobox", { name: "Switch preset" })).toHaveCount(2)
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
      // Typing kept the tab; the saved layout has it before the page is left.
      await expect.poll(() => savedLayout(page)).toContain('"preview":false')
      await page.goto(`${server().url}/chats/${fixtures.chatB}`)
      await expect(said(page, "The lamp turns")).toBeVisible()
      // Phones have no splits; the strip switches between the open tabs.
      await expect(page.getByRole("button", { name: "Split right" })).toHaveCount(width < 1024 ? 0 : 1)
      await expect(tabs(page)).toHaveCount(2)
      await shot(page, `two-tabs-${width}-${theme}`)
      await page.getByRole("tab", { name: "Harbour walk" }).click()
      await expect(said(page, "The tide is out")).toBeVisible()
      await expect(said(page, "The lamp turns")).toHaveCount(0)
    }
  })

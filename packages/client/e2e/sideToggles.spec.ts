// The sidebar's Show button and the side panel's toggle in tab mode (owner, 2026-11-07; DESIGN
// §10.1): one view alone keeps them in its header; once the strips show, the header has neither,
// the hidden sidebar's Show sits at the start of the top-left strip and the panel's toggle at the
// end of the top-right strip, so hiding both bars with only non-chat tabs shown never strands the
// user. SCREENSHOT_DIR saves full-surface screenshots; LAYOUT_AUDIT audits the strips.
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, type Locator, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
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

let chatId: string

test.beforeAll(async () => {
  chatId = await admin((api) =>
    Effect.gen(function* () {
      const mira = yield* api.CreateCard({ label: "Mira", name: "Mira" })
      const made = yield* api.CreateChat({ title: "Harbour walk" })
      yield* api.ChangeCast({ chatId: made.id, slotId: null, change: { _tag: "Join", entityId: mira.entityId } })
      yield* api.SendMessage({
        chatId: made.id,
        parentSlotId: null,
        branch: false,
        content: "The tide is out; the boats lean on the mud.",
        reply: false
      })
      return made.id
    })
  )
})

const fresh = async (page: Page, theme: "light" | "dark") => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ colorScheme: theme })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chatId}`)
  await expect(page.locator("[data-frame]").getByText("The tide is out")).toBeVisible()
}

const sidebar = (page: Page) => page.getByRole("complementary", { name: "Sidebar" })
const chatPanel = (page: Page) => page.getByRole("complementary", { name: "Chat panel" })
const strips = (page: Page) => page.locator("[data-tab-strip]")
const headers = (page: Page) => page.locator("[data-frame] header")
const showSidebar = (page: Page) => page.getByRole("button", { name: "Show the sidebar", exact: true })
const panelToggle = (page: Page) =>
  page.getByRole("button", { name: "Chat panel", exact: true }).or(page.getByRole("button", { name: "Hide panel" }))
const hideSidebar = async (page: Page) => {
  await sidebar(page).getByRole("button", { name: "Hide the sidebar", exact: true }).click()
  await expect(sidebar(page)).toHaveCount(0)
}
/** Opens a page from the sidebar's menu as a tab of its own (a double click keeps it). */
const openKept = async (page: Page, label: string) => {
  const before = await page.locator("[data-tab]").count()
  await sidebar(page).getByRole("navigation", { name: "Main" }).getByRole("link", { name: label }).dblclick()
  await expect(page.locator("[data-tab]")).toHaveCount(Math.max(2, before + 1))
  await expect(page.locator("[data-tab]:not([data-preview])")).toHaveCount(Math.max(2, before + 1))
}

for (const theme of ["light", "dark"] as const) {
  test(`one view keeps both buttons in its header (${theme})`, async ({ page }) => {
    await fresh(page, theme)
    await expect(strips(page)).toHaveCount(0)
    await hideSidebar(page)
    const header = headers(page)
    await expect(header.getByRole("button", { name: "Show the sidebar", exact: true })).toBeFocused()
    await expect(header.getByRole("button", { name: "Chat panel", exact: true })).toBeVisible()
    await shot(page, `single-pane-1440-${theme}`)
    await header.getByRole("button", { name: "Chat panel", exact: true }).click()
    await expect(chatPanel(page)).toBeVisible()
    await header.getByRole("button", { name: "Hide panel" }).click()
    await expect(chatPanel(page)).toHaveCount(0)
    await header.getByRole("button", { name: "Show the sidebar", exact: true }).click()
    await expect(sidebar(page)).toBeVisible()
  })

  test(`in tab mode both bars come back from the strips, with only other tabs shown (${theme})`, async ({ page }) => {
    test.setTimeout(120_000)
    await fresh(page, theme)
    // The chat kept, then two pages beside it: the strip shows, the chat behind them.
    await sidebar(page)
      .getByRole("link", { name: /^Open chat Harbour walk/ })
      .dblclick()
    await openKept(page, "Library")
    await openKept(page, "Bin")
    await expect(strips(page)).toHaveCount(1)
    // The headers have neither button now; the strip has the panel's toggle at its end.
    await hideSidebar(page)
    const strip = strips(page)
    const show = strip.getByRole("button", { name: "Show the sidebar", exact: true })
    await expect(show).toBeFocused()
    await expect(headers(page).getByRole("button", { name: "Show the sidebar", exact: true })).toHaveCount(0)
    await expect(showSidebar(page)).toHaveCount(1)
    await expect(panelToggle(page)).toHaveCount(1)
    const toggle = strip.getByRole("button", { name: "Chat panel", exact: true })
    await expect(toggle).toBeVisible()
    // The first tab moved right to make room for Show; the toggle is the strip's last button.
    const showBox = (await show.boundingBox())!
    const firstTab = (await strip.locator("[data-tab]").first().boundingBox())!
    expect(firstTab.x).toBeGreaterThanOrEqual(showBox.x + showBox.width)
    const menuBox = (await strip.getByRole("button", { name: "Tab and frame actions" }).boundingBox())!
    expect((await toggle.boundingBox())!.x).toBeGreaterThan(menuBox.x)
    // The explanations as in the header.
    await toggle.hover()
    await expect(
      page.getByText("Click to open the chat panel: cast, settings, lorebooks, notes and summaries")
    ).toBeVisible()
    await show.hover()
    await expect(page.getByText("Click to show the sidebar: your chats, characters and the menu")).toBeVisible()
    await shot(page, `tab-mode-both-hidden-1440-${theme}`)
    if (process.env.LAYOUT_AUDIT) await expectLayout(page, test.info(), `tab-mode-both-hidden-${theme}`)

    // The panel opens and hides from the strip while the Bin is shown.
    await toggle.click()
    await expect(chatPanel(page)).toBeVisible()
    await expect(strip.getByRole("button", { name: "Hide panel" })).toHaveAttribute("aria-pressed", "true")
    await shot(page, `tab-mode-panel-open-1440-${theme}`)
    if (process.env.LAYOUT_AUDIT) await expectLayout(page, test.info(), `tab-mode-panel-open-${theme}`)
    await strip.getByRole("button", { name: "Hide panel" }).click()
    await expect(chatPanel(page)).toHaveCount(0)

    // The sidebar comes back from the strip, and the strip starts with the first tab again.
    await show.click()
    await expect(sidebar(page)).toBeVisible()
    await expect(showSidebar(page)).toHaveCount(0)
    const history = (await strip.locator("[data-strip-history]").boundingBox())!
    expect(Math.round((await strip.locator("[data-tab]").first().boundingBox())!.x)).toBe(
      Math.round(history.x + history.width)
    )

    // No chat open at all: the toggle goes (nothing to show), Show stays in the strip.
    await page.getByRole("button", { name: "Close Harbour walk" }).click()
    await expect(page.getByRole("tab", { name: "Harbour walk" })).toHaveCount(0)
    await hideSidebar(page)
    await expect(panelToggle(page)).toHaveCount(0)
    await strip.getByRole("button", { name: "Show the sidebar", exact: true }).click()
    await expect(sidebar(page)).toBeVisible()
  })

  test(`a split puts them on the top-left and top-right strips (${theme})`, async ({ page }) => {
    test.setTimeout(120_000)
    await fresh(page, theme)
    // Left | (top right over bottom right), each a view of the chat.
    await page.getByRole("button", { name: "Split right" }).click()
    await expect(page.locator("[data-frame]")).toHaveCount(2)
    await page.locator("[data-frame]").nth(1).getByRole("button", { name: "Tab and frame actions" }).click()
    await page.getByRole("menuitem", { name: "Split down" }).click()
    await expect(page.locator("[data-frame]")).toHaveCount(3)
    await hideSidebar(page)
    const [left, topRight, bottomRight] = [0, 1, 2].map((i) => page.locator("[data-frame]").nth(i))
    await expect(headers(page).getByRole("button", { name: "Show the sidebar", exact: true })).toHaveCount(0)
    await expect(headers(page).getByRole("button", { name: "Chat panel", exact: true })).toHaveCount(0)
    await expect(left!.locator("[data-tab-strip]").getByRole("button", { name: "Show the sidebar" })).toBeVisible()
    await expect(showSidebar(page)).toHaveCount(1)
    const toggle = topRight!.locator("[data-tab-strip]").getByRole("button", { name: "Chat panel", exact: true })
    await expect(toggle).toBeVisible()
    await expect(panelToggle(page)).toHaveCount(1)
    await expect(bottomRight!.locator("[data-tab-strip]")).toBeVisible()
    await shot(page, `split-1440-${theme}`)
    if (process.env.LAYOUT_AUDIT) await expectLayout(page, test.info(), `split-${theme}`)
    await toggle.click()
    await expect(chatPanel(page)).toBeVisible()
    // A maximized frame shows alone and carries both.
    await bottomRight!.getByRole("button", { name: "Maximize frame" }).click()
    await expect(page.locator("[data-frame]")).toHaveCount(1)
    const only = page.locator("[data-tab-strip]")
    await expect(only.getByRole("button", { name: "Show the sidebar", exact: true })).toBeVisible()
    await expect(only.getByRole("button", { name: "Hide panel" })).toBeVisible()
    await only.getByRole("button", { name: "Show the sidebar", exact: true }).click()
    await expect(sidebar(page)).toBeVisible()
  })

  // With four frames and both bars open, an overflowed top-right strip used to put its
  // toggle under the panel. Narrowing the workbench keeps the strip controls inside their frame.
  test(`narrow split frames keep the frame menu and the panel's toggle inside the frame (${theme})`, async ({
    page
  }) => {
    test.setTimeout(180_000)
    await fresh(page, theme)
    await page.getByRole("button", { name: "Split right", exact: true }).click()
    await hideSidebar(page)
    await page.setViewportSize({ width: 1920, height: 900 })
    // Each split needs room for two 344 px frames. Split the two original halves first.
    const frames = page.locator("[data-frame]")
    for (const frame of [frames.first(), frames.last()]) {
      await frame.getByRole("button", { name: "Tab and frame actions" }).click()
      const split = page.getByRole("menuitem", { name: "Split right", exact: true })
      await expect(split).toBeEnabled()
      await split.click()
    }
    await expect(frames).toHaveCount(4)
    await page.setViewportSize({ width: 1024, height: 900 })
    await panelToggle(page).click()
    await expect(chatPanel(page)).toBeVisible()
    await panelToggle(page).click()
    await expect(chatPanel(page)).toHaveCount(0)
    await showSidebar(page).click()
    await expect(sidebar(page)).toBeVisible()
    await panelToggle(page).click()
    await expect(chatPanel(page)).toBeVisible()
    // Both bars open: the last frame is narrow, its tab strip holds the ⋯ menu and the toggle.
    const last = page.locator("[data-frame]").last()
    const strip = last.locator("[data-tab-strip]")
    const menu = strip.getByRole("button", { name: "Tab and frame actions" })
    const toggle = strip.getByRole("button", { name: "Hide panel" })
    for (const control of [menu, toggle]) await expectInside(control, last)
    await expectInside(strip.getByRole("button", { name: "Maximize frame" }), last)
    await menu.click()
    await expect(page.getByRole("menuitem", { name: "Maximize frame" })).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(page.getByRole("menuitem", { name: "Maximize frame" })).toHaveCount(0)
    await shot(page, `narrow-splits-both-bars-1024-${theme}`)
    if (process.env.LAYOUT_AUDIT)
      await expectLayout(page, test.info(), `narrow-splits-strips-1024-${theme}`, { scope: "[data-tab-strip]" })
    // The close click while both bars are open reaches the toggle, not the panel over it.
    await toggle.click({ timeout: 5000 })
    await expect(chatPanel(page)).toHaveCount(0)
    // The phone's strip, then the wide split again.
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(strips(page)).toHaveCount(1)
    await shot(page, `split-strip-390-${theme}`)
    if (process.env.LAYOUT_AUDIT)
      await expectLayout(page, test.info(), `split-strip-390-${theme}`, { scope: "[data-tab-strip]" })
    await page.setViewportSize({ width: 1440, height: 900 })
    await expect(page.locator("[data-frame]")).toHaveCount(4)
    // The frames keep the widths they had (dividers stay put); each strip's ⋯ is in its frame.
    for (const frame of await page.locator("[data-frame]").all())
      await expectInside(frame.getByRole("button", { name: "Tab and frame actions" }), frame)
    await expect(page.locator("[data-frame]").last().getByRole("button", { name: "Maximize frame" })).toBeVisible()
    await shot(page, `four-frames-1440-${theme}`)
    if (process.env.LAYOUT_AUDIT)
      await expectLayout(page, test.info(), `four-frames-strips-1440-${theme}`, { scope: "[data-tab-strip]" })
  })
}

/** Wholly inside its frame, and what a click at its middle reaches. */
const expectInside = async (control: Locator, frame: Locator) => {
  await expect(control).toBeVisible()
  const box = (await control.boundingBox())!
  const outer = (await frame.boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(outer.x - 0.5)
  expect(box.x + box.width).toBeLessThanOrEqual(outer.x + outer.width + 0.5)
  const reached = await control.evaluate((el) => {
    const r = el.getBoundingClientRect()
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
    return top !== null && el.contains(top)
  })
  expect(reached).toBe(true)
}

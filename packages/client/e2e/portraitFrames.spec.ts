// Portraits in the workbench (owner, 2026-11-07: "Opening portraits is broken now with the tabs
// and frames"): a portrait opened from any frame shows in the portrait column, a column of its
// own left of the frames, as it was left of the chat before frames (DESIGN §10.1, owner
// 2026-11-05: "the image-viewer would also open in its own extra column"). It never covers a
// frame, and closing it gives the frames their widths back. From a message, the Cast and the
// card's header portrait; one frame and two; each frame; 1440 and 390, light and dark.
// SCREENSHOT_DIR saves full-surface screenshots.
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, type Locator, type Page, test } from "@playwright/test"
import { addToCast } from "./support/cast.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { openPanel, panelTab } from "./support/panel.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { SHAPES, shapeCard } from "./support/shapes.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "200", FAKE_GENERATOR_TOKENS: "20" })
test.setTimeout(240_000)

const shots = process.env.SCREENSHOT_DIR
const shot = async (page: Page, name: string) => {
  if (!shots) return
  mkdirSync(shots, { recursive: true })
  await page.mouse.move(0, 0)
  await page.screenshot({ path: join(shots, `${name}.png`) })
}

const [TALL, STANDARD] = [SHAPES[0]!, SHAPES[1]!]

let chatUrl: Promise<string> | null = null
/** A chat with Tall (greeting and reply on screen) and Standard in its cast. */
const openChat = async (page: Page, width: number, theme: "light" | "dark") => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ colorScheme: theme })
  // Logging in starts the account's layouts over at one tab.
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const url = await (chatUrl ??= (async () => {
    for (const [index, shape] of [TALL, STANDARD].entries()) {
      const response = await page.request.post(`${server().url}/library/import?name=${shape.name}.png`, {
        data: shapeCard(shape, index * 40),
        headers: { origin: server().url, "content-type": "application/octet-stream" }
      })
      expect(response.ok()).toBeTruthy()
    }
    await page.goto(`${server().url}/library`)
    await page.getByRole("link", { name: `Start a chat with ${TALL.name}` }).click()
    await page.getByLabel("Message", { exact: true }).fill("Hello there.")
    await page.getByRole("button", { name: "Send", exact: true }).click()
    await expect(page).toHaveURL(/\/chats\//)
    await expect(page.locator("article[data-slot]")).toHaveCount(3)
    await expect(page.getByText("generating", { exact: true })).toHaveCount(0)
    const cast = await openPanel(page, "Cast")
    await addToCast(page, STANDARD.name)
    await expect(cast.getByRole("button", { name: `View ${STANDARD.name}'s portrait` })).toBeVisible()
    await page.getByRole("button", { name: "Hide panel" }).click()
    return new URL(page.url()).pathname
  })())
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.setViewportSize({ width, height: width < 1024 ? 844 : 900 })
  await page.goto(`${server().url}${url}`)
  await expect(page.locator("[data-frame] article[data-slot]").first()).toBeVisible()
}

const frames = (page: Page) => page.locator("[data-frame]")
const column = (page: Page) => page.locator("[data-portrait-column]")
const viewer = (page: Page, name: string) =>
  page.getByRole("complementary", { name: `${name}'s portrait`, exact: true })

/** Each frame's box, to compare after the column closes. */
const frameBoxes = async (page: Page) =>
  Promise.all((await frames(page).all()).map(async (frame) => (await frame.boundingBox())!))

/**
 * The column is on screen left of every frame, covering none: each frame keeps room, and the
 * image's middle and each frame's middle are what's drawn there.
 */
const expectBesideFrames = async (page: Page, name: string) => {
  await expect(viewer(page, name)).toBeVisible()
  await expect(column(page)).toHaveCount(1)
  const image = page.getByRole("img", { name: `${name}'s full portrait` })
  await expect
    .poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
    .toBeGreaterThan(0)
  const col = (await column(page).boundingBox())!
  expect(col.width).toBeGreaterThanOrEqual(199)
  for (const frame of await frames(page).all()) {
    const box = (await frame.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(col.x + col.width - 1)
    expect(box.width).toBeGreaterThan(150)
    // Nothing of the column is drawn over the frame.
    const over = await page.evaluate(
      ({ x, y }) => !!document.elementFromPoint(x, y)?.closest("[data-portrait-column]"),
      { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    )
    expect(over).toBe(false)
  }
  const shown = (await image.boundingBox())!
  const inColumn = await page.evaluate(
    ({ x, y }) => !!document.elementFromPoint(x, y)?.closest("[data-portrait-column]"),
    { x: shown.x + shown.width / 2, y: shown.y + shown.height / 2 }
  )
  expect(inColumn).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
}

/** Closed by its own button: no column, and the frames as they were. */
const closeAndExpectRestored = async (
  page: Page,
  name: string,
  before: ReadonlyArray<{ x: number; width: number }>
) => {
  await viewer(page, name).getByRole("button", { name: "Close the portrait", exact: true }).click()
  await expect(column(page)).toHaveCount(0)
  await expect
    .poll(async () => (await frameBoxes(page)).map((box) => [Math.round(box.x), Math.round(box.width)]))
    .toEqual(before.map((box) => [Math.round(box.x), Math.round(box.width)]))
}

/** Focuses a frame with a click on its message text, as a reader would. */
const focusFrame = async (frame: Locator) => {
  await frame.locator("article[data-slot] .prose, article[data-slot] p").first().click()
}

/** From a message's portrait, a Cast row and the card tab's header portrait, in this frame. */
const openFromEverySource = async (page: Page, frame: Locator, label: string, audit: boolean) => {
  // A message's portrait.
  let before = await frameBoxes(page)
  await frame
    .locator("article[data-slot]")
    .getByRole("button", { name: `View ${TALL.name}'s portrait` })
    .first()
    .click()
  await expectBesideFrames(page, TALL.name)
  await shot(page, `${label}-message`)
  if (audit) await expectLayout(page, test.info(), `${label}-viewer`, { scope: "[data-portrait-column]" })
  await closeAndExpectRestored(page, TALL.name, before)

  // A Cast row, in the panel beside the frames for this frame's chat.
  await focusFrame(frame)
  const icons = frame.getByRole("group", { name: "Chat panel" })
  if (await icons.isVisible()) await icons.getByRole("button", { name: "Cast", exact: true }).click()
  // Split, the panel's toggle is on the top-right strip.
  else await page.getByRole("button", { name: "Chat panel", exact: true }).click()
  await panelTab(page, "Cast")
  const cast = page.getByRole("tabpanel", { name: "Cast", exact: true })
  before = await frameBoxes(page)
  await cast.getByRole("button", { name: `View ${STANDARD.name}'s portrait`, exact: true }).click()
  await expectBesideFrames(page, STANDARD.name)
  await shot(page, `${label}-cast`)
  await closeAndExpectRestored(page, STANDARD.name, before)

  // The header's face opens the card's tab (a narrow frame's header leaves the faces out: the
  // panel's cast strip); the card's header portrait opens the picture.
  const face = frame
    .locator("header")
    .getByRole("button", { name: `Show ${TALL.name}'s card`, exact: true })
    .first()
  if (await face.isVisible()) await face.click()
  else await panelTab(page, TALL.name)
  const card = page.getByRole("tabpanel", { name: TALL.name, exact: true })
  before = await frameBoxes(page)
  await card.getByRole("button", { name: `View ${TALL.name}'s picture`, exact: true }).click()
  await expectBesideFrames(page, TALL.name)
  await shot(page, `${label}-header`)
  await closeAndExpectRestored(page, TALL.name, before)
  await page.getByRole("button", { name: "Hide panel", exact: true }).click()
  await expect(page.getByRole("tablist", { name: "Chat panel" })).toHaveCount(0)
}

for (const theme of ["light", "dark"] as const) {
  test(`portraits open in their column beside one frame and beside two at 1440 ${theme}`, async ({ page }) => {
    await openChat(page, 1440, theme)
    await expect(frames(page)).toHaveCount(1)
    await openFromEverySource(page, frames(page).first(), `one-frame-1440-${theme}`, true)

    // Two frames on the same chat, as the owner had them: from each frame in turn.
    await page.getByRole("button", { name: "Split right" }).click()
    await expect(frames(page)).toHaveCount(2)
    for (const index of [0, 1]) {
      const frame = frames(page).nth(index)
      await expect(frame.locator("article[data-slot]").first()).toBeVisible()
      await openFromEverySource(page, frame, `two-frames-${index}-1440-${theme}`, index === 1)
    }

    // A portrait open in one frame's chat stays in the column while the other frame is focused.
    const before = await frameBoxes(page)
    await frames(page)
      .nth(1)
      .locator("article[data-slot]")
      .getByRole("button", { name: `View ${TALL.name}'s portrait` })
      .first()
      .click()
    await expectBesideFrames(page, TALL.name)
    await focusFrame(frames(page).first())
    await expectBesideFrames(page, TALL.name)
    await closeAndExpectRestored(page, TALL.name, before)
  })

  test(`portraits open full-screen at 390 ${theme}, with one frame and with two`, async ({ page }) => {
    await openChat(page, 390, theme)
    const open = async (label: string) => {
      const dialog = page.getByRole("dialog", { name: TALL.name, exact: true })
      await page
        .locator("[data-frame] article[data-slot]")
        .getByRole("button", { name: `View ${TALL.name}'s portrait` })
        .first()
        .click()
      await expect(dialog).toBeVisible()
      await expect(column(page)).toHaveCount(0)
      const box = (await dialog.boundingBox())!
      expect(box.x).toBeLessThanOrEqual(1)
      expect(box.width).toBeGreaterThanOrEqual(388)
      await shot(page, label)
      await expectLayout(page, test.info(), label, { scope: '[role="dialog"]' })
      await dialog.getByRole("button", { name: /^Close( the portrait)?$/ }).click()
      await expect(dialog).toHaveCount(0)
    }
    await open(`one-frame-390-${theme}-message`)
    // The Cast and the card's header portrait, from the panel's sheet.
    const cast = await openPanel(page, "Cast")
    await cast.getByRole("button", { name: `View ${STANDARD.name}'s portrait`, exact: true }).click()
    const standard = page.getByRole("dialog", { name: STANDARD.name, exact: true })
    await expect(standard).toBeVisible()
    await standard.getByRole("button", { name: /^Close( the portrait)?$/ }).click()
    await expect(standard).toHaveCount(0)
    await page.getByRole("tab", { name: TALL.name, exact: true }).click()
    await page
      .getByRole("tabpanel", { name: TALL.name, exact: true })
      .getByRole("button", { name: `View ${TALL.name}'s picture`, exact: true })
      .click()
    const tall = page.getByRole("dialog", { name: TALL.name, exact: true })
    await expect(tall).toBeVisible()
    await tall.getByRole("button", { name: /^Close( the portrait)?$/ }).click()
    await expect(tall).toHaveCount(0)
    await page.getByRole("button", { name: "Close", exact: true }).click()

    // Two frames made on a wide screen: a phone shows the focused one, and each opens full-screen.
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.getByRole("button", { name: "Split right" }).click()
    await expect(frames(page)).toHaveCount(2)
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(frames(page)).toHaveCount(1)
    await open(`two-frames-390-${theme}-focused`)
    const tabs = page.locator("[data-tab] [role=tab]")
    await expect(tabs).toHaveCount(2)
    await tabs.first().click()
    await open(`two-frames-390-${theme}-other`)
  })
}

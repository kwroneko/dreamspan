// Pictures as tabs (owner, 2026-11-07: "it should be possible to drag the image viewers into
// frames, as tabs, but they should still open in their column by default"): a viewer's header
// dragged onto a frame's strip or onto one of its edges opens the picture there as a tab, and
// the ⋯ menu's Open as a tab does the same; the tab moves, closes and comes back after a reload
// like any other. A portrait click still opens the column. SCREENSHOT_DIR saves screenshots.
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, type Locator, type Page, test } from "@playwright/test"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { SHAPES, shapeCard } from "./support/shapes.ts"
import { storedLayout } from "./support/workbench.ts"
import { expectLayout } from "./support/layoutAudit.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "200", FAKE_GENERATOR_TOKENS: "20" })
test.setTimeout(180_000)

const shots = process.env.SCREENSHOT_DIR
const shot = async (page: Page, name: string) => {
  if (!shots) return
  mkdirSync(shots, { recursive: true })
  await page.mouse.move(0, 0)
  await page.screenshot({ path: join(shots, `${name}.png`) })
}

const TALL = SHAPES[0]!

let chatUrl: Promise<string> | null = null
const openChat = async (page: Page, theme: "light" | "dark") => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ colorScheme: theme })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const url = await (chatUrl ??= (async () => {
    const response = await page.request.post(`${server().url}/library/import?name=${TALL.name}.png`, {
      data: shapeCard(TALL, 0),
      headers: { origin: server().url, "content-type": "application/octet-stream" }
    })
    expect(response.ok()).toBeTruthy()
    await page.goto(`${server().url}/library`)
    await page.getByRole("link", { name: `Start a chat with ${TALL.name}` }).click()
    await page.getByLabel("Message", { exact: true }).fill("Hello there.")
    await page.getByRole("button", { name: "Send", exact: true }).click()
    await expect(page).toHaveURL(/\/chats\//)
    await expect(page.locator("article[data-slot]")).toHaveCount(3)
    await expect(page.getByText("generating", { exact: true })).toHaveCount(0)
    return new URL(page.url()).pathname
  })())
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}${url}`)
  await expect(page.locator("[data-frame] article[data-slot]").first()).toBeVisible()
}

const frames = (page: Page) => page.locator("[data-frame]")
const column = (page: Page) => page.locator("[data-portrait-column]")
const pictureTab = (scope: Locator | Page) => scope.getByRole("tab", { name: TALL.name, exact: true })
const picture = (scope: Locator | Page) => scope.getByRole("region", { name: `${TALL.name}'s picture`, exact: true })

/** Opens Tall's portrait from the first message portrait in a frame: the column, by default. */
const openInColumn = async (page: Page, frame: Locator) => {
  await frame
    .locator("article[data-slot]")
    .getByRole("button", { name: `View ${TALL.name}'s portrait` })
    .first()
    .click()
  await expect(page.getByRole("complementary", { name: `${TALL.name}'s portrait`, exact: true })).toBeVisible()
  await expect(frames(page).locator("[data-portrait-column]")).toHaveCount(0)
}

/** Drags the viewer by its header (its name) to a point, checking the shaded drop target on the way. */
const dragHeaderTo = async (page: Page, x: number, y: number) => {
  const title = column(page).getByRole("heading", { name: TALL.name, exact: true })
  const from = (await title.boundingBox())!
  await page.mouse.move(from.x + 4, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(x, y, { steps: 12 })
  await expect(page.locator("[data-viewer-drop-zone]")).toBeVisible()
  await page.mouse.up()
  await expect(page.locator("[data-viewer-drop-zone]")).toHaveCount(0)
}

/** The picture fills its frame's body, image loaded, the column closed. */
const expectPictureIn = async (page: Page, frame: Locator) => {
  await expect(column(page)).toHaveCount(0)
  await expect(picture(frame)).toBeVisible()
  const image = picture(frame).getByRole("img", { name: `${TALL.name}'s full portrait` })
  await expect
    .poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
    .toBeGreaterThan(0)
  const shown = (await image.boundingBox())!
  const box = (await frame.boundingBox())!
  expect(shown.x).toBeGreaterThanOrEqual(box.x - 1)
  expect(shown.x + shown.width).toBeLessThanOrEqual(box.x + box.width + 1)
}

for (const theme of ["light", "dark"] as const) {
  test(`a strip drop keeps its position after tabs following the active chat at 1440 ${theme}`, async ({ page }) => {
    await openChat(page, theme)
    // Reloaded chats start as previews; editing keeps this one beside the Library tab.
    await page.getByLabel("Message", { exact: true }).fill("Keep this chat open")
    await page.getByLabel("Message", { exact: true }).fill("")
    await page.getByRole("navigation", { name: "Main", exact: true }).getByRole("link", { name: "Library" }).click()
    const frame = frames(page).first()
    await expect(frame.locator("[data-tab]")).toHaveCount(2)
    await frame.locator("[data-tab] [role=tab]").first().click()
    await openInColumn(page, frame)
    const original = await frame
      .locator("[data-tab]")
      .evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute("data-tab")))
    const strip = (await frame.locator("[data-tab-strip]").boundingBox())!
    await dragHeaderTo(page, strip.x + strip.width - 40, strip.y + strip.height / 2)
    await expectPictureIn(page, frame)
    await expect(frame.locator("[data-tab]")).toHaveCount(3)
    expect(
      await frame
        .locator("[data-tab]")
        .evaluateAll((tabs) => tabs.slice(0, 2).map((tab) => tab.getAttribute("data-tab")))
    ).toEqual(original)
    await expect(frame.locator("[data-tab] [role=tab]").last()).toHaveAccessibleName(TALL.name)
    await shot(page, `picture-tab-strip-position-${theme}`)
  })

  test(`a picture dragged into a frame's strip is a tab: moved by its menu, kept after reload, closed at 1440 ${theme}`, async ({
    page
  }) => {
    await openChat(page, theme)
    await page.getByRole("button", { name: "Split right" }).click()
    await expect(frames(page)).toHaveCount(2)
    const [left, right] = [frames(page).nth(0), frames(page).nth(1)]
    await openInColumn(page, left)

    // Onto the right frame's strip, after its tab.
    const strip = (await right.locator("[data-tab-strip]").boundingBox())!
    await dragHeaderTo(page, strip.x + strip.width - 40, strip.y + strip.height / 2)
    await expect(pictureTab(right)).toBeVisible()
    await expect(right.locator("[data-tab]")).toHaveCount(2)
    await expectPictureIn(page, right)
    await shot(page, `picture-tab-strip-${theme}`)

    // The tab's right-click menu moves it, as any tab's does.
    await pictureTab(right).click({ button: "right" })
    await page.getByRole("menuitem", { name: "Move to the frame on the left" }).click()
    await expect(pictureTab(left)).toBeVisible()
    await expect(pictureTab(right)).toHaveCount(0)
    await expectPictureIn(page, left)

    // Restored after a reload, where it was.
    await expect.poll(async () => (await storedLayout(page)) ?? "").toContain("/picture?")
    await page.reload()
    await expect(frames(page)).toHaveCount(2)
    await expect(pictureTab(frames(page).nth(0))).toBeVisible()
    await expectPictureIn(page, frames(page).nth(0))

    // A picture tab made on desktop remains reachable when this browser narrows to a phone.
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(frames(page)).toHaveCount(1)
    await expectPictureIn(page, frames(page).first())
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await shot(page, `picture-tab-phone-${theme}`)
    await page.setViewportSize({ width: 1440, height: 900 })
    await expect(frames(page)).toHaveCount(2)

    // Closed by its tab's ×: the frame shows its chat again.
    await frames(page)
      .nth(0)
      .getByRole("button", { name: `Close ${TALL.name}`, exact: true })
      .click()
    await expect(picture(page)).toHaveCount(0)
    await expect(frames(page).nth(0).locator("article[data-slot]").first()).toBeVisible()
  })

  test(`a picture dropped on a frame's edge splits; Open as a tab; clicks still open the column at 1440 ${theme}`, async ({
    page
  }) => {
    await openChat(page, theme)
    await expect(frames(page)).toHaveCount(1)
    await openInColumn(page, frames(page).first())

    // The header explains the drag.
    await column(page).getByRole("heading", { name: TALL.name, exact: true }).hover()
    await expect(page.locator('[data-layout-overlay="Tooltip floats above the page"]')).toContainText(
      "onto a frame to open it there as a tab"
    )

    // Onto the frame's right edge: a new frame on the right with the picture.
    const body = (await frames(page).first().locator("[data-frame-body]").boundingBox())!
    await dragHeaderTo(page, body.x + body.width - 30, body.y + body.height / 2)
    await expect(frames(page)).toHaveCount(2)
    await expectPictureIn(page, frames(page).nth(1))
    await shot(page, `picture-tab-split-${theme}`)

    // Its own close button closes the tab, and the frame it emptied.
    await picture(page).getByRole("button", { name: "Close the picture", exact: true }).click()
    await expect(frames(page)).toHaveCount(1)
    await expect(picture(page)).toHaveCount(0)

    // From the viewer's ⋯ menu, explained on hover: a tab beside the chat in its frame.
    await openInColumn(page, frames(page).first())
    await column(page).getByRole("button", { name: "Viewer options", exact: true }).click()
    const item = page.getByRole("menuitem", { name: "Open as a tab", exact: true })
    await expect(item).toHaveAccessibleDescription(/^Open this image as a tab/)
    await shot(page, `picture-tab-menu-${theme}`)
    await item.click()
    await expect(pictureTab(frames(page).first())).toBeVisible()
    await expectPictureIn(page, frames(page).first())

    // A portrait click still opens the column, beside the picture's tab.
    await frames(page).first().locator("[data-tab] [role=tab]").first().click()
    await openInColumn(page, frames(page).first())
    await expect(pictureTab(frames(page).first())).toBeVisible()
  })
}

// A message's attached image is a picture like a portrait (owner, 2026-11-07): its context menu
// opens it as a tab, whose URL names its media and name, so a reload brings it back.
const ATTACHMENT = "lighthouse.png"
const messageImage = (scope: Locator | Page) =>
  scope.locator("article[data-slot]").getByRole("button", { name: "View image 1", exact: true }).first()

const withAttachment = async (page: Page) => {
  if ((await messageImage(page).count()) > 0) return
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement("canvas")
    canvas.width = 240
    canvas.height = 360
    const ctx = canvas.getContext("2d")!
    ctx.fillStyle = "#e9e4d8"
    ctx.fillRect(0, 0, 240, 360)
    ctx.fillStyle = "#8a3b2e"
    ctx.fillRect(95, 80, 50, 240)
    ctx.fillStyle = "#f2c14e"
    ctx.fillRect(85, 50, 70, 30)
    return canvas.toDataURL("image/png").split(",")[1]!
  })
  // Attaching waits for the chat to load; the message's text replaces any draft left before.
  await expect(page.getByRole("button", { name: "Attach images", exact: true })).toBeEnabled()
  // An image an earlier test left attached (a file dropped from outside) goes first.
  const left = page.getByRole("list", { name: "Attached images" }).getByRole("button", { name: /^Remove / })
  for (let count = await left.count(); count > 0; count--) {
    await left.first().click()
    await expect(left).toHaveCount(count - 1)
  }
  await page.getByLabel("Message", { exact: true }).fill("A lighthouse sketch.")
  await page
    .getByLabel("Choose images")
    .setInputFiles({ name: ATTACHMENT, mimeType: "image/png", buffer: Buffer.from(base64, "base64") })
  await expect(page.getByRole("list", { name: "Attached images" }).getByRole("img")).toHaveCount(1)
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled()
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(messageImage(page)).toBeVisible()
  await expect
    .poll(() =>
      messageImage(page)
        .locator("img")
        .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)
    )
    .toBeGreaterThan(0)
  await expect(page.getByText("generating", { exact: true })).toHaveCount(0)
}

for (const theme of ["light", "dark"] as const)
  test(`a message's attached image opens as a tab from its context menu and its tab survives a reload ${theme}`, async ({
    page
  }, info) => {
    await openChat(page, theme)
    await withAttachment(page)
    const frame = frames(page).first()
    const tab = frame.getByRole("tab", { name: ATTACHMENT, exact: true })
    const shown = (scope: Locator) => scope.getByRole("region", { name: `${ATTACHMENT}'s picture`, exact: true })
    const loaded = async (scope: Locator) => {
      const image = shown(scope).getByRole("img", { name: `${ATTACHMENT}'s full image` })
      await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(240)
    }

    // The app's own context menu, each item explained.
    await messageImage(frame).click({ button: "right" })
    const item = page.getByRole("menuitem", { name: "Open as a tab", exact: true })
    await expect(item).toHaveAccessibleDescription(/^Opens this image as a tab/)
    await expectLayout(page, info, `attachment-image-menu-${theme}`, {
      scope: '[data-layout-overlay="Context menu floats above the page"]'
    })
    await item.click()
    await expect(tab).toBeVisible()
    await expect(column(page)).toHaveCount(0)
    await loaded(frame)
    await expect.poll(async () => (await storedLayout(page)) ?? "").toContain(`name=${ATTACHMENT}`)
    await shot(page, `attachment-tab-${theme}`)
    await expectLayout(page, info, `attachment-tab-${theme}`, { scope: "[data-picture-tab]" })

    await page.reload()
    await expect(frames(page).first().getByRole("tab", { name: ATTACHMENT, exact: true })).toBeVisible()
    await loaded(frames(page).first())

    // On a phone, the tab stays reachable, with no sideways scroll.
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(frames(page)).toHaveCount(1)
    await loaded(frames(page).first())
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await expectLayout(page, info, `attachment-tab-phone-${theme}`, { scope: "[data-picture-tab]" })
    await shot(page, `attachment-tab-phone-${theme}`)
    await page.setViewportSize({ width: 1440, height: 900 })

    // Closed by its own Close; a click on the image still opens the column.
    await shown(frames(page).first()).getByRole("button", { name: "Close the picture", exact: true }).click()
    await expect(shown(page.locator("body"))).toHaveCount(0)
    await messageImage(frames(page).first()).click()
    await expect(page.getByRole("complementary", { name: `${ATTACHMENT}'s portrait`, exact: true })).toBeVisible()
    await page.getByRole("button", { name: "Close the portrait", exact: true }).click()
    await expect(column(page)).toHaveCount(0)
  })

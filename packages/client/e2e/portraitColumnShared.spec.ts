// The workbench's one portrait column and the drags around it (owner, 2026-11-07).
// 1. "If I open two images from one chat pane, then click on a portrait from a different pane,
//    it replaces both of them": pictures from every frame stack in one column.
// 2. "Why does dragging an image between panes resize other panes?": a tab dragged between
//    frames, or the side panel hiding, moves no divider that stays.
// 3. "Dragging a portrait from the chat into a pane results in the composer displaying this":
//    a message portrait dropped on a frame opens there as a tab, never as an attachment; a
//    file from outside still attaches.
// 4. "Why can't it remain attached to the chat it was on before?": the side panel stays with
//    its chat when a picture tab shows over that chat.
import { expect, type Locator, type Page, test } from "@playwright/test"
import { addToCast } from "./support/cast.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { openPanel, panelTab } from "./support/panel.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { removeAttachment } from "./support/attachments.ts"
import { SHAPES, shapeCard } from "./support/shapes.ts"
import { expectTextBox } from "./support/textbox.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "200", FAKE_GENERATOR_TOKENS: "20" })
test.setTimeout(240_000)

const [TALL, STANDARD] = [SHAPES[0]!, SHAPES[1]!]

let chatUrl: Promise<string> | null = null
/** A chat with Tall (greeting and reply on screen) and Standard in its cast, its panel closed. */
const openChat = async (page: Page, width = 1440) => {
  await page.setViewportSize({ width, height: 900 })
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
  // Logging in starts the account's layouts over at one tab.
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}${url}`)
  await expect(page.locator("[data-frame] article[data-slot]").first()).toBeVisible()
}

const frames = (page: Page) => page.locator("[data-frame]")
const column = (page: Page) => page.locator("[data-portrait-column]")
const viewers = (page: Page) => column(page).locator("[data-portrait-viewer]")
const names = (page: Page) => viewers(page).locator("h2").allTextContents()
const panel = (page: Page) => page.getByRole("tablist", { name: "Chat panel" })
const pictureTab = (scope: Locator) => scope.getByRole("tab", { name: TALL.name, exact: true })
/** The chat's tab, titled by its character and date ("Tall, Nov 7"), unlike the picture's. */
const chatTab = (scope: Locator) => scope.getByRole("tab", { name: new RegExp(`^${TALL.name}, `) })

/** Focuses a frame with a click on its message text, as a reader would. */
const focusFrame = async (frame: Locator) => {
  await frame.locator("article[data-slot] .prose, article[data-slot] p").first().click()
}

/** Tall's portrait on the frame's first message. */
const messagePortrait = (frame: Locator) =>
  frame
    .locator("article[data-slot]")
    .getByRole("button", { name: `View ${TALL.name}'s portrait` })
    .first()

/**
 * Tall's portrait opened from a frame, focused first as a reader's click on its text would: a
 * focus moves the side panel to that frame's chat, which may change the frames' widths.
 */
const openPortrait = async (frame: Locator) => {
  await focusFrame(frame)
  await messagePortrait(frame).click()
}

/** The panel of this frame's chat at its Cast: icons in a wide header, one button in a narrow one. */
const openCast = async (page: Page, frame: Locator) => {
  await focusFrame(frame)
  if (!(await panel(page).isVisible())) {
    const icons = frame.getByRole("group", { name: "Chat panel" })
    if (await icons.isVisible()) await icons.getByRole("button", { name: "Cast", exact: true }).click()
    // Split, the panel's toggle is on the top-right strip.
    else await page.getByRole("button", { name: "Chat panel", exact: true }).click()
  }
  await panelTab(page, "Cast")
}

/** Standard's portrait from the Cast in the panel of this frame's chat. */
const openFromCast = async (page: Page, frame: Locator) => {
  await openCast(page, frame)
  await page
    .getByRole("tabpanel", { name: "Cast", exact: true })
    .getByRole("button", { name: `View ${STANDARD.name}'s portrait`, exact: true })
    .click()
}

const closeAll = async (page: Page) => {
  for (let count = await viewers(page).count(); count > 0; count--) {
    await viewers(page)
      .first()
      .getByRole("button", { name: /^Close the (portrait|image)$/ })
      .click()
    await expect(viewers(page)).toHaveCount(count - 1)
  }
  await expect(column(page)).toHaveCount(0)
}

/** The divider between the left frame and the right ones: the left frame's right edge. */
const divider = async (page: Page) => {
  const box = (await frames(page).nth(0).boundingBox())!
  return box.x + box.width
}
const expectDivider = async (page: Page, at: number) =>
  expect.poll(async () => Math.abs((await divider(page)) - at)).toBeLessThanOrEqual(1)

test("pictures from every frame stack in one column; closing one leaves the others", async ({ page }) => {
  // Room for two frames beside the column and the panel.
  await openChat(page, 1920)
  await page.getByRole("button", { name: "Split right" }).click()
  await expect(frames(page)).toHaveCount(2)
  const [a, b] = [frames(page).nth(0), frames(page).nth(1)]
  await expect(b.locator("article[data-slot]").first()).toBeVisible()

  for (const [first, second] of [
    [a, b],
    [b, a]
  ] as const) {
    // Two from one frame, then one from the other: the newest on top. Both frames show one
    // chat, so its portrait opened from the other frame shows once, on top (owner, 2026-11-24).
    await openPortrait(first)
    await openFromCast(page, first)
    await expect(viewers(page)).toHaveCount(2)
    expect(await names(page)).toEqual([STANDARD.name, TALL.name])
    await openPortrait(second)
    await expect(column(page)).toHaveCount(1)
    await expect(viewers(page)).toHaveCount(2)
    expect(await names(page)).toEqual([TALL.name, STANDARD.name])
    await expectLayout(page, test.info(), `shared-column-${first === a ? "ab" : "ba"}`, {
      scope: "[data-portrait-column]"
    })
    // Its own Close leaves the others.
    await viewers(page).nth(1).getByRole("button", { name: "Close the portrait", exact: true }).click()
    await expect(viewers(page)).toHaveCount(1)
    expect(await names(page)).toEqual([TALL.name])
    // Closing the one picture both frames show closes it in both.
    await closeAll(page)
  }

  // Open as a tab opens beside the view the picture came from: the right frame's.
  await openPortrait(b)
  await openFromCast(page, a)
  await expect(viewers(page)).toHaveCount(2)
  await viewers(page).nth(1).getByRole("button", { name: "Viewer options", exact: true }).click()
  await page.getByRole("menuitem", { name: "Open as a tab", exact: true }).click()
  await expect(pictureTab(frames(page).nth(1))).toBeVisible()
  await expect(pictureTab(frames(page).nth(0))).toHaveCount(0)
  await expect(viewers(page)).toHaveCount(1)
})

test("a tab dragged between frames moves no divider and keeps the side panel with its chat", async ({ page }) => {
  await openChat(page)
  // The owner's layout: a frame on the left, two above each other on the right.
  await page.getByRole("button", { name: "Split right" }).click()
  await expect(frames(page)).toHaveCount(2)
  // A narrow frame's header has the splits in a menu.
  const splitDown = frames(page).nth(1).getByRole("button", { name: "Split down", exact: true })
  if (await splitDown.isVisible()) await splitDown.click()
  else {
    await frames(page).nth(1).getByRole("button", { name: "Split", exact: true }).click()
    await page.getByRole("menuitem", { name: "Split down" }).click()
  }
  await expect(frames(page)).toHaveCount(3)
  const [, top, bottom] = [frames(page).nth(0), frames(page).nth(1), frames(page).nth(2)]
  await expect(top.locator("article[data-slot]").first()).toBeVisible()
  // A picture tab alone in the upper right frame.
  await messagePortrait(top).click()
  await viewers(page).first().getByRole("button", { name: "Viewer options", exact: true }).click()
  await page.getByRole("menuitem", { name: "Open as a tab", exact: true }).click()
  await expect(pictureTab(top)).toBeVisible()
  await top
    .locator("[data-tab]")
    .first()
    .getByRole("button", { name: /^Close / })
    .click()
  await expect(top.locator("[data-tab]")).toHaveCount(1)
  // The lower right chat's panel open.
  await openFromCast(page, bottom)
  await closeAll(page)
  await expect(panel(page)).toBeVisible()
  const at = await divider(page)
  const left = (await frames(page).nth(0).boundingBox())!

  // Dragged onto the lower frame's strip: the upper frame closes, the lower takes its height.
  const strip = bottom.locator("[data-tab-strip]")
  await pictureTab(top).dragTo(strip)
  await expect(frames(page)).toHaveCount(2)
  const right = frames(page).nth(1)
  await expect(pictureTab(right)).toBeVisible()
  await expect(panel(page)).toBeVisible()
  await expectDivider(page, at)
  expect(Math.abs((await right.boundingBox())!.y - left.y)).toBeLessThanOrEqual(1)

  // Another picture opened over the chat in its frame: the panel stays, nothing moves.
  await chatTab(right).click()
  await expect(right.locator("article[data-slot]").first()).toBeVisible()
  await expect(panel(page)).toBeVisible()
  await openFromCast(page, right)
  await viewers(page).first().getByRole("button", { name: "Viewer options", exact: true }).click()
  await page.getByRole("menuitem", { name: "Open as a tab", exact: true }).click()
  await expect(right.getByRole("tab", { name: STANDARD.name, exact: true })).toBeVisible()
  await expect(panel(page)).toBeVisible()
  await expectDivider(page, at)

  // The panel hidden from its chat: its width goes to the frame beside it; the divider stays.
  await chatTab(right).click()
  await right.getByRole("button", { name: "Hide panel", exact: true }).click()
  await expect(panel(page)).toHaveCount(0)
  await expectDivider(page, at)
})

test("a message portrait dropped on another frame opens there as a tab, not as an attachment", async ({ page }) => {
  await openChat(page)
  await page.getByRole("button", { name: "Split right" }).click()
  await expect(frames(page)).toHaveCount(2)
  const [a, b] = [frames(page).nth(0), frames(page).nth(1)]
  await expect(b.locator("article[data-slot]").first()).toBeVisible()
  const body = (await b.locator("[data-frame-body]").boundingBox())!
  await messagePortrait(a).dragTo(b.locator("[data-frame-body]"), {
    targetPosition: { x: body.width / 2, y: body.height / 2 }
  })
  await expect(pictureTab(b)).toBeVisible()
  await expect(page.getByRole("list", { name: "Attached images" })).toHaveCount(0)
  await expect(page.getByText("reload to retry")).toHaveCount(0)

  // A file from outside the app, dropped on the chat, still attaches.
  await b.locator("[data-tab] [role=tab]").first().click()
  await expect(b.locator("article[data-slot]").first()).toBeVisible()
  await b.locator('[data-testid="messages"]').evaluate(async (target) => {
    const canvas = document.createElement("canvas")
    canvas.width = canvas.height = 8
    canvas.getContext("2d")!.fillRect(0, 0, 8, 8)
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), "image/png"))
    const data = new DataTransfer()
    data.items.add(new File([blob], "outside.png", { type: "image/png" }))
    target.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }))
  })
  await expect(b.getByRole("button", { name: "Remove outside.png" })).toBeVisible()
  await expect(a.getByRole("list", { name: "Attached images" })).toHaveCount(0)
})

test("closing the panel's chat leaves the panel in place, saying what shows there, until a chat opens", async ({
  page
}) => {
  await openChat(page)
  // Typing keeps the chat's tab when the library opens beside it in the frame.
  await page.getByLabel("Message", { exact: true }).fill("Kept")
  await page.getByRole("navigation", { name: "Main", exact: true }).getByRole("link", { name: "Library" }).click()
  await expect(page.locator("[data-tab]")).toHaveCount(2)
  await page.getByRole("button", { name: "Split right" }).click()
  await expect(frames(page)).toHaveCount(2)
  const left = frames(page).nth(0)
  await left.locator("[data-tab] [role=tab]").first().click()
  await expect(left.locator("article[data-slot]").first()).toBeVisible()
  await openCast(page, left)
  await expect(panel(page)).toBeVisible()
  const at = await divider(page)
  const panelBox = page.getByRole("complementary", { name: "Chat panel" })
  const width = (await panelBox.boundingBox())!.width

  // The only chat closed: the panel's place stays, with its width.
  await left
    .locator("[data-tab]")
    .first()
    .getByRole("button", { name: /^Close / })
    .click()
  await expect(page.locator("article[data-slot]")).toHaveCount(0)
  const placeholder = page.locator("[data-panel-placeholder]")
  await expect(placeholder).toBeVisible()
  await expect(placeholder.getByText("Open a chat to see its settings here.")).toBeVisible()
  expect(Math.abs((await placeholder.boundingBox())!.width - width)).toBeLessThanOrEqual(1)
  await expectDivider(page, at)
  await expectLayout(page, test.info(), "panel-placeholder", { scope: "[data-panel-placeholder]" })

  // A chat opened again: the panel shows it, in the same place.
  await left.locator("[data-tab] [role=tab]").first().click({ button: "right" })
  await page.getByRole("menuitem", { name: /^Reopen closed tab/ }).click()
  await expect(left.locator("article[data-slot]").first()).toBeVisible()
  await expect(panel(page)).toBeVisible()
  await expect(placeholder).toHaveCount(0)
  expect(Math.abs((await panelBox.boundingBox())!.width - width)).toBeLessThanOrEqual(1)
  await expectDivider(page, at)
})

for (const theme of ["light", "dark"] as const)
  test(`shared frame pictures restore and single-image preference applies across frames ${theme}`, async ({
    page
  }, info) => {
    await page.emulateMedia({ colorScheme: theme })
    await openChat(page, 1440)
    await page.getByRole("button", { name: "Split right" }).click()
    const [a, b] = [frames(page).nth(0), frames(page).nth(1)]
    await expect(b.locator("article[data-slot]").first()).toBeVisible()
    await openPortrait(a)
    await openFromCast(page, a)
    // The same portrait from the other frame shows once.
    await openPortrait(b)
    await expect(viewers(page)).toHaveCount(2)
    const before = (await names(page)).sort()
    await page.screenshot({ path: info.outputPath(`shared-1440-${theme}.png`) })
    await page.reload()
    await expect(frames(page)).toHaveCount(2)
    await expect(viewers(page)).toHaveCount(2)
    expect((await names(page)).sort()).toEqual(before)
    await page.screenshot({ path: info.outputPath(`shared-restored-${theme}.png`) })
    await viewers(page).first().getByRole("button", { name: "Viewer options", exact: true }).click()
    await page.getByRole("menuitemcheckbox", { name: "Keep one image open", exact: true }).click()
    await expect(viewers(page)).toHaveCount(1)
    await closeAll(page)
    await openPortrait(frames(page).nth(0))
    await expect(viewers(page)).toHaveCount(1)
    await openFromCast(page, frames(page).nth(1))
    await expect.poll(() => names(page)).toEqual([STANDARD.name])
    await viewers(page).first().getByRole("button", { name: "Viewer options", exact: true }).click()
    await page.getByRole("menuitemcheckbox", { name: "Keep one image open", exact: true }).click()
    await closeAll(page)
  })

// 6. "If you have a portrait open, and you split a chat into two panes, the open portrait from
//    that chat doubles in the gallery" (owner, 2026-11-24): the column holds each picture once.
test("a portrait open while the chat splits into two panes shows once, after closing one and a reload", async ({
  page
}) => {
  await openChat(page, 1920)
  await openPortrait(frames(page).first())
  await expect(viewers(page)).toHaveCount(1)
  await page.getByRole("button", { name: "Split right" }).click()
  await expect(frames(page)).toHaveCount(2)
  await expect(frames(page).nth(1).locator("article[data-slot]").first()).toBeVisible()
  await expect(viewers(page)).toHaveCount(1)
  expect(await names(page)).toEqual([TALL.name])
  // Each pane keeps it in its own URL, once.
  await page.reload()
  await expect(frames(page)).toHaveCount(2)
  await expect(frames(page).nth(1).locator("article[data-slot]").first()).toBeVisible()
  await expect(viewers(page)).toHaveCount(1)
  expect(await names(page)).toEqual([TALL.name])
  // Closing either pane leaves it, once.
  await frames(page)
    .nth(1)
    .getByRole("button", { name: new RegExp(`^Close ${TALL.name}, `) })
    .click()
  await expect(frames(page)).toHaveCount(1)
  await expect(viewers(page)).toHaveCount(1)
  expect(await names(page)).toEqual([TALL.name])
  await page.reload()
  await expect(frames(page).first().locator("article[data-slot]").first()).toBeVisible()
  await expect(viewers(page)).toHaveCount(1)
  await closeAll(page)

  // Split again: a click on the shared portrait in the new pane closes it outright, in both
  // panes' URLs, as a second click in one pane does; a reload keeps the column empty.
  await openPortrait(frames(page).first())
  await page.getByRole("button", { name: "Split right" }).click()
  await expect(frames(page)).toHaveCount(2)
  await expect(frames(page).nth(1).locator("article[data-slot]").first()).toBeVisible()
  await expect(viewers(page)).toHaveCount(1)
  await openPortrait(frames(page).nth(1))
  await expect(column(page)).toHaveCount(0)
  await page.reload()
  await expect(frames(page)).toHaveCount(2)
  await expect(frames(page).nth(1).locator("article[data-slot]").first()).toBeVisible()
  await expect(column(page)).toHaveCount(0)
})

for (const width of [1340, 1920])
  test(`opening the same portrait from another pane preserves its zoom at ${width}`, async ({ page }) => {
    await openChat(page, width)
    await page.getByRole("button", { name: "Split right" }).click()
    await expect(frames(page)).toHaveCount(2)
    const [left, right] = [frames(page).first(), frames(page).nth(1)]
    await openPortrait(left)
    const viewer = viewers(page).first()
    const actualSize = viewer.getByRole("button", { name: "100%", exact: true })
    await actualSize.click()
    await expect(actualSize).toHaveAttribute("aria-pressed", "true")

    await openPortrait(right)
    await expect(viewers(page)).toHaveCount(1)
    await expect(actualSize).toHaveAttribute("aria-pressed", "true")
    await expect(viewer.locator("[data-zoom-percent]")).toHaveText("100%")

    await viewer.getByRole("button", { name: "Viewer options", exact: true }).click()
    await page.getByRole("menuitem", { name: "Open as a tab", exact: true }).click()
    await expect(pictureTab(right)).toBeVisible()
    await expect(pictureTab(left)).toHaveCount(0)
    await expect(column(page)).toHaveCount(0)
  })

test("browser Back leaves the portrait open in the other pane", async ({ page }) => {
  await openChat(page, 1340)
  await page.getByRole("button", { name: "Split right" }).click()
  const [left, right] = [frames(page).nth(0), frames(page).nth(1)]
  await expect(messagePortrait(right)).toBeVisible()
  await openPortrait(left)
  await expect(viewers(page)).toHaveCount(1)

  await focusFrame(right)
  await expect.poll(() => new URL(page.url()).searchParams.has("portraits")).toBe(false)
  await messagePortrait(right).click()
  await expect.poll(() => new URL(page.url()).searchParams.has("portraits")).toBe(true)
  await page.goBack()
  await expect.poll(() => new URL(page.url()).searchParams.has("portraits")).toBe(false)
  await expect(frames(page)).toHaveCount(2)
  await expect.poll(() => names(page)).toEqual([TALL.name])
  await focusFrame(left)
  await expect.poll(() => new URL(page.url()).searchParams.has("portraits")).toBe(true)
})

test("each frame's portrait height survives reload when frames show the same card", async ({ page }, info) => {
  await openChat(page, 1440)
  await page.getByRole("button", { name: "Split right" }).click()
  const [a, b] = [frames(page).nth(0), frames(page).nth(1)]
  await expect(b.locator("article[data-slot]").first()).toBeVisible()
  await openPortrait(a)
  await openFromCast(page, b)
  await expect(viewers(page)).toHaveCount(2)
  const handle = column(page).getByRole("separator", { name: /Resize .+'s and .+'s (portraits|images)/ })
  await handle.press("Shift+ArrowDown")
  const weights = () =>
    viewers(page).evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).style.flexGrow).sort())
  await expect.poll(weights).not.toEqual(["1", "1"])
  const before = await weights()
  await page.screenshot({ path: info.outputPath("frame-weights-before.png") })
  await page.reload()
  await expect(frames(page)).toHaveCount(2)
  await expect(viewers(page)).toHaveCount(2)
  await page.screenshot({ path: info.outputPath("frame-weights-restored.png") })
  expect(await weights()).toEqual(before)
})

// 5. "Can you open images attached to messages in the image viewer?" (owner, 2026-11-07): a
//    message's attached image opens in the same shared column as portraits, from any frame.
const ATTACHMENT = "harbor.png"
const attachmentTab = (scope: Locator | Page) => scope.getByRole("tab", { name: ATTACHMENT, exact: true })
/** The frame's message image (the first one, the message sent with it). */
const messageImage = (frame: Locator | Page) =>
  frame.locator("article[data-slot]").getByRole("button", { name: "View image 1", exact: true }).first()
const openAttachment = async (frame: Locator) => {
  await focusFrame(frame)
  await messageImage(frame).click()
}

/** The chat's one message with a synthetic image, sent once for the file's tests. */
const withAttachment = async (page: Page) => {
  if ((await messageImage(page).count()) > 0) return
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement("canvas")
    canvas.width = 360
    canvas.height = 240
    const ctx = canvas.getContext("2d")!
    ctx.fillStyle = "#dfe9ef"
    ctx.fillRect(0, 0, 360, 240)
    ctx.fillStyle = "#2f5d73"
    ctx.fillRect(40, 150, 280, 50)
    ctx.beginPath()
    ctx.moveTo(180, 40)
    ctx.lineTo(120, 150)
    ctx.lineTo(240, 150)
    ctx.fill()
    return canvas.toDataURL("image/png").split(",")[1]!
  })
  // Attaching waits for the chat to load; the message's text replaces any draft left before.
  await expect(page.getByRole("button", { name: "Attach images", exact: true })).toBeEnabled()
  // An image an earlier test left attached (a file dropped from outside) goes first.
  const left = page.getByRole("list", { name: "Attached images" }).getByRole("button", { name: /^Remove / })
  for (let count = await left.count(); count > 0; count--) {
    await removeAttachment(left.first())
    await expect(left).toHaveCount(count - 1)
  }
  await page.getByLabel("Message", { exact: true }).fill("A harbor sketch.")
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
  test(`a message's attached image stacks in the one column with portraits from every frame, after a reload too ${theme}`, async ({
    page
  }, info) => {
    await page.emulateMedia({ colorScheme: theme })
    await openChat(page, 1440)
    await withAttachment(page)
    await page.getByRole("button", { name: "Split right" }).click()
    await expect(frames(page)).toHaveCount(2)
    const [a, b] = [frames(page).nth(0), frames(page).nth(1)]
    await expect(messageImage(b)).toBeVisible()

    // From the left frame, then a portrait and the same image from the right: one stack, the
    // image once, on top.
    await openAttachment(a)
    await expect(viewers(page)).toHaveCount(1)
    expect(await names(page)).toEqual([ATTACHMENT])
    await openPortrait(b)
    await openAttachment(b)
    await expect(column(page)).toHaveCount(1)
    await expect(viewers(page)).toHaveCount(2)
    expect(await names(page)).toEqual([ATTACHMENT, TALL.name])
    await expect(
      viewers(page)
        .first()
        .getByRole("img", { name: `${ATTACHMENT}'s full image` })
    ).toHaveJSProperty("complete", true)
    await expectLayout(page, info, `shared-attachment-${theme}`, { scope: "[data-portrait-column]" })
    await page.screenshot({ path: info.outputPath(`shared-attachment-${theme}.png`) })
    // A second click in either frame closes it outright, as in one pane (owner, 2026-11-24).
    await openAttachment(b)
    await expect(viewers(page)).toHaveCount(1)
    expect(await names(page)).toEqual([TALL.name])
    await openAttachment(a)
    await expect(viewers(page)).toHaveCount(2)
    expect(await names(page)).toEqual([ATTACHMENT, TALL.name])

    // A reload brings both back.
    await page.reload()
    await expect(frames(page)).toHaveCount(2)
    await expect(viewers(page)).toHaveCount(2)
    expect((await names(page)).sort()).toEqual([ATTACHMENT, TALL.name].sort())

    // Its viewer's ⋯ opens it as a tab, beside the frame it came from: the left one.
    const own = column(page).getByRole("complementary", { name: `${ATTACHMENT}'s image`, exact: true })
    await own.getByRole("button", { name: "Viewer options", exact: true }).click()
    await page.getByRole("menuitem", { name: "Open as a tab", exact: true }).click()
    await expect(attachmentTab(frames(page).nth(0))).toBeVisible()
    await expect(attachmentTab(frames(page).nth(1))).toHaveCount(0)
    await expect(
      frames(page)
        .nth(0)
        .getByRole("region", { name: `${ATTACHMENT}'s picture`, exact: true })
    ).toBeVisible()
    await expect(viewers(page)).toHaveCount(1)
    await closeAll(page)
    await frames(page)
      .nth(0)
      .getByRole("button", { name: `Close ${ATTACHMENT}`, exact: true })
      .click()
    await expect(attachmentTab(page)).toHaveCount(0)
  })

test("a message's attached image dragged onto a frame opens there as a tab; onto the composer it never attaches", async ({
  page
}) => {
  await openChat(page)
  await withAttachment(page)
  await page.getByRole("button", { name: "Split right" }).click()
  await expect(frames(page)).toHaveCount(2)
  const [a, b] = [frames(page).nth(0), frames(page).nth(1)]
  await expect(messageImage(b)).toBeVisible()

  // Onto the other frame's body: a tab there, and no attachment anywhere.
  const body = (await b.locator("[data-frame-body]").boundingBox())!
  await messageImage(a).dragTo(b.locator("[data-frame-body]"), {
    targetPosition: { x: body.width / 2, y: body.height / 3 }
  })
  await expect(attachmentTab(b)).toBeVisible()
  await expect(b.getByRole("region", { name: `${ATTACHMENT}'s picture`, exact: true })).toBeVisible()
  await expect(page.getByRole("list", { name: "Attached images" })).toHaveCount(0)
  await b.getByRole("button", { name: `Close ${ATTACHMENT}`, exact: true }).click()
  await expect(attachmentTab(page)).toHaveCount(0)

  // Onto its own frame's composer: it opens as a tab as on any part of a frame, never in the message.
  const message = a.getByLabel("Message", { exact: true })
  await messageImage(a).dragTo(message)
  await expect(attachmentTab(page)).toHaveCount(1)
  await expect(page.getByRole("list", { name: "Attached images" })).toHaveCount(0)
  await expect(page.getByRole("button", { name: `Remove ${ATTACHMENT}` })).toHaveCount(0)
  await expectTextBox(page.getByLabel("Message", { exact: true }).first(), "")
  await expect(page.getByText("reload to retry")).toHaveCount(0)
  await page
    .getByRole("button", { name: `Close ${ATTACHMENT}`, exact: true })
    .first()
    .click()
})

for (const theme of ["light", "dark"] as const)
  test(`a message's attached image on a phone opens the full-screen viewer ${theme}`, async ({ page }, info) => {
    await page.emulateMedia({ colorScheme: theme })
    await openChat(page, 390)
    await withAttachment(page)
    await messageImage(page).click()
    const screen = page.locator('[data-layout-overlay="The full-screen viewer covers the page"]')
    await expect(screen.getByRole("heading", { name: ATTACHMENT, exact: true })).toBeVisible()
    await expect(screen.getByRole("button", { name: "Fit", exact: true })).toBeVisible()
    await expect(column(page)).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await expectLayout(page, info, `attachment-phone-${theme}`, {
      scope: '[data-layout-overlay="The full-screen viewer covers the page"]'
    })
    await page.screenshot({ path: info.outputPath(`attachment-phone-${theme}.png`) })
    await screen.getByRole("button", { name: "Close", exact: true }).click()
    await expect(screen).toHaveCount(0)
  })

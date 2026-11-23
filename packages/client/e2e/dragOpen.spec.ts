// Dragging characters, chats and pictures onto frames (owner, 2026-11-07; DESIGN §10.1): a
// portrait in a character definition's header opens its picture as a tab where it's dropped; a
// character from Home, the library, the left sidebar or the Cast's Add characters opens its card's
// full-size editor there; a chat row opens that chat there, as a click does. Each drops into a
// strip at a place, or into a body's quarter, which splits. Nothing dragged from inside the app
// becomes a composer attachment, a drop the frame doesn't take does nothing, and a file from
// outside still attaches. A phone has no drag: a long press there is the row's menu.
// SCREENSHOT_DIR saves screenshots; LAYOUT_AUDIT audits the drop previews.
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, type Locator, type Page, test, type TestInfo } from "@playwright/test"
import type { EntityId } from "@dreamspan/shared/chat.ts"
import { Effect } from "effect"
import { openCastAdd } from "./support/cast.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { openPanel, panelTab } from "./support/panel.ts"
import { loginCookie, withCookie } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { removeAttachment } from "./support/attachments.ts"
import { SHAPES, shapeCard } from "./support/shapes.ts"
import { expectTextBox } from "./support/textbox.ts"

const server = serverPerFile(withAdmin)
test.setTimeout(120_000)

const [TALL, STANDARD] = [SHAPES[0]!, SHAPES[1]!]
const shots = process.env.SCREENSHOT_DIR
const shot = async (page: Page, name: string) => {
  if (!shots) return
  mkdirSync(shots, { recursive: true })
  await page.screenshot({ path: join(shots, `${name}.png`) })
}

let harbour: string
let lantern: string

test.beforeAll(async () => {
  const cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
  const refs: Array<{ id: string; entityId: EntityId }> = []
  for (const [index, shape] of [TALL, STANDARD].entries()) {
    const response = await fetch(`${server().url}/library/import?name=${shape.name}.png`, {
      method: "POST",
      headers: { cookie, origin: server().url, "content-type": "application/octet-stream" },
      body: new Uint8Array(shapeCard(shape, index * 40))
    })
    expect(response.ok).toBe(true)
    refs.push(((await response.json()) as { library: { ref: { id: string; entityId: EntityId } } }).library.ref)
  }
  const chat = (title: string, content: string) =>
    withCookie(server(), cookie, (api) =>
      Effect.gen(function* () {
        const made = yield* api.CreateChat({ title })
        yield* api.ChangeCast({
          chatId: made.id,
          slotId: null,
          change: { _tag: "Join", entityId: refs[0]!.entityId }
        })
        yield* api.SendMessage({ chatId: made.id, parentSlotId: null, branch: false, content, reply: false })
        return made.id as string
      })
    )
  harbour = await chat("Harbour walk", "The tide is out; the boats lean on the mud.")
  lantern = await chat("Lantern night", "The lanterns sway over the quay.")
})

const frames = (page: Page) => page.locator("[data-frame]")
const STRIP_TAB = "[data-tab-strip] [data-tab]"
const stripTabs = (scope: Locator | Page) => scope.locator(STRIP_TAB)
const sidebar = (page: Page) => page.getByRole("complementary", { name: "Sidebar" })
const attachments = (page: Page) => page.getByRole("list", { name: "Attached images" })

/** Harbour walk at 1440, in `theme`, split in two: the left frame focused, both showing it. */
const twoFrames = async (page: Page, theme: "light" | "dark", path = `/chats/${harbour}`, shown?: string) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ colorScheme: theme })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}${path}`)
  await expect(
    frames(page)
      .getByText(shown ?? "The tide is out")
      .first()
  ).toBeVisible()
  await page.getByRole("button", { name: "Split right" }).first().click()
  await expect(frames(page)).toHaveCount(2)
  await expect(
    frames(page)
      .nth(1)
      .getByText(shown ?? "The tide is out")
      .first()
  ).toBeVisible()
  await frames(page).nth(0).locator(`${STRIP_TAB} [role=tab]`).first().click()
}

/** Opens a page from the sidebar's menu, kept, in the focused frame. */
const openKept = async (page: Page, label: string) => {
  await sidebar(page).getByRole("navigation", { name: "Main" }).getByRole("link", { name: label }).dblclick()
}

/**
 * Drags `source` with the mouse to `to` and holds it there, nudging it until `preview` shows
 * (Chromium sends a dragover only on a move), runs `hold` and releases it.
 */
const dragOnto = async (
  page: Page,
  source: Locator,
  to: { x: number; y: number },
  preview: Locator,
  hold: () => Promise<void> = async () => {}
) => {
  await source.scrollIntoViewIfNeeded()
  const from = (await source.boundingBox())!
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2 + 12, { steps: 3 })
  await page.mouse.move(to.x, to.y, { steps: 12 })
  let nudge = 0
  await expect(async () => {
    nudge = 1 - nudge
    await page.mouse.move(to.x + nudge, to.y)
    await expect(preview).toBeVisible({ timeout: 300 })
  }).toPass({ timeout: 10_000 })
  await hold()
  await page.mouse.up()
}

/**
 * Drags `source` onto `frame`: before its strip's first tab, or onto its body's lower quarter,
 * which splits it. The preview shows while it's over; `audit` names it for the layout audit
 * and a screenshot.
 */
const drag = async (
  page: Page,
  info: TestInfo,
  source: Locator,
  frame: Locator,
  where: "strip" | "split",
  audit?: string
) => {
  const target = where === "strip" ? stripTabs(frame).first() : frame.locator("[data-frame-body]")
  const box = (await target.boundingBox())!
  const to =
    where === "strip"
      ? { x: box.x + 8, y: box.y + box.height / 2 }
      : { x: box.x + box.width / 2, y: box.y + box.height * 0.92 }
  const preview =
    where === "strip"
      ? frame.locator("[data-tab-strip] [data-drop-before]")
      : frame.locator('[data-drop-zone="bottom"]')
  await dragOnto(page, source, to, preview, async () => {
    if (!audit) return
    await shot(page, audit)
    if (process.env.LAYOUT_AUDIT)
      await expectLayout(page, info, audit, {
        hovered: true,
        scope:
          where === "strip" ? "[data-tab-strip]:has([data-drop-before])" : "[data-frame-body]:has([data-drop-zone])"
      })
  })
  await expect(page.locator("[data-drop-zone], [data-drop-before]")).toHaveCount(0)
}

/** A point's middle. */
const middle = async (locator: Locator) => {
  const box = (await locator.boundingBox())!
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

/** The frame's first tab is the one shown, and the frame shows `shows`. */
const expectOpenedFirst = async (frame: Locator, shows: Locator) => {
  await expect(frame.locator(STRIP_TAB).first().getByRole("tab")).toHaveAttribute("aria-selected", "true")
  await expect(shows).toBeVisible()
}

const cardEditor = (frame: Locator) => frame.getByRole("region", { name: "Card editor" })

/** Strip, then split: `source()` dropped on the right frame opens what `shows` finds there. */
const stripThenSplit = async (
  page: Page,
  info: TestInfo,
  source: () => Locator,
  shows: (frame: Locator) => Locator,
  audit?: string
) => {
  const right = frames(page).nth(1)
  const tabs = await right.locator(STRIP_TAB).count()
  await drag(page, info, source(), right, "strip", audit && `${audit}-strip`)
  await expect(right.locator(STRIP_TAB)).toHaveCount(tabs + 1)
  await expectOpenedFirst(right, shows(right))
  // The region precedes its lazy editor. Mounting that editor under a held drag can
  // replace the native drop target after its last dragover, leaving a stale preview.
  if (shows === cardEditor)
    await expect(cardEditor(right).getByRole("textbox", { name: "Description", exact: true })).toBeVisible()
  await drag(page, info, source(), right, "split", audit && `${audit}-split`)
  await expect(frames(page)).toHaveCount(3)
  // The right frame's lower half: a new frame below it, which shows it alone.
  const below = frames(page).nth(2)
  await expect(below.locator(STRIP_TAB)).toHaveCount(1)
  await expect(shows(below)).toBeVisible()
}

for (const theme of ["light", "dark"] as const) {
  test(`a character from Home opens its full-size editor where it's dropped (${theme})`, async ({ page }, info) => {
    await twoFrames(page, theme)
    await openKept(page, "Home")
    const left = frames(page).nth(0)
    await expect(left.getByLabel("Characters", { exact: true })).toBeVisible()
    await stripThenSplit(
      page,
      info,
      () => left.getByLabel("Characters", { exact: true }).getByRole("link", { name: `Open ${TALL.name}` }),
      cardEditor,
      `home-card-1440-${theme}`
    )
    // A click still opens the character's chat, as before.
    await left
      .getByLabel("Characters", { exact: true })
      .getByRole("link", { name: `Open ${STANDARD.name}` })
      .click()
    await expect(left.getByLabel("Message", { exact: true })).toBeVisible()
    await expect(cardEditor(left)).toHaveCount(0)
  })

  test(`a character from the library opens its full-size editor where it's dropped (${theme})`, async ({
    page
  }, info) => {
    await twoFrames(page, theme)
    await openKept(page, "Library")
    const left = frames(page).nth(0)
    await stripThenSplit(page, info, () => left.getByRole("link", { name: TALL.name, exact: true }).first(), cardEditor)
  })

  test(`a character from the left sidebar opens its full-size editor where it's dropped (${theme})`, async ({
    page
  }, info) => {
    await twoFrames(page, theme)
    await sidebar(page).getByRole("group", { name: "Left panel", exact: true }).getByText("Characters").click()
    const grid = sidebar(page).getByLabel("Characters", { exact: true })
    await stripThenSplit(page, info, () => grid.getByRole("link", { name: `Open ${STANDARD.name}` }), cardEditor)
  })

  test(`a character from the Cast's Add characters opens its full-size editor where it's dropped (${theme})`, async ({
    page
  }, info) => {
    await twoFrames(page, theme)
    // The panel is the left frame's chat's; the right frame takes the drops.
    await openPanel(page, "Cast")
    const section = await openCastAdd(page)
    await stripThenSplit(page, info, () => section.getByRole("link", { name: `Open ${STANDARD.name}` }), cardEditor)
  })

  test(`a sidebar chat row opens that chat where it's dropped, as a click does (${theme})`, async ({ page }, info) => {
    await twoFrames(page, theme)
    await stripThenSplit(
      page,
      info,
      () => sidebar(page).getByRole("link", { name: "Open chat Lantern night" }),
      (frame) => frame.getByText("The lanterns sway over the quay."),
      `chat-row-1440-${theme}`
    )
  })

  test(`a chat in the Chats list opens where it's dropped (${theme})`, async ({ page }, info) => {
    await twoFrames(page, theme, "/chats", "Lantern night")
    const left = frames(page).nth(0)
    await stripThenSplit(
      page,
      info,
      () => left.getByRole("link", { name: /Lantern night/ }),
      (frame) => frame.getByText("The lanterns sway over the quay.")
    )
  })

  test(`a character tab's portrait opens its picture where it's dropped (${theme})`, async ({ page }, info) => {
    await twoFrames(page, theme)
    await openPanel(page, "Cast")
    await panelTab(page, TALL.name)
    const tab = page.getByRole("tabpanel", { name: TALL.name })
    await stripThenSplit(
      page,
      info,
      () => tab.locator("[data-card-header-portrait]").getByRole("button", { name: `View ${TALL.name}'s picture` }),
      (frame) => frame.getByRole("tab", { name: TALL.name, exact: true, selected: true }),
      `header-portrait-1440-${theme}`
    )
  })

  test(`the full editor's header portrait opens its picture where it's dropped (${theme})`, async ({ page }, info) => {
    await twoFrames(page, theme)
    await openKept(page, "Library")
    const left = frames(page).nth(0)
    await left.getByRole("link", { name: `Edit ${TALL.name}`, exact: true }).click()
    await expect(cardEditor(left)).toBeVisible()
    await stripThenSplit(
      page,
      info,
      () => left.locator("[data-card-header-portrait]").getByRole("button", { name: `View ${TALL.name}'s picture` }),
      (frame) => frame.getByRole("tab", { name: TALL.name, exact: true, selected: true })
    )
  })

  test(`the composer never attaches what's dragged from the app; a file from outside still attaches (${theme})`, async ({
    page
  }, info) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.emulateMedia({ colorScheme: theme })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/chats/${harbour}`)
    const frame = frames(page).first()
    const message = frame.getByLabel("Message", { exact: true })
    await expect(frame.getByText("The tide is out")).toBeVisible()

    // Something of the app's the frame doesn't take (a menu link): no preview, and its drop does nothing.
    const url = page.url()
    const link = sidebar(page).getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Library" })
    const from = await middle(link)
    const over = await middle(frame.getByText("The tide is out"))
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(from.x + 12, from.y - 12, { steps: 3 })
    await page.mouse.move(over.x, over.y, { steps: 12 })
    for (const nudge of [1, 0, 1]) await page.mouse.move(over.x + nudge, over.y)
    await expect(page.locator("[data-drop-zone]")).toHaveCount(0)
    await page.mouse.up()
    expect(page.url()).toBe(url)
    await expect(page.locator(STRIP_TAB)).toHaveCount(0)

    // A portrait in the Cast, dropped on the other frame's composer: that frame opens its picture, nothing attaches.
    await page.getByRole("button", { name: "Split right" }).first().click()
    await expect(frames(page)).toHaveCount(2)
    const other = frames(page).nth(1)
    await expect(other.getByText("The tide is out")).toBeVisible()
    await frame.locator(`${STRIP_TAB} [role=tab]`).first().click()
    const cast = await openPanel(page, "Cast")
    const portrait = cast.getByRole("button", { name: `View ${TALL.name}'s portrait` }).first()
    await dragOnto(
      page,
      portrait,
      await middle(other.getByLabel("Message", { exact: true })),
      other.locator("[data-drop-zone]")
    )
    // The composer is the frame's lower part: the picture opens in a new frame below.
    await expect(page.getByRole("tab", { name: TALL.name, exact: true, selected: true })).toBeVisible()
    await expect(attachments(page)).toHaveCount(0)

    // A character from the sidebar, dropped on the composer: its editor opens, nothing attaches.
    await frame.locator(`${STRIP_TAB} [role=tab]`).first().click()
    await expect(message).toBeVisible()
    await sidebar(page).getByRole("group", { name: "Left panel", exact: true }).getByText("Characters").click()
    const tile = sidebar(page)
      .getByLabel("Characters", { exact: true })
      .getByRole("link", { name: `Open ${TALL.name}` })
    await dragOnto(page, tile, await middle(message), frame.locator("[data-drop-zone]"))
    await expect(page.getByRole("region", { name: "Card editor" })).toBeVisible()
    await frame.locator(`${STRIP_TAB} [role=tab]`).first().click()
    await expect(message).toBeVisible()
    await expectTextBox(message, "")
    await expect(attachments(page)).toHaveCount(0)
    await expect(page.getByText("reload to retry")).toHaveCount(0)

    // A file from outside the app, dropped on the chat, still attaches.
    await frame.locator('[data-testid="messages"]').evaluate(async (target) => {
      const canvas = document.createElement("canvas")
      canvas.width = canvas.height = 8
      canvas.getContext("2d")!.fillRect(0, 0, 8, 8)
      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), "image/png"))
      const data = new DataTransfer()
      data.items.add(new File([blob], "outside.png", { type: "image/png" }))
      target.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }))
    })
    await expect(frame.getByRole("button", { name: "Remove outside.png" })).toBeVisible()
    await shot(page, `composer-outside-file-1440-${theme}`)
    if (process.env.LAYOUT_AUDIT)
      await expectLayout(page, info, `composer-outside-file-1440-${theme}`, { scope: "form" })
    // The draft is kept per chat: leave none for the next theme's run.
    await removeAttachment(frame.getByRole("button", { name: "Remove outside.png" }))
    await expect(attachments(page)).toHaveCount(0)
  })
}

/**
 * Drops the app's `source` on `target` as a real browser drags an image: its own dragstart puts
 * the payload on the drag, and the browser adds the image as a file (Playwright's mouse drags
 * leave the file out, so this dispatches the events itself).
 */
const dropWithFile = async (source: Locator, target: Locator) => {
  await source.evaluate(
    async (from, to) => {
      const canvas = document.createElement("canvas")
      canvas.width = canvas.height = 8
      canvas.getContext("2d")!.fillRect(0, 0, 8, 8)
      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), "image/png"))
      const data = new DataTransfer()
      const init = { dataTransfer: data, bubbles: true, cancelable: true }
      from.dispatchEvent(new DragEvent("dragstart", init))
      data.items.add(new File([blob], "portrait.png", { type: "image/png" }))
      const box = to!.getBoundingClientRect()
      const at = { ...init, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 }
      for (const type of ["dragenter", "dragover", "drop"]) to!.dispatchEvent(new DragEvent(type, at))
      from.dispatchEvent(new DragEvent("dragend", init))
    },
    await target.elementHandle()
  )
}

// review-imgdrag: a portrait's native drag carries the browser's own image file too, so a card's
// Gallery and the import page's file drop took it as a new picture or an import while the frame
// opened it as a tab.
test("nothing dragged from the app adds to a card's gallery or starts an import", async ({ page }) => {
  const uploads: string[] = []
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/library\/(gallery|import)\b/.test(request.url())) uploads.push(request.url())
  })
  await twoFrames(page, "light")
  const [left, right] = [frames(page).nth(0), frames(page).nth(1)]
  // The right frame shows Tall's full editor; the panel stays the left frame's chat's.
  await right.locator(`${STRIP_TAB} [role=tab]`).first().click()
  await openKept(page, "Library")
  await right.getByRole("link", { name: `Edit ${TALL.name}`, exact: true }).click()
  await expect(cardEditor(right)).toBeVisible()
  await right.getByRole("tab", { name: "Extra", exact: true }).click()
  await left.locator(`${STRIP_TAB} [role=tab]`).first().click()
  const portrait = () =>
    page
      .getByRole("tabpanel", { name: "Cast" })
      .getByRole("button", { name: `View ${TALL.name}'s portrait` })
      .first()
  await openPanel(page, "Cast")
  const gallery = right.locator("[data-gallery]")
  await gallery.scrollIntoViewIfNeeded()
  await dropWithFile(portrait(), gallery)
  await expect(right.getByRole("tab", { name: TALL.name, exact: true, selected: true })).toBeVisible()
  expect(uploads).toEqual([])

  // The import page's file drop, a chat beside it.
  await page.goto(`${server().url}/import`)
  await expect(page.getByText("Choose files, or drop them here")).toBeVisible()
  await page.getByRole("button", { name: "Split right" }).first().click()
  await expect(frames(page)).toHaveCount(2)
  const [importer, chat] = [frames(page).nth(0), frames(page).nth(1)]
  await chat.locator(`${STRIP_TAB} [role=tab]`).first().click()
  await sidebar(page).getByRole("link", { name: "Open chat Harbour walk" }).click()
  await expect(chat.getByText("The tide is out")).toBeVisible()
  await openPanel(page, "Cast")
  await dropWithFile(portrait(), importer.getByText("Choose files, or drop them here"))
  await expect(importer.getByRole("tab", { name: TALL.name, exact: true, selected: true })).toBeVisible()
  await expect(page.getByRole("list", { name: "Imported files" })).toHaveCount(0)
  expect(uploads).toEqual([])
})

test("a phone has no drag: a long press on a character is its menu, a tap opens it", async ({
  browser,
  browserName
}) => {
  test.skip(browserName !== "chromium", "Real touch input uses Chromium CDP.")
  const touch = await browser.newContext({ hasTouch: true, viewport: { width: 390, height: 844 } })
  try {
    const page = await touch.newPage()
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(server().url)
    const tile = page.getByLabel("Characters", { exact: true }).getByRole("link", { name: `Open ${TALL.name}` })
    await expect(tile).toBeVisible()
    // What a drag would carry from here: nothing of the app's (a phone has one frame).
    const carried = await tile.evaluate((element) => {
      const data = new DataTransfer()
      element.dispatchEvent(new DragEvent("dragstart", { dataTransfer: data, bubbles: true, cancelable: true }))
      return [...data.types]
    })
    expect(carried.filter((type) => type.startsWith("application/x-rp-"))).toEqual([])
    const box = (await tile.boundingBox())!
    const cdp = await touch.newCDPSession(page)
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }]
    })
    const menu = page.getByRole("menu", { name: `Actions for ${TALL.name}` })
    await expect(menu).toBeVisible()
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
    await shot(page, "phone-long-press-390")
    await expect(menu.getByRole("menuitem", { name: "Open", exact: true })).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(menu).toHaveCount(0)
    await expect(page.locator("[data-frame]")).toHaveCount(1)
    await tile.tap()
    await expect(page).toHaveURL(new RegExp(`/chats/${lantern}|/chats/${harbour}`))
  } finally {
    await touch.close()
  }
})

// A frame's least width (minframe1, 2026-11-24): repeated rightward splits used to halve the
// rightmost frame each time, until its strip clipped the chat panel's toggle and the ⋯ menu. A
// split that would leave a frame narrower than its strip needs is disabled, saying why; a window
// too narrow for the frames it has shows them at their least width and scrolls; a divider stops
// where a frame would go below it.
// SCREENSHOT_DIR saves dark screenshots for the report; LAYOUT_AUDIT audits each surface.
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, type Locator, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { gotoWithLayout } from "./support/workbench.ts"

const server = serverPerFile(withAdmin)
// Headless Chromium hides scrollbars by default; the frames' scrollbar is part of what's tested.
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } })
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)

const shots = process.env.SCREENSHOT_DIR
/** `hovered`: keeps the pointer where it is, to show a hover's explanation. */
const shot = async (page: Page, name: string, hovered = false) => {
  if (!shots) return
  mkdirSync(shots, { recursive: true })
  if (!hovered) await page.mouse.move(0, 0)
  await page.screenshot({ path: join(shots, `${name}.png`) })
}

/** The least width a frame keeps (model.ts `MIN_FRAME_WIDTH`; 320 before the strip's back and forward). */
const MIN_FRAME = 344
const NO_ROOM = "Not enough room to split this pane"

let chat: string

test.beforeAll(async () => {
  chat = await admin((api) =>
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

const fresh = async (page: Page, width: number) => {
  await page.setViewportSize({ width, height: 1000 })
  await page.emulateMedia({ colorScheme: "dark" })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
}

const frames = (page: Page) => page.locator("[data-frame]")

/** Every frame at least its least width, and its strip's buttons whole inside it and the window. */
const expectWholeStrips = async (page: Page) => {
  const viewport = page.viewportSize()!
  const all = await frames(page).all()
  for (const [i, frame] of all.entries()) {
    await frame.scrollIntoViewIfNeeded()
    const box = (await frame.boundingBox())!
    expect(box.width, `frame ${i} width`).toBeGreaterThanOrEqual(MIN_FRAME - 1)
    const strip = frame.locator("[data-tab-strip]")
    const stripBox = (await strip.boundingBox())!
    // The strip's buttons: its back and forward at the start, its actions at the end.
    const buttons = [
      ...(await strip.locator("[data-strip-history] button").all()),
      ...(await strip.locator("[data-strip-actions] button").all())
    ]
    expect(buttons.length, `frame ${i} buttons`).toBeGreaterThanOrEqual(3)
    for (const button of buttons) {
      const b = (await button.boundingBox())!
      const label = (await button.getAttribute("aria-label")) ?? "button"
      expect(b.x, `frame ${i} ${label} left`).toBeGreaterThanOrEqual(stripBox.x - 0.5)
      expect(b.x + b.width, `frame ${i} ${label} right`).toBeLessThanOrEqual(stripBox.x + stripBox.width + 0.5)
      expect(b.x + b.width, `frame ${i} ${label} in window`).toBeLessThanOrEqual(viewport.width + 0.5)
      expect(b.width, `frame ${i} ${label} width`).toBeGreaterThanOrEqual(24)
    }
    // The shown tab keeps room for its title beside the buttons.
    const shownTab = strip.locator("[data-tab]").first()
    expect((await shownTab.boundingBox())!.width, `frame ${i} tab width`).toBeGreaterThanOrEqual(90)
  }
}

/** The rightmost frame's ⋯ menu, opened. */
const openFrameMenu = async (frame: Locator) => {
  await frame.getByRole("button", { name: "Tab and frame actions" }).click()
  return frame.page().getByRole("menu", { name: "Tab and frame actions" })
}

test("repeated rightward splits stop where a frame would get too narrow", async ({ page }) => {
  test.setTimeout(150_000)
  await fresh(page, 1340)
  await page.goto(`${server().url}/chats/${chat}`)
  await expect(page.getByText("The tide is out").first()).toBeVisible()
  // The first split from the header (one frame has no strip yet), then up to five more of the
  // rightmost frame from its ⋯ menu, while it allows them.
  await page.locator("[data-center-header]").getByRole("button", { name: "Split right", exact: true }).click()
  let splits = 1
  await expect(frames(page)).toHaveCount(2)
  for (; splits < 6; splits++) {
    const menu = await openFrameMenu(frames(page).last())
    const item = menu.getByRole("menuitem", { name: "Split right" })
    if (await item.isDisabled()) {
      await page.keyboard.press("Escape")
      break
    }
    await item.click()
    await expect(frames(page)).toHaveCount(splits + 2)
  }
  expect(splits).toBeLessThan(6)
  await expectWholeStrips(page)
  // Split right is disabled, saying why on hover; Split down still has room.
  const menu = await openFrameMenu(frames(page).last())
  const right = menu.getByRole("menuitem", { name: "Split right" })
  await expect(right).toBeDisabled()
  await expect(right).toHaveAttribute("data-explain", NO_ROOM)
  await expect(menu.getByRole("menuitem", { name: "Split down" })).toBeEnabled()
  await right.hover()
  await expect(page.locator("body > *").getByText(NO_ROOM, { exact: true }).last()).toBeVisible()
  await shot(page, "split-menu-disabled-1340-dark", true)
  await page.keyboard.press("Escape")

  // The header's split control in that frame is disabled with the same reason on hover.
  const header = frames(page).last().locator("[data-center-header]")
  const direct = header.getByRole("button", { name: "Split right", exact: true })
  if (await direct.isVisible()) {
    await expect(direct).toBeDisabled()
    await direct.hover()
    await expect(page.getByRole("tooltip")).toContainText(NO_ROOM)
    await shot(page, "header-split-disabled-1340-dark", true)
  } else {
    await header.getByRole("button", { name: "Split", exact: true }).click()
    const item = page.getByRole("menu", { name: "Split" }).getByRole("menuitem", { name: "Split right" })
    await expect(item).toBeDisabled()
    await expect(item).toHaveAttribute("data-explain", NO_ROOM)
    await item.hover()
    await expect(page.locator("body > *").getByText(NO_ROOM, { exact: true }).last()).toBeVisible()
    await shot(page, "header-split-disabled-1340-dark", true)
    await page.keyboard.press("Escape")
  }
  // A tab dragged onto that frame's right edge shows the edge refused, and dropping does nothing.
  const count = await frames(page).count()
  const source = frames(page).first().locator("[data-tab] [role=tab]").first()
  const body = (await frames(page).last().locator("[data-frame-body]").boundingBox())!
  const from = (await source.boundingBox())!
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(body.x + body.width - 20, body.y + body.height / 2, { steps: 12 })
  const refused = frames(page).last().locator("[data-drop-blocked]")
  await expect(refused).toHaveText(NO_ROOM)
  await shot(page, "drag-edge-refused-1340-dark", true)
  await page.mouse.up()
  await expect(frames(page)).toHaveCount(count)
  await expect(refused).toHaveCount(0)
  await shot(page, "splits-stop-1340-dark")
  if (process.env.LAYOUT_AUDIT) await expectLayout(page, test.info(), "minframe-splits-1340")
})

test("a stale layout with a sliver of a frame shows it at its least width, its buttons whole", async ({ page }) => {
  test.setTimeout(120_000)
  for (const width of [1340, 1920, 2560, 3840]) {
    await fresh(page, width)
    // The share six halvings left: 1/64 for the rightmost frame.
    const sizes = [0.5, 0.25, 0.125, 0.0625, 0.03125, 0.015625, 0.015625]
    await gotoWithLayout(page, server().url, `/chats/${chat}`, ["r", sizes, ...sizes.map(() => [0, "="])])
    await expect(frames(page)).toHaveCount(7)
    await expectWholeStrips(page)
    await shot(page, `stale-sliver-${width}-dark`)
    if (process.env.LAYOUT_AUDIT) await expectLayout(page, test.info(), `minframe-stale-${width}`)
  }
})

test("a window narrowed below the frames' least widths scrolls the frames, clipping nothing", async ({ page }) => {
  test.setTimeout(120_000)
  await fresh(page, 1920)
  await gotoWithLayout(page, server().url, `/chats/${chat}`, [
    "r",
    [0.25, 0.25, 0.25, 0.25],
    [0, "="],
    [0, "="],
    [0, "=", "/library"],
    [0, "="]
  ])
  await expect(frames(page)).toHaveCount(4)
  await expectWholeStrips(page)
  await page.setViewportSize({ width: 1340, height: 1000 })
  await expectWholeStrips(page)
  // Nothing outside the frames scrolls the page itself.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
  // The row scrolls, with a scrollbar that takes room (a track), not one drawn over the frames.
  const center = page.locator("[data-workbench]")
  expect(await center.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)
  expect(await center.evaluate((el: HTMLElement) => el.offsetHeight - el.clientHeight)).toBeGreaterThanOrEqual(8)

  // A tab moved to a frame partly out of view scrolls that frame into view.
  await center.evaluate((el) => el.scrollTo({ left: 0 }))
  const last = frames(page).last()
  expect((await last.boundingBox())!.x + (await last.boundingBox())!.width).toBeGreaterThan(1340)
  await frames(page)
    .nth(2)
    .getByRole("tab", { name: /Library/ })
    .click({ button: "right" })
  await page.getByRole("menuitem", { name: "Move to the frame on the right" }).click()
  await expect(last.getByRole("tab", { name: /Library/ })).toBeVisible()
  await expect
    .poll(async () => {
      const box = (await last.boundingBox())!
      return box.x + box.width
    })
    .toBeLessThanOrEqual(1340.5)
  await center.evaluate((el) => el.scrollTo({ left: el.scrollWidth / 2 }))
  await shot(page, "narrowed-1340-dark")
  if (process.env.LAYOUT_AUDIT) await expectLayout(page, test.info(), "minframe-narrowed-1340")
})

test("a divider stops where a frame would go below its least width", async ({ page }) => {
  test.setTimeout(90_000)
  await fresh(page, 1920)
  await gotoWithLayout(page, server().url, `/chats/${chat}`, ["r", [0.5, 0.5], [0, "="], [0, "="]])
  await expect(frames(page)).toHaveCount(2)
  const handle = page.getByRole("separator", { name: "Resize frames side by side" })
  const box = (await handle.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + 2000, box.y + box.height / 2, { steps: 10 })
  await page.mouse.up()
  expect((await frames(page).last().boundingBox())!.width).toBeGreaterThanOrEqual(MIN_FRAME - 1)
  await page.mouse.move(box.x - 3000, box.y + box.height / 2)
  const again = (await handle.boundingBox())!
  await page.mouse.move(again.x + again.width / 2, again.y + again.height / 2)
  await page.mouse.down()
  await page.mouse.move(0, box.y + box.height / 2, { steps: 10 })
  await page.mouse.up()
  expect((await frames(page).first().boundingBox())!.width).toBeGreaterThanOrEqual(MIN_FRAME - 1)
  await expectWholeStrips(page)
})

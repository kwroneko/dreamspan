// The picture controls and the image viewer (owner, 2026-11-02): every editable portrait (a
// character's and the persona's tab, the full editor's header and its Metadata picture) opens
// its whole image on a click and has one Picture button over its lower-right corner, the same
// everywhere; the persona's badge says "You". The viewer zooms with the wheel about the
// cursor, pans by dragging inside a fixed box (no scrollbars, never dragged out of view), has
// one toolbar row (slider, percentage, Fit, 100%), switches between the fit and 100% on a
// double click or double tap, and pinches about the fingers' centre on a touch screen (CDP
// touch events). VIEWER_SHOTS=<dir> saves screenshots. Every card here is made up.
import { join } from "node:path"
import { expect, type Locator, type Page, test } from "@playwright/test"
import type { EntityId } from "@rp/shared/chat.ts"
import { cardFieldsTab } from "./support/cardEditor.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { shapeCard } from "./support/shapes.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "200" })
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
test.setTimeout(180_000)
const shots = process.env.VIEWER_SHOTS
const shoot = async (page: Page, name: string) => {
  if (shots) await page.screenshot({ animations: "disabled", path: join(shots, `${name}.png`) })
}

const TALL = { name: "Tall", width: 1024, height: 1536 }
const PERSONA = { name: "Juniper", width: 400, height: 600 }

let chat = ""
let refs: Record<string, { id: string; entityId: EntityId }> = {}
test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage()
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const post = async (name: string, data: Buffer) => {
    const response = await page.request.post(`${server().url}/library/import?name=${name}`, {
      data,
      headers: { origin: server().url, "content-type": "application/octet-stream" }
    })
    expect(response.ok()).toBeTruthy()
  }
  await post("Tall.png", shapeCard(TALL, 0))
  await post("Juniper.png", shapeCard(PERSONA, 120))
  await post(
    "bare.json",
    Buffer.from(
      JSON.stringify({ spec: "chara_card_v2", spec_version: "2.0", data: { name: "Bare", first_mes: "Hi." } })
    )
  )
  await page.close()
  const list = await admin((api) => api.ListLibrary({ kind: "card" }))
  refs = Object.fromEntries(
    list.map((ref) => [ref.label, { id: ref.id as string, entityId: ref.entityId as EntityId }])
  )
  await admin((api) => api.SetPersona({ entityId: refs.Juniper!.entityId, persona: true }))
  const started = await admin((api) =>
    api.StartChat({
      cards: [refs.Tall!.entityId],
      persona: refs.Juniper!.entityId,
      greeting: null,
      first: { _tag: "Send", content: "Is anyone here?", speakerEntityId: null }
    })
  )
  chat = started.chat.id
})

const openChat = async (page: Page, panel?: string) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chat}${panel ? `?panel=${encodeURIComponent(panel)}` : ""}`)
}

/** The portrait's box and its controls: exactly one, Picture, in the lower-right corner. */
const expectOnePictureButton = async (portrait: Locator) => {
  await expect(portrait).toBeVisible()
  const buttons = portrait.locator("[data-portrait-controls] button")
  await expect(buttons).toHaveCount(1)
  await expect(buttons).toHaveAccessibleName("Picture")
  const area = (await portrait.boundingBox())!
  const at = (await buttons.boundingBox())!
  expect(at.x + at.width).toBeLessThanOrEqual(area.x + area.width + 0.5)
  expect(area.x + area.width - (at.x + at.width)).toBeLessThan(10)
  expect(at.y + at.height).toBeLessThanOrEqual(area.y + area.height + 0.5)
  expect(area.y + area.height - (at.y + at.height)).toBeLessThan(10)
  return { area, at }
}

test("every editable portrait: one Picture button lower right, a click opens the picture", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  // A character's tab, in the chat: the click opens it in the column beside the chat.
  await openChat(page, `card:${refs.Tall!.entityId}`)
  const tab = page.getByRole("tabpanel", { name: "Tall" })
  const tallPortrait = tab.locator("[data-card-header-portrait]")
  const tallBox = await expectOnePictureButton(tallPortrait)
  await expect(tab.getByText("You", { exact: true })).toHaveCount(0)
  await tab.getByRole("button", { name: "View Tall's picture", exact: true }).click()
  await expect(page.getByRole("complementary", { name: "Tall's portrait", exact: true })).toBeVisible()
  // A click opens, never replaces: no dialog, no file chooser.
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await page.getByRole("button", { name: "Close the portrait" }).click()

  // The persona's tab: the same button in the same place, with the "You" badge.
  await openChat(page, `card:${refs.Juniper!.entityId}`)
  const personaTab = page.getByRole("tabpanel", { name: "Juniper" })
  const personaPortrait = personaTab.locator("[data-card-header-portrait]")
  const personaBox = await expectOnePictureButton(personaPortrait)
  expect(Math.abs(personaBox.area.width - personaBox.at.x - (tallBox.area.width - tallBox.at.x))).toBeLessThan(1)
  await expect(personaPortrait.getByText("You", { exact: true })).toBeVisible()
  await expect(personaPortrait.getByText("You play", { exact: true })).toHaveCount(0)
  // Badge and button don't overlap.
  const badge = (await personaPortrait.getByText("You", { exact: true }).boundingBox())!
  expect(badge.x + badge.width).toBeLessThan(personaBox.at.x)
  await shoot(page, "persona-tab")
  // Hover shows the explanation; no camera badge or dot over the picture.
  await personaTab.getByRole("button", { name: "View Juniper's picture", exact: true }).hover()
  await expect(page.getByText("View the whole picture", { exact: true })).toBeVisible()
  await expect(personaPortrait.locator("svg")).toHaveCount(1)
  await personaTab.getByRole("button", { name: "View Juniper's picture", exact: true }).click()
  await expect(page.getByRole("complementary", { name: "Juniper's portrait", exact: true })).toBeVisible()

  // The full editor's own page: header and Metadata both, a click opening a full-screen viewer.
  await page.goto(`${server().url}/library/${refs.Tall!.id}`)
  const header = page.locator("[data-card-header-portrait]")
  await expectOnePictureButton(header)
  await header.getByRole("button", { name: "View Tall's picture", exact: true }).click()
  const screen = page.getByRole("dialog", { name: "Tall", exact: true })
  await expect(screen.getByRole("img", { name: "Tall's full portrait" })).toBeVisible()
  await screen.getByRole("button", { name: "Close", exact: true }).click()
  await expect(screen).toHaveCount(0)
  const metadata = await cardFieldsTab(page, "Metadata")
  const large = metadata.getByRole("region", { name: "Picture" }).locator("[data-portrait-controls]").locator("..")
  await expectOnePictureButton(large)
  await shoot(page, "editor-metadata")

  // A card without a picture: the same button (it adds one), and nothing to view.
  await page.goto(`${server().url}/library/${refs.Bare!.id}`)
  const bare = page.locator("[data-card-header-portrait]")
  await expectOnePictureButton(bare)
  await expect(bare.getByRole("button", { name: "View Bare's picture" })).toHaveCount(0)
  await bare.getByRole("button", { name: "Picture", exact: true }).hover()
  await expect(page.getByText(/^Picture: add one\./)).toBeVisible()
})

/** The image's rect and its box's, in page pixels. */
const geometry = async (region: Locator) => {
  const image = region.locator("[data-image-viewer] img:not([aria-hidden])")
  await expect
    .poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
    .toBeGreaterThan(0)
  return image.evaluate((img) => {
    const box = img.closest("[data-image-viewer]")!.getBoundingClientRect()
    const rect = img.getBoundingClientRect()
    return {
      image: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      box: { x: box.x, y: box.y, width: box.width, height: box.height }
    }
  })
}
/** The fraction of the image under a page point. */
const fractionAt = (g: Awaited<ReturnType<typeof geometry>>, x: number, y: number) => ({
  x: (x - g.image.x) / g.image.width,
  y: (y - g.image.y) / g.image.height
})

test("the side viewer: wheel zoom at the cursor, drag pan within bounds, slider, Fit, 100%, double click", async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await openChat(page, `card:${refs.Tall!.entityId}`)
  await page
    .getByRole("tabpanel", { name: "Tall" })
    .getByRole("button", { name: "View Tall's picture", exact: true })
    .click()
  const column = page.getByRole("complementary", { name: "Tall's portrait", exact: true })
  const viewer = column.locator("[data-image-viewer]")
  await expect(viewer).toHaveAttribute("data-zoom", "fit")
  const toolbar = column.locator("[data-portrait-toolbar]")
  const percent = toolbar.locator("[data-zoom-percent]")

  // Beside the side panel the column is narrow: the zoom has its own row, inside the column.
  const columnBox = (await column.boundingBox())!
  const controlsBox = (await toolbar.locator("[data-zoom-controls]").boundingBox())!
  expect(controlsBox.x + controlsBox.width).toBeLessThanOrEqual(columnBox.x + columnBox.width + 0.5)
  await shoot(page, "column-narrow")
  await page.getByRole("button", { name: "Hide panel" }).click()
  await expect.poll(async () => (await column.boundingBox())!.width).toBeGreaterThan(400)
  // Wide: one aligned row: slider, percentage, Fit, 100%, then the column's own buttons.
  const slider = toolbar.getByRole("slider", { name: "Zoom" })
  const fit = toolbar.getByRole("button", { name: "Fit", exact: true })
  const actual = toolbar.getByRole("button", { name: "100%", exact: true })
  const sliderBox = toolbar.locator("[data-toolbar-slider]")
  const centres = await Promise.all(
    [sliderBox, percent, fit, actual, toolbar.getByRole("button", { name: "Close the portrait" })].map(async (item) => {
      const b = (await item.boundingBox())!
      return b.y + b.height / 2
    })
  )
  expect(Math.max(...centres) - Math.min(...centres)).toBeLessThanOrEqual(1.5)
  await expect(viewer).toHaveAttribute("data-zoom", "fit")
  const fitted = await geometry(column)
  const fitPercent = await percent.textContent()
  // No scrollbars: the box hides what's outside it.
  expect(await viewer.evaluate((node) => getComputedStyle(node).overflow)).toBe("hidden")
  // Each has its explanation.
  for (const [control, text] of [
    [fit, "Fit: show all of the picture"],
    [actual, "100%: one pixel of the picture to one pixel of the screen"],
    [percent, /^Shown at \d+% of its own size, 1024 × 1536 pixels$/]
  ] as const) {
    await control.hover()
    await expect(page.getByText(text)).toBeVisible()
  }
  await shoot(page, "column-fit")

  // The wheel zooms about the cursor, and the page doesn't scroll.
  const at = { x: fitted.image.x + fitted.image.width * 0.3, y: fitted.image.y + fitted.image.height * 0.25 }
  const under = fractionAt(fitted, at.x, at.y)
  const scrolled = () =>
    page.evaluate(() => [
      window.scrollY,
      document.querySelector("[data-portrait-column] > div.overflow-y-auto")?.scrollTop ?? 0
    ])
  const before = await scrolled()
  await page.mouse.move(at.x, at.y)
  for (let i = 0; i < 3; i++) await page.mouse.wheel(0, -200)
  await expect(viewer).toHaveAttribute("data-zoom", "scaled")
  await expect.poll(async () => (await geometry(column)).image.width).toBeGreaterThan(fitted.image.width * 1.5)
  const zoomed = await geometry(column)
  const still = fractionAt(zoomed, at.x, at.y)
  expect(Math.abs(still.x - under.x)).toBeLessThan(0.01)
  expect(Math.abs(still.y - under.y)).toBeLessThan(0.01)
  expect(await scrolled()).toEqual(before)
  await expect(percent).not.toHaveText(fitPercent!)
  // The slider follows the zoom.
  await expect(slider).toHaveAttribute("aria-valuetext", (await percent.textContent())!)

  // Dragging pans by as much as the pointer moved, with a grab cursor.
  expect(await viewer.evaluate((node) => getComputedStyle(node).cursor)).toBe("grab")
  await page.mouse.move(at.x, at.y)
  await page.mouse.down()
  await page.mouse.move(at.x + 40, at.y + 60, { steps: 4 })
  expect(await viewer.evaluate((node) => getComputedStyle(node).cursor)).toBe("grabbing")
  await page.mouse.up()
  const panned = await geometry(column)
  expect(panned.image.x - zoomed.image.x).toBeCloseTo(40, 0)
  expect(panned.image.y - zoomed.image.y).toBeCloseTo(60, 0)
  // Never out of view: dragged far, the image's edge stops at the box's.
  await page.mouse.move(at.x, at.y)
  await page.mouse.down()
  await page.mouse.move(at.x + 3000, at.y + 3000, { steps: 6 })
  await page.mouse.up()
  const far = await geometry(column)
  expect(Math.abs(far.image.x - far.box.x)).toBeLessThan(1)
  expect(Math.abs(far.image.y - far.box.y)).toBeLessThan(1)
  await page.mouse.move(at.x, at.y)
  await page.mouse.down()
  await page.mouse.move(at.x - 6000, at.y - 6000, { steps: 6 })
  await page.mouse.up()
  const other = await geometry(column)
  expect(Math.abs(other.image.x + other.image.width - (other.box.x + other.box.width))).toBeLessThan(1)
  expect(Math.abs(other.image.y + other.image.height - (other.box.y + other.box.height))).toBeLessThan(1)

  // The slider: its top end is 800%, its low end the fit.
  await slider.focus()
  await page.keyboard.press("End")
  await expect(percent).toHaveText("800%")
  await expect.poll(async () => (await geometry(column)).image.width).toBeCloseTo(1024 * 8, -1)
  await page.keyboard.press("Home")
  await expect(viewer).toHaveAttribute("data-zoom", "fit")
  await expect(percent).toHaveText(fitPercent!)
  // A click on the track's middle zooms in between.
  const track = (await sliderBox.boundingBox())!
  await page.mouse.click(track.x + track.width / 2, track.y + track.height / 2)
  await expect(viewer).toHaveAttribute("data-zoom", "scaled")

  // Fit and 100%.
  await actual.click()
  await expect(percent).toHaveText("100%")
  await expect(actual).toHaveAttribute("aria-pressed", "true")
  await expect.poll(async () => (await geometry(column)).image.width).toBeCloseTo(1024, 0)
  await shoot(page, "column-100")
  await fit.click()
  await expect(viewer).toHaveAttribute("data-zoom", "fit")
  await expect(fit).toHaveAttribute("aria-pressed", "true")

  // Double click: to 100% at the pointer, and back to the fit.
  const box = (await viewer.boundingBox())!
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 3)
  await expect(percent).toHaveText("100%")
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 3)
  await expect(viewer).toHaveAttribute("data-zoom", "fit")
  // Fitted, there's nothing to pan: no grab cursor.
  expect(await viewer.evaluate((node) => getComputedStyle(node).cursor)).not.toBe("grab")
})

test("at 390 by touch: pinch about the fingers' centre, one finger pans, double tap toggles", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await openChat(page, `card:${refs.Tall!.entityId}`)
  await page
    .getByRole("tabpanel", { name: "Tall" })
    .getByRole("button", { name: "View Tall's picture", exact: true })
    .click()
  const screen = page.getByRole("dialog", { name: "Tall", exact: true })
  const viewer = screen.locator("[data-image-viewer]")
  await expect(viewer).toHaveAttribute("data-zoom", "fit")
  const fitted = await geometry(screen)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 })
  const touch = (type: "touchStart" | "touchMove" | "touchEnd", points: ReadonlyArray<{ x: number; y: number }>) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: points.map((point, id) => ({ x: point.x, y: point.y, id }))
    })

  // A pinch spreading about a point: it enlarges, the point under the fingers' centre staying.
  const centre = { x: fitted.box.x + fitted.box.width / 2, y: fitted.box.y + fitted.box.height * 0.4 }
  const under = fractionAt(fitted, centre.x, centre.y)
  await touch("touchStart", [
    { x: centre.x - 30, y: centre.y },
    { x: centre.x + 30, y: centre.y }
  ])
  for (let step = 1; step <= 8; step++)
    await touch("touchMove", [
      { x: centre.x - 30 - step * 10, y: centre.y },
      { x: centre.x + 30 + step * 10, y: centre.y }
    ])
  await touch("touchEnd", [])
  await expect(viewer).toHaveAttribute("data-zoom", "scaled")
  const pinched = await geometry(screen)
  expect(pinched.image.width).toBeGreaterThan(fitted.image.width * 2)
  const kept = fractionAt(pinched, centre.x, centre.y)
  expect(Math.abs(kept.x - under.x)).toBeLessThan(0.02)
  expect(Math.abs(kept.y - under.y)).toBeLessThan(0.02)

  // One finger pans.
  await touch("touchStart", [centre])
  for (let step = 1; step <= 5; step++) await touch("touchMove", [{ x: centre.x - step * 10, y: centre.y - step * 10 }])
  await touch("touchEnd", [])
  const panned = await geometry(screen)
  expect(panned.image.x - pinched.image.x).toBeCloseTo(-50, 0)
  expect(panned.image.y - pinched.image.y).toBeCloseTo(-50, 0)

  // A double tap: back to the fit, and again to 100%.
  const tap = async () => {
    await touch("touchStart", [centre])
    await touch("touchEnd", [])
  }
  await page.waitForTimeout(400)
  await tap()
  await tap()
  await expect(viewer).toHaveAttribute("data-zoom", "fit")
  await page.waitForTimeout(400)
  await tap()
  await tap()
  await expect(screen.locator("[data-zoom-percent]")).toHaveText("100%")
  await shoot(page, "phone-100")
  // The toolbar's row stays on the screen at a phone's width.
  const row = (await screen.locator("[data-portrait-toolbar]").boundingBox())!
  expect(row.x + row.width).toBeLessThanOrEqual(390)
})

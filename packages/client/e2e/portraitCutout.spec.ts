// A portrait's cutout (ARCHITECTURE.md §14.5c): setting a new picture opens the cutout chooser
// before it's saved, the Picture button's dialog chooses again later and replaces the picture,
// every small portrait follows the cutout (its URL names it), and the full-image viewer still
// shows the whole original. A click on the portrait opens it (owner, 2026-11-02). At 1440 with a mouse and the keyboard,
// at 390 with touch. CUTOUT_SHOTS=<dir> saves the chooser's screenshots in both themes.
import { join } from "node:path"
import { expect, type Locator, type Page, test } from "@playwright/test"
import { openPanel } from "./support/panel.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { SHAPES, shapeCard } from "./support/shapes.ts"
import { cardFieldsTab } from "./support/cardEditor.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "200", FAKE_GENERATOR_TOKENS: "20" })
test.setTimeout(240_000)
const shots = process.env.CUTOUT_SHOTS

const shoot = async (page: Page, name: string) => {
  if (!shots) return
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme })
    await page.screenshot({ animations: "disabled", path: join(shots, `${name}-${colorScheme}.png`) })
  }
  await page.emulateMedia({ colorScheme: "light" })
}

const tall = SHAPES.find((shape) => shape.name === "Tall")!
const wide = SHAPES.find((shape) => shape.name === "Wide")!
const file = (name: string, bytes: Buffer) => ({ name, mimeType: "image/png", buffer: bytes })

let setup: Promise<{ refId: string; chat: string }> | null = null
/** Tall's card (its editor's ref) and a chat with it, a greeting and a reply on screen. */
const open = async (page: Page) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  return (setup ??= (async () => {
    const response = await page.request.post(`${server().url}/library/import?name=Tall.png`, {
      data: shapeCard(tall, 0),
      headers: { origin: server().url, "content-type": "application/octet-stream" }
    })
    expect(response.ok()).toBeTruthy()
    const refId = ((await response.json()) as { library: { ref: { id: string } } }).library.ref.id
    await page.goto(`${server().url}/library`)
    await page.getByRole("link", { name: "Start a chat with Tall" }).click()
    await page.getByLabel("Message", { exact: true }).fill("Hello there.")
    await page.getByRole("button", { name: "Send", exact: true }).click()
    await expect(page).toHaveURL(/\/chats\//)
    await expect(page.locator("article[data-slot]")).toHaveCount(3)
    await expect(page.getByText("generating", { exact: true })).toHaveCount(0)
    return { refId, chat: new URL(page.url()).pathname }
  })())
}

/** The cutout and media a portrait image's URL names. */
const named = async (image: Locator) => {
  await expect(image).toHaveAttribute("src", /crop=/)
  const url = new URL((await image.getAttribute("src"))!, "http://x")
  return { id: url.searchParams.get("id")!, crop: url.searchParams.get("crop")!, width: url.searchParams.get("w") }
}

/** Every image of `mediaId` on the page asks for the cutout `crop` (the viewer's original aside). */
const expectEveryPortrait = async (page: Page, mediaId: string, crop: string, least = 1) => {
  const images = page.locator(`[data-portrait] img[src*="id=${mediaId}"]`)
  await expect.poll(() => images.count()).toBeGreaterThanOrEqual(least)
  for (const src of await images.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("src")!))) {
    expect(new URL(src, "http://x").searchParams.get("crop")).toBe(crop)
  }
}

const boxOf = async (dialog: Locator) => (await dialog.locator("[data-cutout-box]").boundingBox())!
const stageOf = async (dialog: Locator) => (await dialog.locator("[data-cutout-stage]").boundingBox())!

/** Preview pixels use the app's portrait sizes; all three follow the same live crop. */
const expectPreviews = async (dialog: Locator, phone: boolean) => {
  const previews = dialog.getByRole("region", { name: "Previews" })
  await expect(previews.getByRole("heading", { name: "Previews" })).toBeVisible()
  for (const label of ["Message", "Cast", "Tile"]) {
    await expect(previews.getByText(label, { exact: true })).toBeVisible()
    await expect(previews.locator(`[data-cutout-preview="${label}"] img`)).toBeVisible()
  }
  const message = (await dialog.locator('[data-cutout-preview="Message"]').boundingBox())!
  const cast = (await dialog.locator('[data-cutout-preview="Cast"]').boundingBox())!
  const tile = (await dialog.locator('[data-cutout-preview="Tile"]').boundingBox())!
  const portraitWidth = await dialog.evaluate(
    (node) => Number.parseFloat(getComputedStyle(node).getPropertyValue("--chat-portrait-width")) || 60
  )
  expect(message.width).toBeCloseTo(portraitWidth, 0)
  expect(message.height).toBeCloseTo(portraitWidth * 1.5, 0)
  expect(cast.width).toBeCloseTo(18.667, 1)
  expect(cast.height).toBe(28)
  expect(tile.width).toBe(134)
  expect(tile.height).toBe(201)
  const stage = await stageOf(dialog)
  if (phone) {
    expect(message.y).toBeGreaterThan(stage.y + stage.height)
    expect(cast.y).toBeCloseTo(message.y, 0)
    expect(tile.y).toBeCloseTo(message.y, 0)
  } else {
    expect(message.x).toBeGreaterThan(stage.x + stage.width)
  }
}

const expectLivePreviews = async (dialog: Locator) => {
  const box = await boxOf(dialog)
  const stage = await stageOf(dialog)
  const styles = await dialog.locator("[data-cutout-preview] img").evaluateAll((images) =>
    images.map((image) => ({
      width: (image as HTMLImageElement).style.width,
      left: (image as HTMLImageElement).style.left
    }))
  )
  expect(styles).toHaveLength(3)
  for (const style of styles) {
    expect(Number.parseFloat(style.width)).toBeCloseTo((stage.width / box.width) * 100, 0)
    expect(Number.parseFloat(style.left)).toBeCloseTo(-((box.x - stage.x) / box.width) * 100, 0)
  }
}

test("at 1440: a new picture is cut out before it's saved, adjusted later, and every portrait follows", async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const { refId, chat } = await open(page)

  // The editor: a new picture (wide) opens the chooser, the box over the whole image at 2:3.
  await page.goto(`${server().url}/library/${refId}`)
  await cardFieldsTab(page, "Metadata")
  await page.getByLabel("Choose an avatar, or drop it here").setInputFiles(file("wide.png", shapeCard(wide, 80)))
  const chooser = page.getByRole("dialog", { name: "Tall's new picture" })
  await expect(chooser).toBeVisible()
  await expect(chooser.locator("[data-cutout-box]")).toBeVisible()
  await chooser.getByRole("button", { name: "Portrait", exact: true }).click()
  const stage = await stageOf(chooser)
  let box = await boxOf(chooser)
  // The default for a wide image: the full height, in the middle.
  expect(Math.abs(box.height - stage.height)).toBeLessThan(3)
  expect(Math.abs(box.x + box.width / 2 - (stage.x + stage.width / 2))).toBeLessThan(3)
  expect(box.width / box.height).toBeCloseTo(2 / 3, 1)
  await expectPreviews(chooser, false)
  await expect(chooser.getByText("The whole image is kept.", { exact: false })).toHaveCount(0)
  await shoot(page, "chooser-desktop")

  // The shared toolbar slider continuously changes the box, reaching both limits.
  const size = chooser.getByRole("slider", { name: "Cutout size", exact: true })
  const largestSize = Number(await size.getAttribute("aria-valuenow"))
  const track = (await chooser.locator("[data-toolbar-slider]").boundingBox())!
  await page.mouse.move(track.x + track.width - 1, track.y + track.height / 2)
  await page.mouse.down()
  await page.mouse.move(track.x + track.width / 2, track.y + track.height / 2, { steps: 8 })
  // Previews follow before the pointer is released.
  expect((await boxOf(chooser)).width).toBeLessThan(box.width * 0.7)
  await expectLivePreviews(chooser)
  await page.mouse.up()
  await size.focus()
  await page.keyboard.press("Home")
  expect((await boxOf(chooser)).width).toBeCloseTo(box.width / 20, 0)
  await page.keyboard.press("End")
  expect((await boxOf(chooser)).width).toBeCloseTo(box.width, 0)
  await page.keyboard.press("Home")
  const reset = chooser.getByRole("button", { name: "Reset the cutout", exact: true })
  await reset.hover()
  await expect(page.getByText("Reset the portrait inside the picture", { exact: true }).last()).toBeVisible()
  await reset.click()
  expect((await boxOf(chooser)).width).toBeCloseTo(box.width, 0)
  expect((await boxOf(chooser)).x).toBeCloseTo(box.x, 0)

  // A mouse drags it left, and a corner makes it smaller, staying 2:3.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 - 120, box.y + box.height / 2, { steps: 6 })
  await page.mouse.up()
  const moved = await boxOf(chooser)
  expect(moved.x).toBeLessThan(box.x - 100)
  const corner = (await chooser.locator('[data-cutout-corner="se"]').boundingBox())!
  await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2)
  await page.mouse.down()
  await page.mouse.move(corner.x - 60, corner.y - 90, { steps: 6 })
  await page.mouse.up()
  box = await boxOf(chooser)
  expect(box.width).toBeLessThan(moved.width - 30)
  expect(box.width / box.height).toBeCloseTo(2 / 3, 1)
  await expectLivePreviews(chooser)
  const cornerValue = Number(await size.getAttribute("aria-valuenow"))
  expect(cornerValue).toBeLessThan(largestSize)
  expect(cornerValue / largestSize).toBeCloseTo(box.width / moved.width, 2)
  // The keyboard moves and resizes the box and keeps the size slider in sync.
  await chooser.locator("[data-cutout-box]").focus()
  await page.keyboard.press("ArrowDown")
  await page.keyboard.press("ArrowRight")
  const keyed = await boxOf(chooser)
  expect(keyed.y).toBeGreaterThan(box.y)
  expect(keyed.x).toBeGreaterThan(box.x)
  await page.keyboard.press("-")
  expect((await boxOf(chooser)).width).toBeLessThan(keyed.width)
  const smaller = Number(await size.getAttribute("aria-valuenow"))
  expect(smaller).toBeLessThan(cornerValue)
  await page.keyboard.press("+")
  expect((await boxOf(chooser)).width).toBeCloseTo(keyed.width, 0)
  expect(Number(await size.getAttribute("aria-valuenow"))).toBeGreaterThan(smaller)
  await chooser.getByRole("button", { name: "About cutout controls" }).hover()
  await expect(
    page
      .getByText("Drag the box to move it, or a corner to resize it. Arrow keys move it; + and − resize it.")
      .last()
  ).toBeVisible()
  await chooser.getByRole("button", { name: "Save picture" }).click()
  await expect(chooser).toHaveCount(0)

  // The editor's portrait shows the cutout chosen; the Picture button opens the original whole.
  const portrait = page.getByRole("tabpanel", { name: "Metadata" }).locator("[data-view-portrait] img")
  const first = await named(portrait)
  expect(first.crop).not.toBe("auto")
  await page.getByRole("tabpanel", { name: "Metadata" }).getByRole("button", { name: "Picture", exact: true }).click()
  const adjust = page.getByRole("dialog", { name: "Tall's picture" })
  await expect(adjust).toBeVisible()
  const original = new URL(
    (await adjust.getByRole("img", { name: "Tall's whole image" }).getAttribute("src"))!,
    "http://x"
  )
  expect(original.searchParams.get("w")).toBeNull()
  expect(original.searchParams.get("crop")).toBeNull()
  await adjust.getByRole("button", { name: "Portrait", exact: true }).click()
  // It starts where it was saved.
  await expect.poll(async () => (await boxOf(adjust)).width < (await stageOf(adjust)).width * 0.4).toBe(true)
  await adjust.locator("[data-cutout-box]").focus()
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowLeft")
  await adjust.getByRole("button", { name: "Save cutout" }).click()
  await expect(adjust).toHaveCount(0)
  await expect.poll(async () => (await named(portrait)).crop).not.toBe(first.crop)
  const second = await named(portrait)
  expect(second.id).toBe(first.id)

  // Every small portrait follows: messages, the cast, the cast strip, the header, the sidebar,
  // the library and the home grid.
  await page.goto(`${server().url}${chat}`)
  await expect(page.locator("article[data-slot]").first()).toBeVisible()
  await expectEveryPortrait(page, second.id, second.crop, 2)
  const cast = await openPanel(page, "Cast")
  await expect(cast.getByRole("button", { name: "View Tall's portrait" })).toBeVisible()
  await expectEveryPortrait(page, second.id, second.crop, 4)
  await page.goto(`${server().url}/library`)
  await expectEveryPortrait(page, second.id, second.crop)
  await page.goto(`${server().url}/`)
  await expectEveryPortrait(page, second.id, second.crop)

  // The viewer still shows the whole original.
  await page.goto(`${server().url}${chat}`)
  await page.locator("article[data-slot]").first().getByRole("button", { name: "View Tall's portrait" }).click()
  const full = page.getByRole("img", { name: "Tall's full portrait" })
  await expect.poll(() => full.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(wide.width)
  expect(await full.evaluate((img: HTMLImageElement) => img.naturalHeight)).toBe(wide.height)
  await page.getByRole("button", { name: "Close the portrait" }).click()

  // The character tab: the portrait says what a click does; the one Picture button replaces the
  // picture from its dialog, going straight to the new picture's cutout.
  await openPanel(page, "Tall")
  const tab = page.getByRole("tabpanel", { name: "Tall" })
  const view = tab.getByRole("button", { name: "View Tall's picture" })
  await view.hover()
  await expect(page.getByText("View the whole picture", { exact: true })).toBeVisible()
  await shoot(page, "tab-portrait-desktop")
  const pictureButton = tab.getByRole("button", { name: "Picture", exact: true })
  await pictureButton.hover()
  await expect(
    page.getByText("Picture: crop the picture and small portrait, or replace the picture", { exact: true })
  ).toBeVisible()
  await pictureButton.click()
  const pictureDialog = page.getByRole("dialog", { name: "Tall's picture" })
  await expect(pictureDialog.locator("[data-cutout-box]")).toBeVisible()
  // Closed without a decision: its X in the corner.
  await expect(pictureDialog.getByRole("button", { name: "Close", exact: true })).toBeVisible()
  const replace = (await pictureDialog.getByRole("button", { name: "Replace picture…" }).boundingBox())!
  const cancel = (await pictureDialog.getByRole("button", { name: "Cancel", exact: true }).boundingBox())!
  expect(replace.x).toBeLessThan(cancel.x)
  expect(replace.y).toBe(cancel.y)
  await shoot(page, "picture-dialog-desktop")
  const picked = page.waitForEvent("filechooser")
  await pictureDialog.getByRole("button", { name: "Replace picture…" }).click()
  await (await picked).setFiles(file("tall.png", shapeCard(tall, 120)))
  const fromTab = page.getByRole("dialog", { name: "Tall's new picture" })
  await expect(fromTab.locator("[data-cutout-box]")).toBeVisible()
  await fromTab.getByRole("button", { name: "Save picture" }).click()
  await expect(fromTab).toHaveCount(0)
  await expect(pictureDialog).toHaveCount(0)
  await expect.poll(async () => (await named(tab.locator("[data-view-portrait] img"))).id).not.toBe(second.id)
  // A 2:3 image's default is all of it.
  expect((await named(tab.locator("[data-view-portrait] img"))).crop).toBe("0_0_10000_10000")
  await expectEveryPortrait(page, (await named(tab.locator("[data-view-portrait] img"))).id, "0_0_10000_10000", 2)
  // A click on the portrait opens the column; clicking a picture never replaces it.
  await view.click()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(page.getByRole("complementary", { name: "Tall's portrait", exact: true })).toBeVisible()
})

test("at 390: the chooser fits a phone, drags by touch, and follows the blur setting", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const { refId } = await open(page)
  await page.goto(`${server().url}/library/${refId}`)
  await cardFieldsTab(page, "Metadata")
  await page.getByLabel("Choose an avatar, or drop it here").setInputFiles(file("wide.png", shapeCard(wide, 160)))
  const chooser = page.getByRole("dialog", { name: "Tall's new picture" })
  await expect(chooser.locator("[data-cutout-box]")).toBeVisible()
  const dialog = (await chooser.boundingBox())!
  expect(dialog.x).toBeGreaterThanOrEqual(0)
  expect(dialog.x + dialog.width).toBeLessThanOrEqual(390)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await expect(chooser.getByRole("button", { name: "Save picture" })).toBeInViewport()
  await chooser.getByRole("button", { name: "Portrait", exact: true }).click()
  await expectPreviews(chooser, true)
  await shoot(page, "chooser-phone")

  // One finger drags the box to the left edge.
  const before = await boxOf(chooser)
  await chooser.locator("[data-cutout-box]").evaluate(async (node) => {
    const rect = node.getBoundingClientRect()
    const x = rect.left + rect.width / 2,
      y = rect.top + rect.height / 2
    const send = (type: string, dx: number) =>
      node.dispatchEvent(
        new PointerEvent(type, {
          pointerId: 21,
          pointerType: "touch",
          clientX: x + dx,
          clientY: y,
          button: 0,
          bubbles: true,
          isPrimary: true
        })
      )
    send("pointerdown", 0)
    for (let step = 1; step <= 10; step++) {
      send("pointermove", -step * 30)
      await new Promise((done) => requestAnimationFrame(done))
    }
    send("pointerup", -300)
  })
  const after = await boxOf(chooser)
  const stage = await stageOf(chooser)
  await expectLivePreviews(chooser)
  expect(after.x).toBeLessThan(before.x - 20)
  expect(Math.abs(after.x - stage.x)).toBeLessThan(3)
  // A slow upload must not widen Save and wrap the footer under the pointer.
  let finishUpload: (() => void) | undefined
  const upload = new Promise<void>((resolve) => {
    finishUpload = resolve
  })
  await page.route(
    "**/library/avatar?*",
    async (route) => {
      await upload
      await route.continue()
    },
    { times: 1 }
  )
  const save = chooser.getByRole("button", { name: "Save picture" })
  const saveBefore = await save.boundingBox()
  const dialogBefore = await chooser.boundingBox()
  await save.click()
  try {
    await expect(save).toHaveAttribute("aria-busy", "true")
    expect(await save.boundingBox()).toEqual(saveBefore)
    expect(await chooser.boundingBox()).toEqual(dialogBefore)
    await shoot(page, "chooser-phone-saving")
  } finally {
    finishUpload?.()
  }
  await expect(chooser).toHaveCount(0)
  const saved = await named(page.getByRole("tabpanel", { name: "Metadata" }).locator("[data-view-portrait] img"))
  expect(saved.crop.startsWith("0_")).toBe(true)

  // Blurred images stay blurred in the chooser.
  await page.keyboard.press("Alt+Shift+B")
  await expect(page.locator("html")).toHaveAttribute("data-images", "blur")
  await page.getByRole("tabpanel", { name: "Metadata" }).getByRole("button", { name: "Picture", exact: true }).click()
  const adjust = page.getByRole("dialog", { name: "Tall's picture" })
  const whole = adjust.getByRole("img", { name: "Tall's whole image" })
  await expect(whole).toBeVisible()
  expect(await whole.evaluate((img) => getComputedStyle(img).filter)).toContain("blur")
  await page.keyboard.press("Escape")
  await expect(adjust).toHaveCount(0)
  await page.keyboard.press("Alt+Shift+B")
})

test("Picture presets, free shape, reset and replace preserve the original", async ({ page }) => {
  const { refId, chat } = await open(page)
  await page.goto(`${server().url}/library/${refId}`)
  await cardFieldsTab(page, "Metadata")
  await page.getByLabel("Choose an avatar, or drop it here").setInputFiles(file("wide.png", shapeCard(wide, 90)))
  let dialog = page.getByRole("dialog", { name: "Tall's new picture" })
  await expect(dialog.locator("[data-cutout-box]")).toBeVisible()
  let stage = await stageOf(dialog)
  let box = await boxOf(dialog)
  expect(box.width).toBeCloseTo(stage.width, 0)
  expect(box.height).toBeCloseTo(stage.height, 0)
  await expect(dialog.locator('[data-cutout-preview="Large view"] img')).toBeVisible()
  await expect(dialog.locator('[data-cutout-preview="Export"] img')).toBeVisible()
  await dialog.getByRole("button", { name: "1:1", exact: true }).click()
  box = await boxOf(dialog)
  expect(box.width / box.height).toBeCloseTo(1, 1)
  await dialog.getByRole("button", { name: "2:3", exact: true }).click()
  box = await boxOf(dialog)
  expect(box.width / box.height).toBeCloseTo(2 / 3, 1)
  await dialog.getByRole("button", { name: "Free", exact: true }).click()
  const corner = (await dialog.locator('[data-cutout-corner="se"]').boundingBox())!
  await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2)
  await page.mouse.down()
  await page.mouse.move(corner.x + 70, corner.y - 50, { steps: 5 })
  await page.mouse.up()
  const free = await boxOf(dialog)
  expect(Math.abs(free.width / free.height - 2 / 3)).toBeGreaterThan(0.2)
  await dialog.getByRole("button", { name: "Reset to the original", exact: true }).click()
  expect((await boxOf(dialog)).width).toBeCloseTo(stage.width, 0)
  await dialog.getByRole("button", { name: "1:1", exact: true }).click()
  const cut = await boxOf(dialog)
  await dialog.getByRole("button", { name: "Portrait", exact: true }).click()
  box = await boxOf(dialog)
  expect(box.x).toBeGreaterThanOrEqual(cut.x - 1)
  expect(box.x + box.width).toBeLessThanOrEqual(cut.x + cut.width + 1)
  await expectPreviews(dialog, false)
  await dialog.getByRole("button", { name: "Save picture" }).click()
  await expect(dialog).toHaveCount(0)
  const portrait = page.getByRole("tabpanel", { name: "Metadata" }).locator("[data-view-portrait] img")
  const saved = await named(portrait)
  await page.reload()
  await page.getByRole("tabpanel", { name: "Metadata" }).getByRole("button", { name: "Picture", exact: true }).click()
  dialog = page.getByRole("dialog", { name: "Tall's picture" })
  await expect
    .poll(async () => {
      const b = await boxOf(dialog)
      return b.width / b.height
    })
    .toBeCloseTo(1, 1)
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
  await page.goto(`${server().url}${chat}`)
  await expectEveryPortrait(page, saved.id, saved.crop, 2)
  await openPanel(page, "Cast")
  await expectEveryPortrait(page, saved.id, saved.crop, 4)
  await page.locator("article[data-slot]").first().getByRole("button", { name: "View Tall's portrait" }).click()
  const full = page.getByRole("img", { name: "Tall's full portrait" })
  await expect(full).toHaveAttribute("src", /picture=/)
  await expect.poll(() => full.evaluate((im: HTMLImageElement) => im.naturalWidth / im.naturalHeight)).toBeCloseTo(1, 2)
  for (const path of ["/library", "/"]) {
    await page.goto(`${server().url}${path}`)
    await expectEveryPortrait(page, saved.id, saved.crop)
  }
  await page.goto(`${server().url}/library/${refId}`)
  await cardFieldsTab(page, "Metadata")
  await page.getByRole("tabpanel", { name: "Metadata" }).getByRole("button", { name: "Picture", exact: true }).click()
  dialog = page.getByRole("dialog", { name: "Tall's picture" })
  await dialog.getByRole("button", { name: "Reset to the original", exact: true }).click()
  await dialog.getByRole("button", { name: "Save cutout", exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await page.getByRole("tabpanel", { name: "Metadata" }).getByRole("button", { name: "Picture", exact: true }).click()
  await page.getByLabel("Choose a new picture").setInputFiles(file("tall.png", shapeCard(tall, 30)))
  dialog = page.getByRole("dialog", { name: "Tall's new picture" })
  await expect(dialog.getByRole("button", { name: "Full picture", exact: true })).toHaveAttribute("aria-pressed", "true")
  await expect
    .poll(async () => {
      stage = await stageOf(dialog)
      box = await boxOf(dialog)
      return Math.abs(stage.height - box.height)
    })
    .toBeLessThan(2)
  await dialog.getByRole("button", { name: "Portrait", exact: true }).click()
  await expectPreviews(dialog, false)
  await dialog.getByRole("button", { name: "Save picture", exact: true }).click()
  await expect(dialog).toHaveCount(0)
})

test("every choice in the Picture dialog explains where it's shown, and Portrait previews the chat portrait", async ({
  page
}) => {
  const shots = process.env.PICTUREHELP_SHOTS
  if (shots) await page.emulateMedia({ colorScheme: "dark" })
  await page.setViewportSize({ width: 1340, height: 900 })
  const { refId } = await open(page)
  await page.goto(`${server().url}/library/${refId}`)
  await cardFieldsTab(page, "Metadata")
  await page.getByLabel("Choose an avatar, or drop it here").setInputFiles(file("wide.png", shapeCard(wide, 90)))
  const dialog = page.getByRole("dialog", { name: "Tall's new picture" })
  await expect(dialog.locator("[data-cutout-box]")).toBeVisible()
  const explains = async (name: string, text: string, role: "button" | "slider" = "button") => {
    await dialog.getByRole(role, { name, exact: true }).hover()
    await expect(page.getByText(text, { exact: true }).last()).toBeVisible()
  }
  await explains("Full picture", "The picture shown when it's opened large, and in exported card files")
  await explains("Portrait", "The small portrait shown beside messages, in the cast, and in lists and tiles")
  await explains("Free", "Crop the full picture to any shape")
  await explains("2:3", "Crop the full picture two wide by three high, like a portrait")
  await explains("1:1", "Crop the full picture to a square")
  await explains("Cutout size", "Make the full picture's box bigger or smaller", "slider")
  await explains("Reset to the original", "Go back to the whole image as the full picture, with the default portrait")
  await dialog.getByRole("button", { name: "About cutout controls" }).hover()
  await expect(page.getByText(/opened large and in exported card files/).last()).toBeVisible()
  const previews = dialog.getByRole("region", { name: "Previews" })
  await expect(previews.getByText("Opened large", { exact: true })).toBeVisible()
  await expect(previews.getByText("Exported file", { exact: true })).toBeVisible()
  await page.mouse.move(0, 0)
  const places = async () => {
    const stage = (await dialog.locator("[data-cutout-stage]").boundingBox())!
    const controls = (await dialog.locator("[data-cutout-controls]").boundingBox())!
    return { stage: Math.round(stage.y), controls: Math.round(controls.y) }
  }
  const before = await places()
  if (shots) await dialog.screenshot({ path: join(shots, "1340-dark-picture.png") })
  await dialog.getByRole("button", { name: "Portrait", exact: true }).click()
  expect(await places()).toEqual(before)
  await explains("Cutout size", "Make the portrait's box bigger or smaller", "slider")
  await explains("Reset the cutout", "Put the portrait back at its default place in the full picture")
  for (const label of ["In messages", "In the cast", "Library tile"])
    await expect(previews.getByText(label, { exact: true })).toBeVisible()
  // The message preview is the chat's own portrait: its class, 2:3 shape and rounded corners.
  const message = previews.locator('[data-cutout-preview="Message"]')
  await expect(message).toHaveClass(/chat-portrait/)
  const shape = await message.evaluate((node) => {
    const rect = node.getBoundingClientRect()
    return { ratio: rect.height / rect.width, radius: parseFloat(getComputedStyle(node).borderTopLeftRadius) }
  })
  expect(shape.ratio).toBeCloseTo(1.5, 1)
  expect(shape.radius).toBeGreaterThan(0)
  await page.mouse.move(0, 0)
  if (shots) {
    await dialog.screenshot({ path: join(shots, "1340-dark-portrait.png") })
    await page.setViewportSize({ width: 390, height: 844 })
    await dialog.screenshot({ path: join(shots, "390-dark-portrait.png") })
    await dialog.getByRole("button", { name: "Full picture", exact: true }).click()
    await page.mouse.move(0, 0)
    await dialog.screenshot({ path: join(shots, "390-dark-picture.png") })
  }
})

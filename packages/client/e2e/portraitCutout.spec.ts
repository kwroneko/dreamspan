// A portrait's cutout (ARCHITECTURE.md §14.5c): setting a new picture opens the cutout chooser
// before it's saved, Adjust cutout chooses again later, every small portrait follows the cutout
// (its URL names it), and the full-image viewer still shows the whole original. The character
// tab's portrait changes the picture (owner, 2026-11-01). At 1440 with a mouse and the keyboard,
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

test("at 1440: a new picture is cut out before it's saved, adjusted later, and every portrait follows", async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const { refId, chat } = await open(page)

  // The editor: a new picture (wide) opens the chooser, the box over the whole image at 2:3.
  await page.goto(`${server().url}/library/${refId}`)
  await cardFieldsTab(page, "Metadata")
  await page.getByLabel("Choose an avatar, or drop it here").setInputFiles(file("wide.png", shapeCard(wide, 80)))
  const chooser = page.getByRole("dialog", { name: "Cut out Tall's new picture" })
  await expect(chooser).toBeVisible()
  await expect(chooser.locator("[data-cutout-box]")).toBeVisible()
  const stage = await stageOf(chooser)
  let box = await boxOf(chooser)
  // The default for a wide image: the full height, in the middle.
  expect(Math.abs(box.height - stage.height)).toBeLessThan(3)
  expect(Math.abs(box.x + box.width / 2 - (stage.x + stage.width / 2))).toBeLessThan(3)
  expect(box.width / box.height).toBeCloseTo(2 / 3, 1)
  await expect(chooser.locator("[data-cutout-preview] img")).toBeVisible()
  await shoot(page, "chooser-desktop")

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
  // The keyboard: arrows move it, − and + resize it, as the visible buttons' tooltips say.
  await chooser.locator("[data-cutout-box]").focus()
  await page.keyboard.press("ArrowDown")
  await page.keyboard.press("ArrowRight")
  const keyed = await boxOf(chooser)
  expect(keyed.y).toBeGreaterThan(box.y)
  expect(keyed.x).toBeGreaterThan(box.x)
  await page.keyboard.press("-")
  expect((await boxOf(chooser)).width).toBeLessThan(keyed.width)
  await chooser.getByRole("button", { name: "Larger cutout" }).hover()
  await expect(page.getByText("Make the cutout larger (+)")).toBeVisible()
  await chooser.getByRole("button", { name: "Save picture" }).click()
  await expect(chooser).toHaveCount(0)

  // The editor's portrait shows the cutout chosen; Adjust cutout opens the original whole.
  const portrait = page.getByRole("tabpanel", { name: "Metadata" }).locator("[data-change-portrait] img")
  const first = await named(portrait)
  expect(first.crop).not.toBe("auto")
  await page.getByRole("button", { name: "Adjust cutout" }).click()
  const adjust = page.getByRole("dialog", { name: "Adjust Tall's cutout" })
  await expect(adjust).toBeVisible()
  const original = new URL(
    (await adjust.getByRole("img", { name: "Tall's whole image" }).getAttribute("src"))!,
    "http://x"
  )
  expect(original.searchParams.get("w")).toBeNull()
  expect(original.searchParams.get("crop")).toBeNull()
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

  // The character tab: the portrait says what a click does, and changes the picture.
  await openPanel(page, "Tall")
  const tab = page.getByRole("tabpanel", { name: "Tall" })
  const change = tab.getByRole("button", { name: "Change Tall's picture" })
  await change.hover()
  await expect(page.getByText("Change the picture", { exact: true })).toBeVisible()
  await shoot(page, "tab-portrait-desktop")
  await tab.getByRole("button", { name: "Adjust cutout" }).hover()
  await expect(page.getByText("Adjust cutout: which part of the picture small portraits show")).toBeVisible()
  const picked = page.waitForEvent("filechooser")
  await change.click()
  await (await picked).setFiles(file("tall.png", shapeCard(tall, 120)))
  const fromTab = page.getByRole("dialog", { name: "Cut out Tall's new picture" })
  await expect(fromTab).toBeVisible()
  await fromTab.getByRole("button", { name: "Save picture" }).click()
  await expect(fromTab).toHaveCount(0)
  await expect.poll(async () => (await named(tab.locator("[data-change-portrait] img"))).id).not.toBe(second.id)
  // A 2:3 image's default is all of it.
  expect((await named(tab.locator("[data-change-portrait] img"))).crop).toBe("0_0_10000_10000")
  await expectEveryPortrait(page, (await named(tab.locator("[data-change-portrait] img"))).id, "0_0_10000_10000", 2)
  // View full image beside it opens the column.
  await tab.getByRole("button", { name: "View full image" }).click()
  await expect(page.getByRole("complementary", { name: "Tall's portrait", exact: true })).toBeVisible()
})

test("at 390: the chooser fits a phone, drags by touch, and follows the blur setting", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const { refId } = await open(page)
  await page.goto(`${server().url}/library/${refId}`)
  await cardFieldsTab(page, "Metadata")
  await page.getByLabel("Choose an avatar, or drop it here").setInputFiles(file("wide.png", shapeCard(wide, 160)))
  const chooser = page.getByRole("dialog", { name: "Cut out Tall's new picture" })
  await expect(chooser.locator("[data-cutout-box]")).toBeVisible()
  const dialog = (await chooser.boundingBox())!
  expect(dialog.x).toBeGreaterThanOrEqual(0)
  expect(dialog.x + dialog.width).toBeLessThanOrEqual(390)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await expect(chooser.getByRole("button", { name: "Save picture" })).toBeInViewport()
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
  expect(after.x).toBeLessThan(before.x - 20)
  expect(Math.abs(after.x - stage.x)).toBeLessThan(3)
  await chooser.getByRole("button", { name: "Save picture" }).click()
  await expect(chooser).toHaveCount(0)
  const saved = await named(page.getByRole("tabpanel", { name: "Metadata" }).locator("[data-change-portrait] img"))
  expect(saved.crop.startsWith("0_")).toBe(true)

  // Blurred images stay blurred in the chooser.
  await page.keyboard.press("Alt+Shift+B")
  await expect(page.locator("html")).toHaveAttribute("data-images", "blur")
  await page.getByRole("button", { name: "Adjust cutout" }).click()
  const adjust = page.getByRole("dialog", { name: "Adjust Tall's cutout" })
  const whole = adjust.getByRole("img", { name: "Tall's whole image" })
  await expect(whole).toBeVisible()
  expect(await whole.evaluate((img) => getComputedStyle(img).filter)).toContain("blur")
  await page.keyboard.press("Escape")
  await expect(adjust).toHaveCount(0)
  await page.keyboard.press("Alt+Shift+B")
})

// A portrait click shows the card's whole original beside the chat (the portrait column) on a
// wide screen, and in a full-screen viewer on a phone: fitted as large as the space allows, at
// 100% to pan (and pinch), switching on another portrait's click, open across replies. Cards of
// every shape (support/shapes.ts). PORTRAIT_SHOTS=<dir> saves screenshots of each, in both themes.
import { join } from "node:path"
import { expect, type Locator, type Page, test } from "@playwright/test"
import { openPanel } from "./support/panel.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { SHAPES, shapeCard } from "./support/shapes.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "200", FAKE_GENERATOR_TOKENS: "20" })
test.setTimeout(240_000)
const shots = process.env.PORTRAIT_SHOTS

const shoot = async (page: Page, name: string) => {
  if (!shots) return
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme })
    await page.screenshot({ animations: "disabled", path: join(shots, `${name}-${colorScheme}.png`) })
  }
  await page.emulateMedia({ colorScheme: "light" })
}

let chatUrl: Promise<string> | null = null
/** A chat with every shape in its cast, the first one's greeting and a reply on screen. */
const openChat = async (page: Page) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const url = await (chatUrl ??= (async () => {
    for (const [index, shape] of SHAPES.entries()) {
      const response = await page.request.post(`${server().url}/library/import?name=${shape.name}.png`, {
        data: shapeCard(shape, index * 40),
        headers: { origin: server().url, "content-type": "application/octet-stream" }
      })
      expect(response.ok()).toBeTruthy()
    }
    await page.goto(`${server().url}/library`)
    await page.getByRole("link", { name: "Start a chat with Tall" }).click()
    await page.getByLabel("Message", { exact: true }).fill("Hello there.")
    await page.getByRole("button", { name: "Send", exact: true }).click()
    await expect(page).toHaveURL(/\/chats\//)
    await expect(page.locator("article[data-slot]")).toHaveCount(3)
    await expect(page.getByText("generating", { exact: true })).toHaveCount(0)
    const cast = await openPanel(page, "Cast")
    for (const shape of SHAPES.slice(1)) {
      await cast.getByRole("button", { name: "Add character" }).click()
      const picker = page.getByRole("dialog", { name: "Add a character to this chat" })
      await picker.getByRole("searchbox", { name: "Search your cards" }).fill(shape.name)
      await picker
        .getByRole("list", { name: "Characters", exact: true })
        .getByRole("button", { name: new RegExp(`^${shape.name}`) })
        .click()
      await expect(cast.getByRole("button", { name: `View ${shape.name}'s portrait` })).toBeVisible()
    }
    return new URL(page.url()).pathname
  })())
  await page.goto(`${server().url}${url}`)
  await expect(page.locator("article[data-slot]").first()).toBeVisible()
}

/** The full image shown and its box, once the original has loaded. */
const measure = async (page: Page, name: string) => {
  const image = page.getByRole("img", { name: `${name}'s full portrait` })
  await expect
    .poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
    .toBeGreaterThan(0)
  return image.evaluate((img: HTMLImageElement) => {
    const box = img.closest("[data-image-viewer]")!
    const rect = img.getBoundingClientRect()
    return {
      width: rect.width,
      height: rect.height,
      natural: { width: img.naturalWidth, height: img.naturalHeight },
      box: { width: box.clientWidth, height: box.clientHeight },
      scrolls: box.scrollWidth > box.clientWidth + 1 || box.scrollHeight > box.clientHeight + 1
    }
  })
}

/** Fitted: the whole image at its own shape, filling the box one way (a small one enlarged up to twice). */
const expectFitted = async (page: Page, name: string) => {
  await expect
    .poll(async () => {
      const m = await measure(page, name)
      const scale = Math.min(m.box.width / m.natural.width, m.box.height / m.natural.height, 2)
      return (
        Math.abs(m.width - m.natural.width * scale) < 2 &&
        Math.abs(m.height - m.natural.height * scale) < 2 &&
        !m.scrolls
      )
    })
    .toBe(true)
  const m = await measure(page, name)
  if (m.natural.width * 2 >= m.box.width || m.natural.height * 2 >= m.box.height)
    expect(m.width >= m.box.width - 2 || m.height >= m.box.height - 2).toBe(true)
  return m
}

/** 100%: one image pixel to a CSS pixel, differing from the fit; a larger one scrolls. */
const expectActual = async (page: Page, region: Locator, name: string) => {
  const fitted = await expectFitted(page, name)
  await region.getByRole("button", { name: "100%", exact: true }).click()
  await expect(region.getByRole("button", { name: "Fit", exact: true })).toBeVisible()
  await expect.poll(async () => (await measure(page, name)).width).toBeCloseTo(fitted.natural.width, 0)
  const actual = await measure(page, name)
  expect(Math.abs(actual.width - fitted.width)).toBeGreaterThan(20)
  expect(actual.scrolls).toBe(actual.width > actual.box.width + 1 || actual.height > actual.box.height + 1)
  return actual
}

test("a portrait opens beside the chat at 1440: every kind of portrait, every shape, the chat usable", async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await openChat(page)
  const column = (name: string) => page.getByRole("complementary", { name: `${name}'s portrait`, exact: true })

  // A message's portrait, with the panel closed (this browser reopens it where it was left).
  const hide = page.getByRole("button", { name: "Close the panel" })
  if (await hide.isVisible()) await hide.click()
  await page.locator("article[data-slot]").first().getByRole("button", { name: "View Tall's portrait" }).click()
  await expect(column("Tall")).toBeVisible()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  const tall = await expectFitted(page, "Tall")
  expect(tall.height).toBeGreaterThan(780)

  // The chat stays usable beside it, and it stays open across replies.
  const main = page.locator("[data-chat-main]")
  expect((await main.boundingBox())!.width).toBeGreaterThanOrEqual(440)
  await page.getByLabel("Message", { exact: true }).fill("Still here?")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(page.locator("article[data-slot]")).toHaveCount(5)
  await expect(page.getByText("generating", { exact: true })).toHaveCount(0)
  await expect(column("Tall")).toBeVisible()
  await shoot(page, "desktop-tall")

  // 100% differs from the fit, and drags about.
  const actual = await expectActual(page, column("Tall"), "Tall")
  expect(actual.scrolls).toBe(true)
  const viewer = column("Tall").locator("[data-image-viewer]")
  const box = (await viewer.boundingBox())!
  const before = await viewer.evaluate((node) => node.scrollTop)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 150, { steps: 5 })
  await page.mouse.up()
  expect(await viewer.evaluate((node) => node.scrollTop)).toBeGreaterThan(before + 100)
  await shoot(page, "desktop-tall-100")
  await column("Tall").getByRole("button", { name: "Fit", exact: true }).click()

  // With the side panel open too: the messages keep their room, the portrait gives way.
  const cast = await openPanel(page, "Cast")
  await expect(column("Tall")).toBeVisible()
  expect((await main.boundingBox())!.width).toBeGreaterThanOrEqual(439)
  await expectFitted(page, "Tall")
  await shoot(page, "desktop-tall-with-panel")

  // Every shape from a Cast row: it switches, fitted to the column, and 100% differs.
  for (const shape of SHAPES.slice(1)) {
    await cast.getByRole("button", { name: `View ${shape.name}'s portrait` }).click()
    await expect(column(shape.name)).toBeVisible()
    await expect(page.locator("[data-portrait-column]")).toHaveCount(1)
    await expectFitted(page, shape.name)
    await shoot(page, `desktop-${shape.name.toLowerCase()}-with-panel`)
  }
  await page.getByRole("button", { name: "Close the panel" }).click()
  await expect(cast).toHaveCount(0)
  for (const shape of SHAPES) {
    if (shape.name !== "Huge") {
      // The cast strip's and the character tab's portraits: reopen the panel at their tab.
      await openPanel(page, "Cast")
      await page.getByRole("tab", { name: shape.name }).click()
      await expect(column(shape.name)).toBeVisible()
      await page.getByRole("button", { name: "Close the panel" }).click()
    } else {
      await openPanel(page, shape.name)
      // The tab's own portrait changes the picture (owner, 2026-11-01); View full image beside
      // it shows the whole image, staying open when it's the one shown.
      await page
        .getByRole("tabpanel", { name: shape.name })
        .getByRole("button", { name: "View full image", exact: true })
        .click()
      await expect(column(shape.name)).toBeVisible()
      await page.getByRole("button", { name: "Close the panel" }).click()
    }
    const fitted = await expectFitted(page, shape.name)
    // Never a thumbnail in the middle: the column takes the image's width at its height.
    if (shape.height / shape.width > 1) expect(fitted.height).toBeGreaterThan(Math.min(780, shape.height * 2 - 2))
    else expect(fitted.width).toBeGreaterThan(560)
    await shoot(page, `desktop-${shape.name.toLowerCase()}`)
    await expectActual(page, column(shape.name), shape.name)
    if (shape.name === "Huge" || shape.name === "Small") await shoot(page, `desktop-${shape.name.toLowerCase()}-100`)
    await column(shape.name).getByRole("button", { name: "Fit", exact: true }).click()
  }
  await column("Huge").getByRole("button", { name: "Close the portrait" }).click()
  await expect(page.locator("[data-portrait-column]")).toHaveCount(0)
})

test("a portrait opens full-screen at 390: fit and 100% differ, it pans and pinches", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await openChat(page)
  const screen = (name: string) => page.getByRole("dialog", { name, exact: true })

  await page.locator("article[data-slot]").first().getByRole("button", { name: "View Tall's portrait" }).click()
  await expect(screen("Tall")).toBeVisible()
  const fitted = await expectFitted(page, "Tall")
  expect(fitted.width).toBeGreaterThan(360)
  await shoot(page, "phone-tall")
  await expectActual(page, screen("Tall"), "Tall")
  await shoot(page, "phone-tall-100")
  await screen("Tall").getByRole("button", { name: "Fit", exact: true }).click()

  // A pinch: two touch pointers spreading apart enlarge it about their middle.
  const viewer = screen("Tall").locator("[data-image-viewer]")
  await viewer.evaluate(async (node) => {
    const rect = node.getBoundingClientRect()
    const x = rect.left + rect.width / 2,
      y = rect.top + rect.height / 2
    const send = (type: string, id: number, dx: number) =>
      node.dispatchEvent(
        new PointerEvent(type, {
          pointerId: id,
          pointerType: "touch",
          clientX: x + dx,
          clientY: y,
          bubbles: true,
          isPrimary: id === 11
        })
      )
    send("pointerdown", 11, -40)
    send("pointerdown", 12, 40)
    for (let step = 1; step <= 10; step++) {
      send("pointermove", 11, -40 - step * 12)
      send("pointermove", 12, 40 + step * 12)
      await new Promise((done) => requestAnimationFrame(done))
    }
    send("pointerup", 11, -160)
    send("pointerup", 12, 160)
  })
  await expect(viewer).toHaveAttribute("data-zoom", "scaled")
  const pinched = await measure(page, "Tall")
  expect(pinched.width).toBeGreaterThan(fitted.width * 2)
  expect(pinched.scrolls).toBe(true)
  await screen("Tall").getByRole("button", { name: "Fit", exact: true }).click()
  await screen("Tall").getByRole("button", { name: "Close", exact: true }).click()
  await expect(screen("Tall")).toHaveCount(0)

  // From the Cast sheet, every shape: the viewer over the sheet, and closing it leaves the sheet.
  const cast = await openPanel(page, "Cast")
  for (const shape of SHAPES) {
    await cast.getByRole("button", { name: `View ${shape.name}'s portrait` }).click()
    await expect(screen(shape.name)).toBeVisible()
    await expectFitted(page, shape.name)
    await shoot(page, `phone-${shape.name.toLowerCase()}`)
    await expectActual(page, screen(shape.name), shape.name)
    if (shape.name !== "Tall") await shoot(page, `phone-${shape.name.toLowerCase()}-100`)
    await screen(shape.name).getByRole("button", { name: "Close", exact: true }).click()
    await expect(screen(shape.name)).toHaveCount(0)
    await expect(cast).toBeVisible()
  }
})

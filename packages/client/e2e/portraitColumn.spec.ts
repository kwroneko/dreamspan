// A portrait click shows the card's whole original beside the chat (the portrait column) on a
// wide screen, and in a full-screen viewer on a phone: fitted as large as the space allows, at
// 100% to pan (and pinch), switching on another portrait's click, open across replies. Cards of
// every shape (support/shapes.ts). PORTRAIT_SHOTS=<dir> saves screenshots of each, in both themes.
import { join } from "node:path"
import { expect, type Locator, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { openPanel } from "./support/panel.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { SHAPES, shapeCard } from "./support/shapes.ts"
import { addToCast } from "./support/cast.ts"

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
      await addToCast(page, shape.name)
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

const SINGLE = "Only keep one image open at a time"
/** Sets a viewer's "Only keep one image open at a time" toggle. */
const setSingle = async (viewer: Locator, on: boolean) => {
  const toggle = viewer.getByRole("button", { name: SINGLE, exact: true })
  if ((await toggle.getAttribute("aria-pressed")) !== String(on)) await toggle.click()
  await expect(toggle).toHaveAttribute("aria-pressed", String(on))
}

test("a portrait opens beside the chat at 1440: every kind of portrait, every shape, the chat usable", async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await openChat(page)
  const column = (name: string) => page.getByRole("complementary", { name: `${name}'s portrait`, exact: true })

  // A message's portrait, with the panel closed (this browser reopens it where it was left).
  const hide = page.getByRole("button", { name: "Hide panel" })
  if (await hide.isVisible()) await hide.click()
  await page.locator("article[data-slot]").getByRole("button", { name: "View Tall's portrait" }).first().click()
  await expect(column("Tall")).toBeVisible()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  // One image at a time: another portrait's click replaces it (the stack has its own test).
  await setSingle(column("Tall"), true)
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
  const image = page.getByRole("img", { name: "Tall's full portrait" })
  const before = (await image.boundingBox())!.y
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 150, { steps: 5 })
  await page.mouse.up()
  expect((await image.boundingBox())!.y).toBeLessThan(before - 100)
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
  await page.getByRole("button", { name: "Hide panel" }).click()
  await expect(cast).toHaveCount(0)
  for (const shape of SHAPES) {
    if (shape.name !== "Huge") {
      // The cast strip's and the character tab's portraits: reopen the panel at their tab.
      await openPanel(page, "Cast")
      await page.getByRole("tab", { name: shape.name }).click()
      await expect(column(shape.name)).toBeVisible()
      await page.getByRole("button", { name: "Hide panel" }).click()
    } else {
      await openPanel(page, shape.name)
      // The tab's own portrait shows the whole image (owner, 2026-11-02), staying open when
      // it's the one shown.
      await page
        .getByRole("tabpanel", { name: shape.name })
        .getByRole("button", { name: `View ${shape.name}'s picture`, exact: true })
        .click()
      await expect(column(shape.name)).toBeVisible()
      await page.getByRole("button", { name: "Hide panel" }).click()
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

test("the column follows its card's name when another version is swapped in; Escape from the chat page closes it", async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const chatId = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const root = yield* api.CreateCard({ label: "Pilot", name: "Pilot" })
      yield* api.ForkCard({
        refId: root.id,
        name: "Pilot Storm",
        nickname: "Pilot",
        characterVersion: "Storm"
      })
      const chat = yield* api.CreateChat({ title: "The harbor" })
      yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: root.entityId } })
      return chat.id
    })
  )
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chatId}`)
  const column = (name: string) => page.getByRole("complementary", { name: `${name}'s portrait`, exact: true })
  const cast = await openPanel(page, "Cast")
  await cast.getByRole("button", { name: "View Pilot's portrait" }).click()
  await expect(column("Pilot")).toBeVisible()

  // Swapped for another of its family, the shown portrait is the one swapped in.
  const tab = await openPanel(page, "Pilot")
  await tab.getByRole("button", { name: "Use another version: Pilot", exact: true }).click()
  await page
    .getByRole("dialog", { name: "Use another version", exact: true })
    .getByRole("button", { name: /Pilot Storm · Storm/ })
    .click()
  const rename = page.getByRole("dialog", { name: "Replace the name in past messages?", exact: true })
  if (await rename.isVisible().catch(() => false)) await rename.getByRole("button", { name: /^No\./ }).click()
  await expect(column("Pilot Storm")).toBeVisible()
  await expect(column("Pilot Storm").getByRole("heading", { name: "Pilot Storm", exact: true })).toBeVisible()
  await expect(page.locator("[data-portrait-column]")).toHaveCount(1)

  // Escape while typing is the text's; from elsewhere on the page it closes the column.
  const message = page.getByLabel("Message", { exact: true })
  await message.click()
  await page.keyboard.press("Escape")
  await expect(column("Pilot Storm")).toBeVisible()
  await message.blur()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await page.keyboard.press("Escape")
  await expect(page.locator("[data-portrait-column]")).toHaveCount(0)
})

test("portraits stack in the column at 1440: one on top of another, closed one by one, the boundary dragged, one at a time again", async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await openChat(page)
  const column = (name: string) => page.getByRole("complementary", { name: `${name}'s portrait`, exact: true })
  const viewers = page.locator("[data-portrait-column] [data-portrait-viewer]")
  const order = () => viewers.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")))
  const heights = () =>
    viewers.evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().height)))
  const hide = page.getByRole("button", { name: "Hide panel" })
  if (await hide.isVisible()) await hide.click()

  // Stacking is the default; the earlier test left one at a time on, so turn it off.
  await page.locator("article[data-slot]").getByRole("button", { name: "View Tall's portrait" }).first().click()
  await setSingle(column("Tall"), false)
  await expectFitted(page, "Tall")
  await shoot(page, "stack-1")

  // Another portrait opens above, splitting the column; each image fitted to its own viewer.
  const cast = await openPanel(page, "Cast")
  await cast.getByRole("button", { name: "View Wide's portrait" }).click()
  await expect(viewers).toHaveCount(2)
  expect(await order()).toEqual(["Wide's portrait", "Tall's portrait"])
  const [top, bottom] = await heights()
  expect(Math.abs(top! - bottom!)).toBeLessThan(3)
  await expectFitted(page, "Wide")
  await expectFitted(page, "Tall")
  // A click on one that's open closes only it.
  await cast.getByRole("button", { name: "View Wide's portrait" }).click()
  await expect(viewers).toHaveCount(1)
  await cast.getByRole("button", { name: "View Wide's portrait" }).click()
  await expect(viewers).toHaveCount(2)
  await page.getByRole("button", { name: "Hide panel" }).click()
  await shoot(page, "stack-2")
  // A narrower window: the column gives way, the two still stacked.
  await page.setViewportSize({ width: 1024, height: 768 })
  await expect(viewers).toHaveCount(2)
  expect((await page.locator("[data-chat-main]").boundingBox())!.width).toBeGreaterThanOrEqual(439)
  await expectFitted(page, "Wide")
  await shoot(page, "stack-2-1024")
  await page.setViewportSize({ width: 1440, height: 900 })

  // Four: the cast strip's chips open theirs too, on top.
  await openPanel(page, "Cast")
  await cast.getByRole("button", { name: "View Standard's portrait" }).click()
  await page.getByRole("tab", { name: "Huge" }).click()
  await expect(viewers).toHaveCount(4)
  expect(await order()).toEqual(["Huge's portrait", "Standard's portrait", "Wide's portrait", "Tall's portrait"])
  for (const name of ["Huge", "Standard", "Wide", "Tall"]) await expectFitted(page, name)
  await page.getByRole("button", { name: "Hide panel" }).click()
  await shoot(page, "stack-4")
  await page.setViewportSize({ width: 1024, height: 768 })
  await shoot(page, "stack-4-1024")
  await page.setViewportSize({ width: 1440, height: 900 })

  // The boundary between two drags by pointer, changing only those two (each about 225 px of
  // its 180 px minimum here).
  const boundary = page.getByRole("separator", { name: "Resize Standard's and Wide's portraits", exact: true })
  await expect(boundary).toHaveAttribute("aria-orientation", "horizontal")
  const before = await heights()
  const grip = (await boundary.boundingBox())!
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
  await page.mouse.down()
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2 + 30, { steps: 5 })
  await page.mouse.up()
  await expect.poll(async () => (await heights())[1]! - before[1]!).toBeGreaterThan(25)
  const dragged = await heights()
  expect(dragged[0]).toBe(before[0])
  expect(dragged[3]).toBe(before[3])
  expect(Math.abs(dragged[1]! + dragged[2]! - before[1]! - before[2]!)).toBeLessThan(3)
  // And by keyboard: arrows, Home (the minimum), End, and a double-click evens the two.
  await boundary.focus()
  const now = async () => Number(await boundary.getAttribute("aria-valuenow"))
  const start = await now()
  await page.keyboard.press("ArrowDown")
  await expect.poll(now).toBe(start + 10)
  await page.keyboard.press("Shift+ArrowUp")
  await expect.poll(now).toBe(start - 30)
  await page.keyboard.press("Home")
  await expect.poll(now).toBe(180)
  await page.keyboard.press("End")
  await expect
    .poll(async () => Math.abs((await now()) - Number(await boundary.getAttribute("aria-valuemax"))))
    .toBeLessThanOrEqual(1)
  expect((await heights())[2]).toBeLessThanOrEqual(181)
  await boundary.dblclick()
  await expect.poll(async () => Math.abs((await heights())[1]! - (await heights())[2]!)).toBeLessThan(3)
  await boundary.hover()
  await expect(page.getByText(/^Drag to share the height between these two images/)).toBeVisible()

  // Past what fits at their minimum height, the column scrolls.
  await openPanel(page, "Cast")
  await cast.getByRole("button", { name: "View Phone's portrait" }).click()
  await cast.getByRole("button", { name: "View Small's portrait" }).click()
  await expect(viewers).toHaveCount(6)
  await page.getByRole("button", { name: "Hide panel" }).click()
  const list = page.locator("[data-portrait-column] > div.overflow-y-auto")
  expect(await list.evaluate((node) => node.scrollHeight > node.clientHeight + 1)).toBe(true)
  for (const height of await heights()) expect(height).toBeGreaterThanOrEqual(179)
  await shoot(page, "stack-6")

  // Closed one by one: Close, and Escape the top one.
  await column("Phone").getByRole("button", { name: "Close the portrait", exact: true }).click()
  await expect(viewers).toHaveCount(5)
  await page.keyboard.press("Escape")
  await expect(viewers).toHaveCount(4)
  expect(await order()).toEqual(["Huge's portrait", "Standard's portrait", "Wide's portrait", "Tall's portrait"])

  // One at a time: the toggle keeps that one, closes the others, and a click then replaces it.
  await expect(column("Wide").getByRole("button", { name: SINGLE, exact: true })).toHaveAttribute(
    "aria-pressed",
    "false"
  )
  await column("Wide").getByRole("button", { name: SINGLE, exact: true }).hover()
  await expect(page.getByText("Click to keep only one image open at a time.")).toBeVisible()
  await setSingle(column("Wide"), true)
  await page.mouse.move(0, 0)
  await column("Wide").getByRole("button", { name: SINGLE, exact: true }).hover()
  await expect(page.getByText("Click to allow multiple images open at a time.")).toBeVisible()
  await expect(viewers).toHaveCount(1)
  await expect(column("Wide")).toBeVisible()
  await page.locator("article[data-slot]").getByRole("button", { name: "View Tall's portrait" }).first().click()
  await expect(viewers).toHaveCount(1)
  await expect(column("Tall")).toBeVisible()

  // The account's choice: after a reload, still one at a time.
  await page.reload()
  // The viewer is itself restored, as well as the one-at-a-time preference.
  await expect(column("Tall").getByRole("button", { name: SINGLE, exact: true })).toHaveAttribute(
    "aria-pressed",
    "true"
  )
  await openPanel(page, "Cast")
  await cast.getByRole("button", { name: "View Standard's portrait" }).click()
  await expect(viewers).toHaveCount(1)
  await expect(column("Standard")).toBeVisible()
  // Off again: back to stacking, after a reload too.
  await setSingle(column("Standard"), false)
  await page.reload()
  await expect(column("Standard")).toBeVisible()
  await openPanel(page, "Cast")
  await cast.getByRole("button", { name: "View Tall's portrait" }).click()
  await expect(viewers).toHaveCount(2)
  await expect(column("Tall").getByRole("button", { name: SINGLE, exact: true })).toHaveAttribute(
    "aria-pressed",
    "false"
  )
})

test("a portrait opens full-screen at 390: fit and 100% differ, it pans and pinches", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await openChat(page)
  const screen = (name: string) => page.getByRole("dialog", { name, exact: true })

  await page.locator("article[data-slot]").getByRole("button", { name: "View Tall's portrait" }).first().click()
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

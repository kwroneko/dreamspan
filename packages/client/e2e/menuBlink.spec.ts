// Closing a message's "More actions" menu (owner, 2026-11-24: clicking outside the open menu
// made the message's buttons above it disappear for about a second, then come back). Every
// animation frame for 1.5 s after the close, the opacity of the message's toolbar is read: it may
// fade out once, as when the pointer simply leaves the message, or stay shown while focus goes
// back to More actions, but never dip and come back. While the message or its thinking is
// edited (owner, 2026-11-24: the buttons disappeared), they stay shown in place, disabled, each
// saying why on hover, and are back after Save or Cancel without blinking.
import { expect, type Locator, type Page, test } from "@playwright/test"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile({
  ...withAdmin,
  FAKE_GENERATOR_TPS: "400",
  FAKE_GENERATOR_TOKENS: "40",
  FAKE_GENERATOR_REASONING: "12"
})

const generating = (page: Page) => page.getByText("generating", { exact: true })
const reply = (page: Page) => page.getByRole("article", { name: "Reply", exact: true }).last()
const mine = (page: Page) => page.getByRole("article", { name: "Your message", exact: true }).first()
const menu = (page: Page) => page.getByRole("menu", { name: "More actions" })

const newChat = async (page: Page, title: string) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`${server().url}/chats`)
  await page.getByLabel("Title of the new chat").fill(title)
  await page.getByRole("button", { name: "New chat", exact: true }).click()
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible()
  await page.getByLabel("Message", { exact: true }).fill("The lantern swings over the quay.")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(reply(page)).toBeVisible()
  await expect(generating(page)).toHaveCount(0, { timeout: 20_000 })
}

/** Records the toolbar's opacity in `message`'s header every frame, for `ms`. */
const record = (message: Locator, ms: number) =>
  message.evaluate(
    (article, ms) =>
      new Promise<number[]>((resolve) => {
        const values: number[] = []
        const start = performance.now()
        const tick = () => {
          const bar = article.querySelector<HTMLElement>("header [role=toolbar]")
          values.push(bar ? Number(getComputedStyle(bar).opacity) : 0)
          if (performance.now() - start < ms) requestAnimationFrame(tick)
          else resolve(values)
        }
        requestAnimationFrame(tick)
      }),
    ms
  )

/** Whether the opacity, once it had dropped, rose again: hidden→shown or shown→hidden→shown. */
const blinked = (values: number[]) => {
  let low = 1
  for (const value of values) {
    low = Math.min(low, value)
    if (low < 0.9 && value > low + 0.1) return true
  }
  return false
}

const openMenu = async (page: Page, message: Locator) => {
  await message.hover()
  await message.getByRole("button", { name: "More actions" }).click()
  await expect(menu(page)).toBeVisible()
  await expect(menu(page).getByRole("menuitem").first()).toBeVisible()
}

/** A point in the chat below the messages, on nothing that takes focus. */
const emptyPoint = async (page: Page) => {
  const box = (await reply(page).boundingBox())!
  const point = { x: box.x + box.width / 2, y: box.y + box.height + 60 }
  const onNothing = await page.evaluate(({ x, y }) => {
    const at = document.elementFromPoint(x, y)
    return at !== null && at.closest("article, button, a, input, textarea, [role=menu]") === null
  }, point)
  expect(onNothing).toBe(true)
  return point
}

test("clicking outside the open menu fades the message's buttons out once", async ({ page }) => {
  await newChat(page, "Menu blink outside")
  const message = reply(page)
  await openMenu(page, message)
  const point = await emptyPoint(page)
  const frames = record(message, 1500)
  await page.mouse.click(point.x, point.y)
  const values = await frames
  await expect(menu(page)).toHaveCount(0)
  expect(blinked(values), `opacity per frame: ${values.join(" ")}`).toBe(false)
  expect(values.at(-1)).toBe(0)
})

test("clicking another message while the menu is open fades the buttons out once", async ({ page }) => {
  await newChat(page, "Menu blink other")
  const message = reply(page)
  await openMenu(page, message)
  const frames = record(message, 1500)
  await mine(page).locator(".markdown").first().click()
  const values = await frames
  await expect(menu(page)).toHaveCount(0)
  expect(blinked(values), `opacity per frame: ${values.join(" ")}`).toBe(false)
  expect(values.at(-1)).toBe(0)
})

test("closing the menu with Escape keeps the buttons shown, focus back on More actions", async ({ page }) => {
  await newChat(page, "Menu blink escape")
  const message = reply(page)
  await openMenu(page, message)
  // The pointer leaves the message: only focus going back keeps the buttons.
  const point = await emptyPoint(page)
  await page.mouse.move(point.x, point.y)
  const frames = record(message, 1500)
  await page.keyboard.press("Escape")
  const values = await frames
  await expect(menu(page)).toHaveCount(0)
  await expect(message.getByRole("button", { name: "More actions" })).toBeFocused()
  expect(blinked(values), `opacity per frame: ${values.join(" ")}`).toBe(false)
  expect(Math.min(...values), `opacity per frame: ${values.join(" ")}`).toBe(1)
})

/** The toolbar's buttons on the message's header, More actions last. */
const headerButtons = (message: Locator) => message.locator("header [role=toolbar]").getByRole("button")

/** Every button on the toolbar is disabled, each saying `why` on hover. */
const expectLocked = async (page: Page, message: Locator, why: string) => {
  const buttons = headerButtons(message)
  expect(await buttons.count()).toBeGreaterThan(1)
  // Off the button just clicked, whose tooltip waits for the pointer to leave it.
  const point = await emptyPoint(page)
  await page.mouse.move(point.x, point.y)
  for (const button of await buttons.all()) {
    await expect(button).toBeDisabled()
    await button.hover()
    await expect(page.getByText(why, { exact: true }).last()).toBeVisible()
  }
}
/** Hovers `message` until its toolbar has faded fully in. */
const hoverShown = async (message: Locator) => {
  await message.hover()
  await expect
    .poll(() => message.locator("header [role=toolbar]").evaluate((bar) => Number(getComputedStyle(bar).opacity)))
    .toBe(1)
}
/** Which of the toolbar's buttons are disabled (Continue is, in a chat without a model). */
const disabledStates = (message: Locator) =>
  headerButtons(message).evaluateAll((buttons) => buttons.map((b) => b.getAttribute("aria-disabled") === "true"))
/** The toolbar is as it was before the edit. */
const expectUnlocked = async (message: Locator, before: boolean[]) =>
  expect.poll(() => disabledStates(message)).toEqual(before)

test("the message's buttons stay shown, disabled, while it is edited, and come back after Cancel and Save", async ({
  page
}) => {
  await newChat(page, "Menu blink edit")
  const message = reply(page)
  await hoverShown(message)
  const before = await disabledStates(message)
  expect(before).toContain(false)
  let frames = record(message, 1200)
  await message.locator("header").getByRole("button", { name: "Edit", exact: true }).click()
  let values = await frames
  await expect(message.getByRole("textbox", { name: "Message text", exact: true })).toBeVisible()
  expect(Math.min(...values), `opacity per frame: ${values.join(" ")}`).toBe(1)
  await expectLocked(page, message, "Finish or cancel the edit first.")
  // Shown even with the pointer elsewhere: it's the message being worked on.
  const point = await emptyPoint(page)
  await page.mouse.move(point.x, point.y)
  values = await record(message, 400)
  expect(Math.min(...values), `opacity per frame: ${values.join(" ")}`).toBe(1)

  const edit = message.getByRole("group", { name: "Edit", exact: true })
  await hoverShown(message)
  frames = record(message, 1500)
  await edit.getByRole("button", { name: "Cancel", exact: true }).click()
  values = await frames
  await expect(message.getByRole("textbox", { name: "Message text", exact: true })).toHaveCount(0)
  expect(blinked(values), `opacity per frame: ${values.join(" ")}`).toBe(false)
  await expectUnlocked(message, before)

  await hoverShown(message)
  await message.locator("header").getByRole("button", { name: "Edit", exact: true }).click()
  const text = message.getByRole("textbox", { name: "Message text", exact: true })
  await expect(text).toBeFocused()
  await page.keyboard.press("ControlOrMeta+End")
  await page.keyboard.type(" The tide turns.")
  frames = record(message, 1500)
  await edit.getByRole("button", { name: "Save", exact: true }).click()
  values = await frames
  await expect(text).toHaveCount(0)
  expect(blinked(values), `opacity per frame: ${values.join(" ")}`).toBe(false)
  await expectUnlocked(message, before)
})

test("the message's buttons stay shown, disabled, while its thinking is edited", async ({ page }) => {
  await newChat(page, "Menu blink thinking")
  const message = reply(page)
  const panel = message.locator('[data-reasoning-panel="reasoning"]')
  await hoverShown(message)
  const before = await disabledStates(message)
  expect(before).toContain(false)
  const frames = record(message, 1200)
  await panel.getByRole("button", { name: "Edit thinking", exact: true }).click()
  let values = await frames
  await expect(message.getByRole("textbox", { name: "Thinking", exact: true })).toBeVisible()
  expect(Math.min(...values), `opacity per frame: ${values.join(" ")}`).toBe(1)
  await expectLocked(page, message, "Finish or cancel the thinking's edit first.")
  await hoverShown(message)
  const closing = record(message, 1500)
  await message
    .locator("[data-thinking-edit] [data-field-chrome]")
    .getByRole("button", { name: "Cancel", exact: true })
    .click()
  values = await closing
  await expect(message.getByRole("textbox", { name: "Thinking", exact: true })).toHaveCount(0)
  expect(blinked(values), `opacity per frame: ${values.join(" ")}`).toBe(false)
  await expectUnlocked(message, before)
})

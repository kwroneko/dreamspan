// The composer's actions with guidance on (owner, 2026-11-23): one Generate, as wide as Generate
// and Send together, so the guidance toggle doesn't move; each button's hover says what it does,
// and only the one Enter triggers ends with "(Enter)". All fixture content is synthetic;
// screenshots are written outside the repository.
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect, test, type Locator, type Page } from "@playwright/test"
import type { EntityId } from "@dreamspan/shared/chat.ts"
import { asUser } from "./support/rpc.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { textBoxValue } from "./support/textbox.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
const shots = resolve(process.env.SCREENSHOT_DIR ?? join(tmpdir(), "rp-guidance-buttons-screenshots"))
mkdirSync(shots, { recursive: true })
test.use({ reducedMotion: "reduce" })

const toggleOf = (page: Page) =>
  page.getByTestId("composer-controls").getByRole("switch", { name: "Guidance", exact: true })
/** The row's actions: the toggle's own group (guidance, generate, send). */
const actionsOf = (page: Page) => toggleOf(page).locator("..")
/** Its box; with `from`, its height on the page measured from the bottom of `from`. */
const box = async (control: Locator, from?: Locator) => {
  const { x, y, width, height } = (await control.boundingBox())!
  const edge = from ? (await from.boundingBox())! : null
  return { x, y: y - (edge ? edge.y + edge.height : 0), width, height }
}
const near = (a: { x: number; y: number; width: number; height: number }, b: typeof a) => {
  for (const key of ["x", "y", "width", "height"] as const)
    expect(Math.abs(a[key] - b[key]), `${key}: ${JSON.stringify(a)} against ${JSON.stringify(b)}`).toBeLessThanOrEqual(
      0.5
    )
}
const hover = async (page: Page, control: Locator, text: string) => {
  await page.mouse.move(0, 0)
  await control.hover()
  await expect(page.getByText(text, { exact: true }).filter({ visible: true })).toBeVisible()
  await page.mouse.move(0, 0)
  await expect(page.getByText(text, { exact: true }).filter({ visible: true })).toHaveCount(0)
}
const settled = (page: Page) =>
  expect(page.getByText("generating", { exact: true })).toHaveCount(0, { timeout: 30_000 })

/**
 * Toggles guidance and checks the toggle stays put, the one wide Generate takes Generate + gap +
 * Send, and turning it off brings Send back where it was. `from`: measure heights from the bottom of
 * this (the new chat's box, while the hint line under it still changes with guidance).
 */
const checkToggle = async (page: Page, from?: Locator) => {
  const toggle = toggleOf(page)
  const actions = actionsOf(page)
  await expect(actions.getByRole("button")).toHaveCount(2)
  const off = await box(toggle, from)
  const pair = await actions.getByRole("button").evaluateAll((buttons) => {
    const first = buttons[0]!.getBoundingClientRect()
    const last = buttons.at(-1)!.getBoundingClientRect()
    return { left: first.left, right: last.right }
  })
  await toggle.click()
  await expect(toggle).toHaveAttribute("aria-checked", "true")
  near(await box(toggle, from), off)
  // One action: Generate, from where Generate began to where Send ended.
  await expect(actions.getByRole("button")).toHaveCount(1)
  const wide = await box(actions.getByRole("button"))
  expect(Math.abs(wide.x - pair.left)).toBeLessThanOrEqual(0.5)
  expect(Math.abs(wide.x + wide.width - pair.right)).toBeLessThanOrEqual(0.5)
  await toggle.click()
  await expect(toggle).toHaveAttribute("aria-checked", "false")
  near(await box(toggle, from), off)
  await expect(actions.getByRole("button")).toHaveCount(2)
}

let sam: EntityId
let mira: EntityId
let chatId: string
test.beforeAll(async () => {
  sam = (await admin((api) => api.CreateCard({ label: "Sam", name: "Sam" }))).entityId
  mira = (await admin((api) => api.CreateCard({ label: "Mira", name: "Mira" }))).entityId
  await admin((api) => api.SetPersona({ entityId: sam, persona: true }))
  chatId = (
    await admin((api) =>
      api.StartChat({
        cards: [mira],
        persona: sam,
        greeting: null,
        first: { _tag: "Send", content: "A synthetic evening at the harbour.", speakerEntityId: sam }
      })
    )
  ).chat.id
})

for (const width of [1440, 390]) {
  test(`saved composer: one action with guidance, no shift, its hovers at ${width}`, async ({ page }) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/chats/${chatId}`)
    await settled(page)
    const composer = page.getByTestId("composer")
    const actions = actionsOf(page)
    const generate = actions.getByRole("button", { name: "Generate Sam", exact: true })
    await expect(generate).toBeEnabled()
    await checkToggle(page)
    // Guidance off: Generate's hover has no key, the arrow's (Enter triggers it) does.
    await hover(page, generate, "Let the model write Sam's next turn for you.")
    const pass = actions.getByRole("button", { name: "Mira replies", exact: true })
    await hover(page, pass, "Pass the turn: Mira replies next. (Enter)")
    await composer.fill("Synthetic line.")
    const send = actions.getByRole("button", { name: "Send as Sam", exact: true })
    await hover(page, send, "Send as Sam, then Mira replies. (Enter)")
    await composer.fill("")
    // Guidance on: one Generate, "(Enter)" at its end; with text, it follows the guidance.
    await toggleOf(page).click()
    await hover(page, generate, "Let the model write Sam's next turn for you. (Enter)")
    await composer.fill("Synthetic guidance.")
    await hover(page, generate, "Let the model write Sam's next turn for you, following your guidance. (Enter)")
    // Another character's turn isn't written "for you".
    await page.getByRole("button", { name: /^Speaking as / }).click()
    await page.getByRole("group", { name: "Speak as", exact: true }).getByRole("option", { name: "Mira" }).click()
    const generateMira = actions.getByRole("button", { name: "Generate Mira", exact: true })
    await hover(page, generateMira, "Let the model write Mira's next turn, following your guidance. (Enter)")
    await page.getByRole("button", { name: /^Speaking as / }).click()
    await page.getByRole("group", { name: "Speak as", exact: true }).getByRole("option", { name: "Sam" }).click()
    await expect(generate).toBeVisible()
    await composer.fill("")
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme })
      for (const guidance of [true, false]) {
        if ((await toggleOf(page).getAttribute("aria-checked")) !== String(guidance)) await toggleOf(page).click()
        await expectLayout(page, test.info(), `composer-${guidance ? "guidance" : "message"}-${width}-${theme}`, {
          scope: '[data-testid="composer-box"]'
        })
        await page.mouse.move(0, 0)
        await page.screenshot({
          path: join(shots, `composer-${guidance ? "guidance" : "message"}-${width}-${theme}.png`),
          animations: "disabled"
        })
      }
    }
    await page.emulateMedia({ colorScheme: "light" })
  })
}

test("Enter sends with guidance off and generates with guidance on", async ({ page }) => {
  test.setTimeout(120_000)
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chatId}`)
  await settled(page)
  const composer = page.getByTestId("composer")
  const articles = page.getByRole("article")
  await expect(toggleOf(page)).toHaveAttribute("aria-checked", "false")
  await composer.fill("Synthetic message sent with Enter.")
  await composer.press("Enter")
  // Sent as Sam, then Mira replies.
  await expect(articles.filter({ hasText: "Synthetic message sent with Enter." })).toHaveCount(1)
  await expect(articles.last()).not.toContainText("Synthetic message sent with Enter.", { timeout: 30_000 })
  await expect(articles.last().locator("header")).toContainText("Mira")
  await settled(page)
  await toggleOf(page).click()
  await composer.fill("Synthetic guidance with Enter.")
  await composer.press("Enter")
  // Sam's turn, written by the model with the guidance; nothing sent as a message.
  await expect.poll(() => textBoxValue(composer)).toBe("")
  await expect(articles.last()).toContainText("Guidance: Synthetic guidance with Enter.", { timeout: 30_000 })
  await expect(articles.filter({ hasText: "Synthetic guidance with Enter." })).toHaveCount(1)
  await expect(articles.last().locator("header")).toContainText("Sam")
  await settled(page)
  await toggleOf(page).click()
})

for (const width of [1440, 390]) {
  test(`new chat: one action with guidance, no shift, its hovers and Enter at ${width}`, async ({ page }) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    const card = await admin((api) => api.CreateCard({ label: `Wren ${width}`, name: `Wren ${width}` }))
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/cards/${card.entityId}/chat`)
    const composer = page.getByTestId("composer")
    await expect(composer).toBeEditable()
    await composer.fill("A synthetic first turn.")
    // The hint line under the box (job/composerhint1 removes it) wraps differently with guidance on
    // at 390 and moves the whole box; the toggle must not move within it.
    await checkToggle(page, page.getByTestId("composer-box"))
    const actions = actionsOf(page)
    const generate = actions.getByRole("button", { name: /^Generate / })
    const send = actions.getByRole("button", { name: /^Send/ })
    const sendName = (await send.getAttribute("aria-label"))!
    await hover(page, send, `${sendName}. (Enter)`)
    // Whose turn it is depends on the account's persona: read it from the hover, then check its shape.
    await page.mouse.move(0, 0)
    await generate.hover()
    const shown = page.getByText(/^Let the model write .+ next turn/).filter({ visible: true })
    await expect(shown).toBeVisible()
    const offText = (await shown.textContent())!
    expect(offText).toMatch(/^Let the model write .+ next turn( for you)?\.$/)
    await page.mouse.move(0, 0)
    await toggleOf(page).click()
    await expect(actions.getByRole("button")).toHaveCount(1)
    await hover(page, generate, offText.replace(/\.$/, ", following your guidance. (Enter)"))
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme })
      // The actions only: the new chat's Undo / history (UserDraftUndo) is a 32 px icon beside the
      // row's 36 px ones, which the audit reports on master too, apart from this change.
      await expectLayout(page, test.info(), `new-chat-guidance-${width}-${theme}`, {
        scope: '[data-testid="composer-controls"] > div:last-child'
      })
      await page.mouse.move(0, 0)
      await page.screenshot({ path: join(shots, `new-chat-guidance-${width}-${theme}.png`), animations: "disabled" })
    }
    await page.emulateMedia({ colorScheme: "light" })
    // Enter is Generate: the chat starts with the model's turn, the guidance gone from the box.
    await composer.press("Enter")
    await expect(page).toHaveURL(/\/chats\/[^/?]+(?:\?.*)?$/)
    await expect(page.getByRole("article").first()).toContainText("Guidance: A synthetic first turn.")
  })
}

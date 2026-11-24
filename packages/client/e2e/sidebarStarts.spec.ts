// The Chats tab's start buttons (owner, 2026-11-24: "This still needs to say 'New Roleplay/New
// Workshop' on the buttons, otherwise it's not obvious."): in All chats one row of New Roleplay and
// New Workshop, in the slot a character's "New Roleplay with <name>" has, so the list starts at the
// same height in both; each opens its chat not made yet and has the open menu; a workshop's row is
// marked. The row's labels read in full at every sidebar width. SIDEBAR_STARTS_SHOTS=<dir> saves
// the panel per scene. Synthetic chats only; no provider is called.
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, test, type Locator, type Page } from "@playwright/test"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
let entity = ""
test.beforeAll(async () => {
  await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const mira = yield* api.CreateCard({ label: "Mira", name: "Mira" })
      entity = mira.entityId
      const started = yield* api.StartChat({
        cards: [mira.entityId],
        persona: null,
        greeting: null,
        first: { _tag: "Send", content: "A synthetic start.", speakerEntityId: null }
      })
      yield* api.RenameChat({ chatId: started.chat.id, name: "Lamp story" })
      const workshop = yield* api.CreateWorkshop({})
      yield* api.RenameChat({ chatId: workshop.id, name: "Tidy the library" })
    })
  )
})

const shots = process.env.SIDEBAR_STARTS_SHOTS
const box = async (locator: Locator) => (await locator.boundingBox())!
const tooltip = (page: Page) => page.locator('[data-layout-overlay="Tooltip floats above the page"]')
const ROLEPLAY_HINT = "Start a new roleplay chat. Add characters from the Cast tab, or send with nobody in it."
const WORKSHOP_HINT =
  "Start a workshop: a chat with an assistant about your cards, presets and lorebooks, outside any story."

const setup = async (page: Page, width: number) => {
  await page.setViewportSize({ width, height: 900 })
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" })
  await page.addInitScript(() => localStorage.setItem("dreamspan.theme", "dark"))
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const phone = width === 390
  const scope = phone ? ".fixed.inset-0" : '[aria-label="Sidebar"]'
  const panel = page.locator(scope)
  const visit = async (query: string) => {
    await page.goto(`${server().url}/${query}`)
    if (phone) await page.getByRole("button", { name: "Chats and menu", exact: true }).click()
    await expect(panel.getByRole("link", { name: /^Open chat Lamp story/ }).first()).toBeVisible()
    await page.mouse.move(0, 0)
  }
  const shoot = async (scene: string) => {
    if (!shots) return
    mkdirSync(shots, { recursive: true })
    await panel.screenshot({ path: join(shots, `${scene}.png`), animations: "disabled" })
  }
  return { phone, scope, panel, visit, shoot }
}

for (const width of [1340, 1920, 390])
  test(`New Roleplay and New Workshop in the Chats tab at ${width}`, async ({ page }, info) => {
    test.setTimeout(120_000)
    const { phone, scope, panel, visit, shoot } = await setup(page, width)
    const roleplay = panel.getByRole("link", { name: "New Roleplay", exact: true })
    const workshop = panel.getByRole("link", { name: "New Workshop", exact: true })
    const firstSection = panel.locator("[data-shell-list] section").first()

    // All chats: both, side by side, one row as tall as a character's New Roleplay.
    await visit("")
    await expect(roleplay).toBeVisible()
    await expect(workshop).toBeVisible()
    const [r, w] = [await box(roleplay), await box(workshop)]
    expect(Math.abs(r.y - w.y)).toBeLessThanOrEqual(1)
    expect(Math.abs(r.height - w.height)).toBeLessThanOrEqual(1)
    expect(w.x - (r.x + r.width)).toBeCloseTo(8, 0)
    for (const link of [roleplay, workshop])
      expect(await link.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
    // The workshop's row is marked, as on its secondary line.
    const workshopRow = panel.getByRole("link", { name: /^Open chat Tidy the library/ })
    await expect(workshopRow.locator('[data-kind-badge="workshop"]')).toBeVisible()
    await expect(workshopRow).toHaveAccessibleName(/, Workshop$/)
    const all = { row: r, list: await box(firstSection) }
    await expectLayout(page, info, `sidebar-starts-all-${width}`, { scope })
    await shoot(`all-${width}-dark`)

    // Their hovers.
    await roleplay.hover()
    await expect(tooltip(page)).toHaveText(ROLEPLAY_HINT)
    await shoot(`all-${width}-dark-hover-roleplay`)
    await workshop.hover()
    await expect(tooltip(page)).toHaveText(WORKSHOP_HINT)
    await page.mouse.move(0, 0)

    // The open menu, as any app link has.
    await roleplay.click({ button: "right" })
    const menu = page.getByRole("menu")
    await expect(menu.getByRole("menuitem", { name: /^Open/ }).first()).toBeVisible()
    await expect(menu.getByRole("menuitem", { name: /Open in a new browser tab/ })).toBeVisible()
    await page.keyboard.press("Escape")

    // A character's chats: New Roleplay and New Workshop with them, in the same place; the list too.
    await visit(`?character=${entity}`)
    const withMira = panel.getByRole("link", { name: "New Roleplay with Mira", exact: true })
    const workshopMira = panel.getByRole("link", { name: "New Workshop with Mira", exact: true })
    await expect(withMira).toBeVisible()
    await expect(workshopMira).toBeVisible()
    const [cr, cw] = [await box(withMira), await box(workshopMira)]
    expect(Math.abs(cr.y - cw.y)).toBeLessThanOrEqual(1)
    expect(Math.abs(cr.y - all.row.y)).toBeLessThanOrEqual(1)
    expect(Math.abs(cr.height - all.row.height)).toBeLessThanOrEqual(1)
    expect(Math.abs((await box(firstSection)).y - all.list.y)).toBeLessThanOrEqual(1)
    expect(cw.x - (cr.x + cr.width)).toBeCloseTo(8, 0)
    await expectLayout(page, info, `sidebar-starts-character-${width}`, { scope })
    await shoot(`character-${width}-dark`)
    await withMira.hover()
    await expect(tooltip(page)).toHaveText("Start a new roleplay with Mira.")
    await workshopMira.hover()
    await expect(tooltip(page)).toHaveText(
      "Start a workshop with Mira as the assistant: for writing and editing cards, presets and lorebooks."
    )
    await page.mouse.move(0, 0)
    await workshopMira.click({ button: "right" })
    await expect(page.getByRole("menu").getByRole("menuitem", { name: /Open in a new browser tab/ })).toBeVisible()
    await page.keyboard.press("Escape")

    // New Workshop with Mira: a workshop whose assistant is Mira's card.
    await workshopMira.click()
    await expect(page).toHaveURL(/\/new\/workshop\?/)
    expect(new URL(page.url()).searchParams.get("workshopCard")).toBe(entity)
    await expect(
      page.locator("[data-workshop-intro]").getByRole("button", { name: "Assistant: Mira", exact: true })
    ).toBeVisible()

    // Each opens its chat not made yet.
    await visit("")
    await roleplay.click()
    await expect(page).toHaveURL(/\/new\/chat(\?|$)/)
    await expect(page.locator("[data-empty-chat-intro]")).toBeVisible()
    if (phone) await expect(panel).toHaveCount(0)
    await visit("")
    await workshop.click()
    await expect(page).toHaveURL(/\/new\/workshop(\?|$)/)
    await expect(page.locator("[data-workshop-intro]")).toBeVisible()
  })

// From the narrowest sidebar to wide: the labels read in full; side by side where both fit.
test("the start row at every sidebar width", async ({ page }, info) => {
  test.setTimeout(180_000)
  const { panel, scope } = await setup(page, 1920)
  const roleplay = panel.getByRole("link", { name: "New Roleplay", exact: true })
  const workshop = panel.getByRole("link", { name: "New Workshop", exact: true })
  const measured: Array<{ sidebar: number; stacked: boolean; names?: boolean }> = []
  for (const sbw of [220, 240, 260, 280, 320, 400, 560, 800]) {
    await page.goto(`${server().url}/?sbw=${sbw}`)
    await expect(roleplay).toBeVisible()
    await page.mouse.move(0, 0)
    const [r, w] = [await box(roleplay), await box(workshop)]
    const stacked = w.y > r.y + 1
    measured.push({ sidebar: Math.round((await box(panel)).width), stacked })
    for (const link of [roleplay, workshop])
      expect(await link.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
    if (stacked) expect(Math.abs(r.width - w.width)).toBeLessThanOrEqual(1)
    else expect(w.x - (r.x + r.width)).toBeCloseTo(8, 0)
    await expectLayout(page, info, `sidebar-starts-width-${sbw}`, { scope })
    if (shots && (sbw === 220 || sbw === 240 || sbw === 800)) {
      mkdirSync(shots, { recursive: true })
      await panel.screenshot({ path: join(shots, `width-${sbw}-dark.png`), animations: "disabled" })
    }
  }
  // A character's: their names after both labels where the row has room, else on neither.
  const withMira = panel.getByRole("link", { name: "New Roleplay with Mira", exact: true })
  const workshopMira = panel.getByRole("link", { name: "New Workshop with Mira", exact: true })
  const shown = (link: Locator) =>
    link.locator("[data-start-with]").evaluate((el) => getComputedStyle(el).visibility === "visible")
  for (const sbw of [220, 240, 280, 320, 360, 400, 560, 800]) {
    await page.goto(`${server().url}/?sbw=${sbw}&character=${entity}`)
    await expect(withMira).toBeVisible()
    await page.mouse.move(0, 0)
    const [r, w] = [await box(withMira), await box(workshopMira)]
    const stacked = w.y > r.y + 1
    const names = [await shown(withMira), await shown(workshopMira)]
    expect(names[0]).toBe(names[1])
    if (names[0]) expect(stacked).toBe(false)
    for (const link of [withMira, workshopMira])
      expect(await link.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
    if (stacked) expect(Math.abs(r.width - w.width)).toBeLessThanOrEqual(1)
    else expect(w.x - (r.x + r.width)).toBeCloseTo(8, 0)
    measured.push({ sidebar: sbw, stacked, names: names[0]! })
    await expectLayout(page, info, `sidebar-starts-character-width-${sbw}`, { scope })
    if (shots && (sbw === 220 || sbw === 320 || sbw === 560)) {
      mkdirSync(shots, { recursive: true })
      await panel.screenshot({ path: join(shots, `character-width-${sbw}-dark.png`), animations: "disabled" })
    }
  }
  await info.attach("sidebar widths", { body: JSON.stringify(measured, null, 2), contentType: "application/json" })
  console.log(JSON.stringify(measured))
  // The default width keeps them side by side.
  expect(measured.find((m) => m.sidebar >= 320)?.stacked).toBe(false)
  expect(measured.find((m) => m.sidebar === 800 && m.names !== undefined)?.names).toBe(true)
})

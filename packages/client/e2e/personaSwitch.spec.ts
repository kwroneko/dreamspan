// The Persona switch (owner, 2026-11-02): in a card's header, in the chat panel's character tab
// and the full editor, and on its page, it puts the card in the persona folder or takes it out,
// and the lists follow at once, without a reload. And Add characters' Include personas: off by
// default, remembered, the personas marked when they're included. Every card is made up.
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import type { EntityId } from "@rp/shared/chat.ts"
import { expect, type Locator, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { openPanel } from "./support/panel.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
test.setTimeout(120_000)

const HINT = "Mark this card as a persona: a card you play as, listed under Personas."
const shots = process.env.SCREENSHOT_DIR
const shoot = async (target: Page | Locator, name: string) => {
  if (!shots) return
  mkdirSync(shots, { recursive: true })
  await target.screenshot({ path: join(shots, `${name}.png`) })
}

const ids = new Map<string, { entityId: EntityId; refId: string }>()
let chatId = ""
test.beforeAll(async () => {
  await admin((api) =>
    Effect.gen(function* () {
      for (const name of ["Rook", "Sable", "Tamsin", "Corin", "Pia", "Nell"]) {
        const card = yield* api.CreateCard({ label: name, name })
        ids.set(name, { entityId: card.entityId as EntityId, refId: card.id })
        if (name === "Pia" || name === "Nell") yield* api.SetPersona({ entityId: card.entityId, persona: true })
      }
      // Rook in a chat, played as Pia, with a line written there.
      const chat = yield* api.CreateChat({ title: "Harbor" })
      for (const change of [
        { _tag: "Join", entityId: ids.get("Rook")!.entityId },
        { _tag: "Persona", entityId: ids.get("Pia")!.entityId }
      ] as const)
        yield* api.ChangeCast({ chatId: chat.id, slotId: null, change })
      yield* api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "Evening.", reply: false })
      chatId = chat.id
    })
  )
})

const personaSwitch = (scope: Locator | Page) => scope.getByRole("button", { name: "Persona", exact: true })

/** The home page's Personas tab, reached in the app (no reload), and its tiles. */
const homePersonas = async (page: Page) => {
  // The left panel's link on a wide screen, the top bar's on a phone.
  await page.getByRole("link", { name: "Characters", exact: true }).filter({ visible: true }).first().click()
  const main = page.getByRole("main")
  await main.getByRole("group", { name: "Show", exact: true }).getByRole("button", { name: "Personas" }).click()
  return main
    .getByLabel("Characters", { exact: true })
    .getByRole("button", { name: /^Open / })
    .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("aria-label")).sort())
}

/** Back through the app's history (no reload) to the page whose path starts with `path`. */
const backTo = async (page: Page, path: string) => {
  for (let i = 0; i < 4 && !new URL(page.url()).pathname.startsWith(path); i++) await page.goBack()
  expect(new URL(page.url()).pathname).toContain(path)
}

test("the side panel's character tab: on and off, and the left panel's Personas follow", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chatId}?panel=card:${ids.get("Rook")!.entityId}`)
  const tab = page.getByRole("tabpanel", { name: "Rook", exact: true })
  await expect(tab.locator("[data-card-tokens]")).toBeVisible({ timeout: 30_000 })
  const header = tab.locator("[data-card-header]")
  const height = (await header.boundingBox())!.height
  const toggle = personaSwitch(header)
  await expect(toggle).toHaveAttribute("aria-pressed", "false")
  await toggle.hover()
  await expect(page.getByText(HINT, { exact: true }).filter({ visible: true })).toBeVisible()
  await shoot(page.getByRole("complementary", { name: "Chat panel" }), "panel-off")

  // The left panel's grid, on Personas: Rook isn't there yet.
  const left = page.getByRole("complementary").first()
  await left.getByRole("group", { name: "Left panel", exact: true }).getByText("Characters").click()
  const show = left.getByRole("combobox", { name: "Show" })
  await show.click()
  await page.getByRole("option", { name: /^Personas/ }).click()
  const tiles = left.getByLabel("Characters", { exact: true })
  await expect(tiles.getByRole("button", { name: /^Open Pia/ })).toBeVisible()
  await expect(tiles.getByRole("button", { name: /^Open Rook/ })).toHaveCount(0)

  await toggle.click()
  await expect(toggle).toHaveAttribute("aria-pressed", "true")
  await expect(tiles.getByRole("button", { name: /^Open Rook/ })).toBeVisible()
  // The switch is a row the header already had room for: the header keeps its height.
  expect(Math.abs((await header.boundingBox())!.height - height)).toBeLessThanOrEqual(1)
  await shoot(page.getByRole("complementary", { name: "Chat panel" }), "panel-on")

  await toggle.click()
  await expect(toggle).toHaveAttribute("aria-pressed", "false")
  await expect(tiles.getByRole("button", { name: /^Open Rook/ })).toHaveCount(0)
})

for (const width of [1440, 390]) {
  test(`${width}: the full editor and the card page: on and off, and home's Personas follow`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    const name = width === 1440 ? "Sable" : "Tamsin"
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/library/${ids.get(name)!.refId}`)
    const header = page.getByRole("main").locator("[data-card-header]")
    await expect(header.locator("[data-card-tokens]")).toBeVisible({ timeout: 30_000 })
    const toggle = personaSwitch(header)
    await expect(toggle).toHaveAttribute("aria-pressed", "false")
    await toggle.click()
    await expect(toggle).toHaveAttribute("aria-pressed", "true")
    await shoot(page, `editor-${width}`)
    await expect.poll(() => homePersonas(page)).toContain(`Open ${name}`)

    // Back in the editor (the app's history, no reload): on, and switched off there.
    await backTo(page, "/library/")
    await expect(toggle).toHaveAttribute("aria-pressed", "true")
    await toggle.click()
    await expect(toggle).toHaveAttribute("aria-pressed", "false")
    await expect.poll(() => homePersonas(page)).not.toContain(`Open ${name}`)

    // The card page has it too.
    await page.goto(`${server().url}/cards/${ids.get(name)!.entityId}`)
    const onPage = personaSwitch(page.getByRole("main"))
    await expect(onPage).toHaveAttribute("aria-pressed", "false")
    await onPage.click()
    await expect(onPage).toHaveAttribute("aria-pressed", "true")
    await shoot(page, `cardpage-${width}`)
    await expect.poll(() => homePersonas(page)).toContain(`Open ${name}`)
    await backTo(page, "/cards/")
    await onPage.click()
    await expect(onPage).toHaveAttribute("aria-pressed", "false")
    await expect.poll(() => homePersonas(page)).not.toContain(`Open ${name}`)
  })
}

test("Add characters: Include personas, off at first, marked when on, remembered", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chatId}`)
  const cast = await openPanel(page, "Cast")
  const toggle = cast.getByRole("button", { name: "Add characters", exact: true })
  if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click()
  const section = cast.getByRole("region", { name: "Add characters", exact: true })
  const tiles = () =>
    section
      .getByLabel("Characters", { exact: true })
      .getByRole("button")
      .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("aria-label")).sort())
  const include = section.getByRole("button", { name: "Include personas", exact: true })

  // Off by default: the personas aren't among All's characters.
  await expect(include).toHaveAttribute("aria-pressed", "false")
  await expect.poll(tiles).toContain("Add Corin to this chat")
  await expect.poll(tiles).not.toContain("Add Nell to this chat")
  await expect(section.locator("[data-persona-badge]")).toHaveCount(0)
  await include.hover()
  await expect(page.getByText("Click to show personas", { exact: true }).filter({ visible: true })).toBeVisible()

  // On: mixed in and marked, Pia (played here) and Nell.
  await include.click()
  await expect.poll(tiles).toContain("Add Nell to this chat")
  await expect.poll(tiles).toContain("Pia: you play them here")
  await expect(section.locator("[data-persona-badge]")).toHaveCount(2)
  await expect(section.getByRole("combobox", { name: "Show" })).toContainText("All · 6")
  await shoot(page, "castadd-included")

  // Remembered after a reload.
  await page.reload()
  const again = await openPanel(page, "Cast")
  const section2 = again.getByRole("region", { name: "Add characters", exact: true })
  await expect(section2.getByRole("button", { name: "Include personas", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true"
  )
  await expect(section2.locator("[data-persona-badge]")).toHaveCount(2)

  // Under Personas there's no toggle, and nothing is marked: every card there is one.
  await section2.getByRole("combobox", { name: "Show" }).click()
  await page.getByRole("option", { name: /^Personas/ }).click()
  await expect(section2.getByRole("button", { name: "Include personas", exact: true })).toHaveCount(0)
  await expect(section2.locator("[data-persona-badge]")).toHaveCount(0)
  await section2.getByRole("combobox", { name: "Show" }).click()
  await page.getByRole("option", { name: /^All/ }).click()
  await section2.getByRole("button", { name: "Include personas", exact: true }).click()
  await expect(section2.locator("[data-persona-badge]")).toHaveCount(0)
})

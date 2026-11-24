// The left panel's breadcrumbs sit below every filter row, directly above the list they
// navigate (owner, 2026-11-23), in each scope of the Chats tab; showing or hiding them moves
// only the list. SIDEBAR_CRUMBS_SHOTS=<dir> also saves the panel per scene.
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, test, type Locator, type Page } from "@playwright/test"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
let entity = ""
let chatId = ""
test.beforeAll(async () => {
  await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const mira = yield* api.CreateCard({ label: "Mira", name: "Mira" })
      const wren = yield* api.CreateCard({ label: "Wren", name: "Wren" })
      entity = mira.entityId
      for (const [name, cards] of [
        ["Lamp story", [mira.entityId]],
        ["Harbour pair", [mira.entityId, wren.entityId]]
      ] as const) {
        const started = yield* api.StartChat({
          cards,
          persona: null,
          greeting: null,
          first: { _tag: "Send", content: "A synthetic start.", speakerEntityId: null }
        })
        yield* api.RenameChat({ chatId: started.chat.id, name })
        if (name === "Lamp story") {
          chatId = started.chat.id
          yield* api.CreateFork({
            chatId: started.chat.id,
            fromForkId: null,
            atSlotId: started.chat.activeLeafSlotId,
            name: "Another path"
          })
        }
      }
    })
  )
})

const shots = process.env.SIDEBAR_CRUMBS_SHOTS
const phase = process.env.SIDEBAR_CRUMBS_PHASE ?? "shot"
const box = async (locator: Locator) => (await locator.boundingBox())!
const bottom = (b: { y: number; height: number }) => b.y + b.height

for (const width of [1440, 390])
  test(`filters, then breadcrumbs, then the list at ${width}`, async ({ page }, info) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width, height: 900 })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const scope = width === 390 ? ".fixed.inset-0" : '[aria-label="Sidebar"]'
    const panel = page.locator(scope)
    const crumbs = panel.getByRole("navigation", { name: "Chat breadcrumbs", exact: true })
    const filters = panel.getByLabel("Chat filters and sorting", { exact: true })
    const search = panel.locator('[class~="@container/leftsearch"]')
    const list = panel.locator("[data-shell-list]")
    const visit = async (query: string, ready: (p: Page) => Promise<void>) => {
      await page.goto(`${server().url}/${query}`)
      if (width === 390) await page.getByRole("button", { name: "Chats and menu", exact: true }).click()
      await ready(page)
      await page.mouse.move(0, 0)
    }
    const shoot = async (scene: string) => {
      if (!shots) return
      mkdirSync(shots, { recursive: true })
      await panel.screenshot({ path: join(shots, `${phase}-${width}-${scene}.png`), animations: "disabled" })
    }

    // All chats: its one crumb, where you are, so the list starts where a character's does.
    await visit("", async () => {
      await expect(panel.getByRole("link", { name: "Open chat Lamp story" }).first()).toBeVisible()
    })
    await expect(crumbs).toHaveText("All chats")
    await shoot("all")
    const all = { search: await box(search), filters: await box(filters), list: await box(list) }

    // A character's chats: the crumbs come after the filter row, before the list.
    await visit(`?character=${entity}`, async () => {
      await expect(crumbs).toContainText("Mira")
      await expect(panel.getByRole("region", { name: /^(Just Mira|With others)$/ }).first()).toBeVisible()
    })
    await shoot("character")
    const character = {
      search: await box(search),
      filters: await box(filters),
      crumbs: await box(crumbs),
      list: await box(list)
    }
    expect.soft(character.crumbs.y).toBeGreaterThanOrEqual(bottom(character.filters))
    expect.soft(character.list.y).toBeGreaterThanOrEqual(bottom(character.crumbs))
    // Nothing moves: the crumbs' line is there in All chats too (owner, 2026-11-24).
    expect.soft(Math.abs(character.search.y - all.search.y)).toBeLessThanOrEqual(1)
    expect.soft(Math.abs(character.filters.y - all.filters.y)).toBeLessThanOrEqual(1)
    expect.soft(Math.abs(character.list.y - all.list.y)).toBeLessThanOrEqual(1)
    if (process.env.LAYOUT_AUDIT) await expectLayout(page, info, `sidebar-crumbs-${width}-character`, { scope })

    // Back to all chats from the crumbs: the filter row stays where it was.
    await crumbs.getByRole("button", { name: "All chats", exact: true }).click()
    await expect(crumbs).toHaveText("All chats")
    expect.soft(Math.abs((await box(filters)).y - all.filters.y)).toBeLessThanOrEqual(1)
    expect.soft(Math.abs((await box(list)).y - all.list.y)).toBeLessThanOrEqual(1)

    // A chat's branches: no filter row there; the crumbs still come last, above the list.
    await visit(`?forks=${chatId}`, async () => {
      await expect(crumbs).toContainText("Lamp story")
      await expect(panel.getByRole("region", { name: /^(Named branches|Branches)$/ }).first()).toBeVisible()
    })
    await shoot("chat")
    await expect(filters).toHaveCount(0)
    const chat = { search: await box(search), crumbs: await box(crumbs), list: await box(list) }
    expect.soft(chat.crumbs.y).toBeGreaterThanOrEqual(bottom(chat.search))
    expect.soft(chat.list.y).toBeGreaterThanOrEqual(bottom(chat.crumbs))
    expect.soft(Math.abs(chat.search.y - all.search.y)).toBeLessThanOrEqual(1)
    if (process.env.LAYOUT_AUDIT) await expectLayout(page, info, `sidebar-crumbs-${width}-chat`, { scope })

    // The Characters tab has no breadcrumbs.
    await panel
      .getByRole("group", { name: "Left panel", exact: true })
      .getByRole("button", { name: "Characters", exact: true })
      .click()
    await expect(panel.getByRole("textbox", { name: "Find a character", exact: true })).toBeVisible()
    await expect(crumbs).toHaveCount(0)
    await shoot("characters-tab")
  })

// The search box's × (owner, 2026-11-23): inside its end, only with text, no background,
// "Clear" on hover; it empties the box as typing would (the URL follows) and keeps the caret.
for (const width of [1440, 390])
  test(`the search box's clear button at ${width}`, async ({ page }, info) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width, height: 900 })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const scope = width === 390 ? ".fixed.inset-0" : '[aria-label="Sidebar"]'
    const panel = page.locator(scope)
    await page.goto(server().url)
    if (width === 390) await page.getByRole("button", { name: "Chats and menu", exact: true }).click()
    await expect(panel.getByRole("link", { name: "Open chat Lamp story" }).first()).toBeVisible()
    const clear = panel.getByRole("button", { name: "Clear", exact: true })
    for (const [name, messages] of [
      ["Find a chat", false],
      ["Find in messages", true]
    ] as const) {
      if (messages) await panel.getByRole("button", { name: "Search message text", exact: true }).click()
      const input = panel.getByRole("textbox", { name, exact: true })
      await expect(clear).toHaveCount(0)
      const empty = await box(input)
      await input.fill("Lamp")
      await expect(clear).toBeVisible()
      // The box keeps its size; its text stops short of the button, which sits inside its end.
      const filled = await box(input)
      expect(filled).toEqual(empty)
      const button = await box(clear)
      expect(button.x + button.width).toBeLessThanOrEqual(filled.x + filled.width + 1)
      expect(button.y).toBeGreaterThanOrEqual(filled.y - 1)
      expect(bottom(button)).toBeLessThanOrEqual(bottom(filled) + 1)
      const padding = await input.evaluate((el) => parseFloat(getComputedStyle(el).paddingInlineEnd))
      expect(padding).toBeGreaterThanOrEqual(button.width)
      await expect(clear).toHaveCSS("background-color", "rgba(0, 0, 0, 0)")
      if (shots) {
        mkdirSync(shots, { recursive: true })
        await panel
          .locator('[class~="@container/leftsearch"]')
          .screenshot({ path: join(shots, `${phase}-${width}-clear-${messages ? "messages" : "names"}.png`) })
      }
      if (process.env.LAYOUT_AUDIT)
        await expectLayout(page, info, `sidebar-clear-${width}-${messages ? "messages" : "names"}`, {
          scope: `${scope} [class~="@container/leftsearch"]`
        })
      await expect(page).toHaveURL(/sideQ=Lamp/)
      await clear.hover()
      await expect(page.getByText("Clear", { exact: true }).filter({ visible: true })).toBeVisible()
      await clear.click()
      await expect(input).toHaveValue("")
      await expect(input).toBeFocused()
      await expect(clear).toHaveCount(0)
      await expect(page).not.toHaveURL(/sideQ=/)
      expect(await box(input)).toEqual(empty)
    }
  })

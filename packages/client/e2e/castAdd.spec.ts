// The Cast tab's Add characters (owner, 2026-11-01; ST's group "Add Members"): under the cast,
// collapsed until opened and remembered so, the left panel's character grid with its filter,
// sort and search; tiles open the full editor, separate Add controls join characters, and who's in the
// chat is marked and can't be added again. At a desktop's width and a phone's, in both themes.
// Every card is made up.
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import type { EntityId } from "@rp/shared/chat.ts"
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { openPanel } from "./support/panel.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
test.setTimeout(120_000)

const shots = process.env.SCREENSHOT_DIR
const shoot = async (page: Page, name: string) => {
  if (!shots) return
  mkdirSync(shots, { recursive: true })
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme })
    await page.screenshot({ path: join(shots, `${name}-${colorScheme}.png`) })
  }
  await page.emulateMedia({ colorScheme: "light" })
}

const ids = new Map<string, EntityId>()
test.beforeAll(async () => {
  await admin((api) =>
    Effect.gen(function* () {
      for (const name of ["Mira", "Tobin", "Wren", "Tess", "Wade", "Ana", "Bo"]) {
        const card = yield* api.CreateCard({ label: name, name })
        ids.set(name, card.entityId as EntityId)
        if (name === "Ana" || name === "Bo") yield* api.SetPersona({ entityId: card.entityId, persona: true })
      }
    })
  )
})

/** A chat per width: Mira in it, played as Bo; two characters per width and Ana (a persona) to add. */
const chatFor = (title: string) =>
  admin((api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title })
      for (const change of [
        { _tag: "Join", entityId: ids.get("Mira")! },
        { _tag: "Persona", entityId: ids.get("Bo")! }
      ] as const)
        yield* api.ChangeCast({ chatId: chat.id, slotId: null, change })
      // A line written with Mira there: only then has she been in the chat (castpresence).
      yield* api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "Evening.", reply: false })
      return chat.id
    })
  )

const castTab = (page: Page) => page.getByRole("tabpanel", { name: "Cast" })
const members = (page: Page) => castTab(page).getByRole("list", { name: "Characters in this chat" })
const section = (page: Page) => castTab(page).getByRole("region", { name: "Add characters", exact: true })
const toggle = (page: Page) => castTab(page).getByRole("button", { name: "Add characters", exact: true })
const tileLabels = (page: Page) =>
  section(page)
    .getByLabel("Characters", { exact: true })
    .getByRole("button", { name: /^Add .* to this chat$|: in this chat$|: you play them here$/ })
    .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("aria-label")).sort())

for (const width of [1440, 1024, 390]) {
  test(`${width}: Add characters, collapsed at first; filter, search, add two, the cast marked`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    // Each width adds its own two, never used until it does, whatever the other width added.
    const [one, two] = width === 1440 ? ["Tobin", "Wren"] : ["Tess", "Wade"]
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const chatId = await chatFor(`Harbor ${width}`)
    await page.goto(`${server().url}/chats/${chatId}`)
    await openPanel(page, "Cast")
    await expect(members(page).getByRole("listitem")).toHaveCount(1)

    // Collapsed by default: no grid until it's opened.
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "false")
    await expect(section(page).getByRole("searchbox")).toHaveCount(0)
    if (width === 1440) {
      await toggle(page).hover()
      await expect(page.getByText("Click to show characters to add to this chat", { exact: true })).toBeVisible()
    }
    await shoot(page, `castadd-collapsed-${width}`)
    await toggle(page).click()
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "true")

    // The grid shares the field's insets and the same gap as the controls above.
    const geometry = await section(page).evaluate((el) => {
      const field = el.querySelector("input")!.getBoundingClientRect()
      const grid = el.querySelector('[aria-label="Characters"]')!.getBoundingClientRect()
      const controls = el.querySelector(
        '[data-layout-overlay="Add characters controls stay over the grid while it scrolls"]'
      )!
      const filters = controls.lastElementChild!.getBoundingClientRect()
      return {
        left: grid.left - field.left,
        right: grid.right - field.right,
        above: filters.top - field.bottom,
        below: grid.top - filters.bottom
      }
    })
    expect(Math.abs(geometry.left)).toBeLessThan(1)
    expect(Math.abs(geometry.right)).toBeLessThan(1)
    expect(geometry.below).toBe(8)
    expect(geometry.below).toBe(geometry.above)

    // Every tile opens the full center editor, including a character already in the chat.
    const originalUrl = new URL(page.url())
    if (width === 390) originalUrl.searchParams.delete("panel")
    await section(page).getByRole("button", { name: "Open Mira", exact: true }).click()
    const editor = page.getByRole("dialog", { name: "Card editor", exact: true })
    await expect(editor).toBeVisible()
    await expect(page).toHaveURL(/editor=/)
    await editor.getByRole("button", { name: "Close", exact: true }).click()
    await expect(editor).toHaveCount(0)
    await expect(page).toHaveURL(originalUrl.toString())
    if (width === 390) await openPanel(page, "Cast")
    await expect(members(page).getByRole("listitem")).toHaveCount(1)

    // Mira's separate Add target stays disabled; her tile remains openable.
    const mira = section(page).getByRole("button", { name: "Mira: in this chat", exact: true })
    await expect(mira).toHaveAttribute("aria-disabled", "true")
    await expect(mira).toHaveText("In this chat")
    const tile = mira.locator("xpath=ancestor::div[contains(@class, 'tile-toggle-surface')]")
    const openTile = tile.getByRole("button", { name: "Open Mira", exact: true })
    const [outerBox, openBox, footerBox] = await Promise.all([
      tile.boundingBox(),
      openTile.boundingBox(),
      mira.boundingBox()
    ])
    expect(outerBox).not.toBeNull()
    expect(openBox).not.toBeNull()
    expect(footerBox).not.toBeNull()
    expect(Math.abs(footerBox!.x - outerBox!.x - 1)).toBeLessThan(1)
    expect(Math.abs(footerBox!.width - outerBox!.width + 2)).toBeLessThan(1)
    expect(Math.abs(footerBox!.y - openBox!.y - openBox!.height)).toBeLessThan(1)
    expect(footerBox!.y + footerBox!.height).toBeLessThanOrEqual(outerBox!.y + outerBox!.height)
    await expect(mira).toHaveCSS("border-top-width", "1px")
    await expect(section(page).getByLabel("Characters", { exact: true })).toContainText("In this chat")
    if (width === 1440) {
      await mira.hover()
      await expect(
        page.getByText("Mira is already in this chat", { exact: true }).filter({ visible: true })
      ).toBeVisible()
    }

    await expect(members(page).getByRole("listitem")).toHaveCount(1)
    // Ana and Bo are in the persona folder: not among All's characters, but under Personas,
    // which lists only personas and so marks none, Bo who is played in this chat included.
    await expect.poll(() => tileLabels(page)).not.toContain("Add Ana to this chat")
    const show = section(page).getByRole("combobox", { name: "Show" })
    await show.click()
    await page.getByRole("option", { name: /^Personas/ }).click()
    await expect.poll(() => tileLabels(page)).toEqual(["Add Ana to this chat", "Bo: you play them here"])
    await expect(section(page).locator("[data-persona-badge]")).toHaveCount(0)

    // The filter: Never used leaves out Mira, who has this chat; no Groups.
    await show.click()
    await expect(page.getByRole("option", { name: /^Groups/ })).toHaveCount(0)
    await page.getByRole("option", { name: /^Never used/ }).click()
    await expect
      .poll(() => tileLabels(page))
      .toEqual(expect.arrayContaining([`Add ${one} to this chat`, `Add ${two} to this chat`]))
    await expect.poll(() => tileLabels(page)).not.toContain("Mira: in this chat")
    await expect.poll(() => tileLabels(page)).not.toContain("Add Ana to this chat")
    await show.click()
    await page.getByRole("option", { name: /^All/ }).click()
    // The search: by name.
    const search = section(page).getByRole("searchbox", { name: "Find a character to add" })
    await search.fill(two.slice(0, 2).toLowerCase())
    await expect.poll(() => tileLabels(page)).toEqual([`Add ${two} to this chat`])
    await search.fill("")

    await section(page)
      .getByRole("button", { name: `Open ${one}`, exact: true })
      .focus()
    await page.keyboard.press("Enter")
    await expect(editor).toBeVisible()
    await editor.getByRole("button", { name: "Close", exact: true }).click()
    if (width === 390) await openPanel(page, "Cast")
    await expect(members(page).getByRole("listitem")).toHaveCount(1)

    await expect(section(page).getByRole("button", { name: `Add ${one} to this chat`, exact: true })).toHaveText(
      "Add to chat"
    )

    // Two in a row, the grid staying open: each joins, and is marked.
    await section(page)
      .getByRole("button", { name: `Add ${one} to this chat`, exact: true })
      .click()
    await section(page)
      .getByRole("button", { name: `Add ${two} to this chat`, exact: true })
      .press("Enter")
    await expect(members(page).getByRole("listitem")).toHaveCount(3)
    await expect(members(page)).toContainText(one)
    await expect(members(page)).toContainText(two)
    await expect(section(page).getByRole("button", { name: `${one}: in this chat`, exact: true })).toBeVisible()
    await expect(section(page).getByRole("button", { name: `${two}: in this chat`, exact: true })).toBeVisible()
    await expect(section(page).getByRole("status")).toHaveText(`${two} joined the chat.`)
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "true")
    await shoot(page, `castadd-added-${width}`)

    // Open stays open, on this device.
    await page.reload()
    await openPanel(page, "Cast")
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "true")
    await expect(section(page).getByRole("button", { name: `${two}: in this chat`, exact: true })).toBeVisible()

    if (width === 1440) {
      // The speaker switcher's Add to chat lands on it, open, the search focused.
      await toggle(page).click()
      await expect(toggle(page)).toHaveAttribute("aria-expanded", "false")
      await page.getByRole("tab", { name: "This chat" }).click()
      await page.getByRole("button", { name: /^Speaking as Bo/ }).click()
      // No one here by that name: the switcher offers Add to chat.
      await page.keyboard.type("Harbor")
      await page.getByRole("button", { name: "Add to chat", exact: true }).click()
      await expect(toggle(page)).toHaveAttribute("aria-expanded", "true")
      await expect(section(page).getByRole("searchbox", { name: "Find a character to add" })).toBeFocused()
    }
  })
}

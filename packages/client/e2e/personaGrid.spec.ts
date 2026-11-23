// Persona tiles look as character tiles do (owner, 2026-11-23): nothing of a tile draws outside
// its box, so no row of buttons or badges stands between grid rows, and a persona's one action
// (the default persona) is in the tile's right-click menu. Every card is made up.
import { mkdirSync } from "node:fs"
import { expect, test, type Locator, type Page } from "@playwright/test"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
test.setTimeout(120_000)
const PERSONAS = ["Pia", "Quill", "Rhea", "Sol", "Tamsin", "Uma", "Vex", "Wren", "Xan"]
const shots = process.env.PERSONA_GRID_SHOTS
// The layout audit (layoutlint) of the grids, with LAYOUT_AUDIT=1 as the other specs run it.
const audit = !!process.env.LAYOUT_AUDIT
const GRID = 'main [aria-label="Characters"]'

test.beforeAll(async () => {
  await admin((api) =>
    Effect.gen(function* () {
      for (const name of PERSONAS) {
        const card = yield* api.CreateCard({ label: name, name })
        yield* api.SetPersona({ entityId: card.entityId, persona: true })
      }
      const mira = yield* api.CreateCard({ label: "Mira", name: "Mira" })
      // A fork: its badge is on a line inside the character's tile.
      yield* api.ForkCard({ refId: mira.id, name: "Mira", nickname: "", characterVersion: "winter" })
      for (const name of ["Corin", "Delia", "Ember", "Faye", "Gale"]) yield* api.CreateCard({ label: name, name })
      yield* api.ChangeGenerationDefaults({ change: { persona: null } })
    })
  )
})

/**
 * Every tile's parts lie inside its box, and rows stand exactly the grid's row gap apart: no
 * row of their own between them. Tiles off screen are laid out first (content-visibility).
 */
const expectTilesContained = async (grid: Locator, label: string) => {
  const report = await grid.evaluate((el) => {
    const tiles = [...el.children].filter((child) => child instanceof HTMLElement)
    const outside: string[] = []
    for (const tile of tiles) {
      tile.style.setProperty("content-visibility", "visible")
      // The box drawn: the first part with a border all round (the grid item's, or a link inside it).
      const framed =
        [tile, ...tile.querySelectorAll("*")].find((e) =>
          ["Top", "Bottom", "Left", "Right"].every(
            (side) => parseFloat(getComputedStyle(e).getPropertyValue(`border-${side.toLowerCase()}-width`)) > 0
          )
        ) ?? tile
      const box = framed.getBoundingClientRect()
      for (const part of tile.querySelectorAll("*")) {
        const r = part.getBoundingClientRect()
        if (r.width === 0 || r.height === 0) continue
        if (
          r.left < box.left - 0.5 ||
          r.right > box.right + 0.5 ||
          r.top < box.top - 0.5 ||
          r.bottom > box.bottom + 0.5
        )
          outside.push(
            `${tile.textContent?.slice(0, 20)}: <${part.tagName.toLowerCase()}> ${part.getAttribute("aria-label") ?? ""}`
          )
      }
    }
    // Rows by their tops (within a pixel), each with its lowest bottom.
    const rows: Array<{ top: number; bottom: number }> = []
    for (const r of tiles.map((tile) => tile.getBoundingClientRect()).sort((a, b) => a.top - b.top)) {
      const row = rows.at(-1)
      if (row && r.top - row.top < 1) row.bottom = Math.max(row.bottom, r.bottom)
      else rows.push({ top: r.top, bottom: r.bottom })
    }
    const gaps = rows.slice(1).map((row, i) => row.top - rows[i]!.bottom)
    return {
      tiles: tiles.length,
      outside,
      gaps,
      rowGap: parseFloat(getComputedStyle(el).rowGap),
      siblings: [...el.children].length
    }
  })
  expect(report.tiles, label).toBeGreaterThan(1)
  expect(report.outside, label).toEqual([])
  expect(report.gaps.length, `${label}: more than one row`).toBeGreaterThan(0)
  // Rows start at fractions of a pixel; a row of its own would add at least a button's height.
  for (const gap of report.gaps)
    expect(Math.abs(gap - report.rowGap), `${label}: the gap between rows`).toBeLessThan(1.5)
}

const shot = async (page: Page, name: string) => {
  if (!shots) return
  mkdirSync(shots, { recursive: true })
  await page.screenshot({ path: `${shots}/${name}.png` })
}

for (const width of [1440, 390])
  test(`${width}: persona and character tiles keep everything inside, and the default is in the right-click menu`, async ({
    page
  }, info) => {
    await page.setViewportSize({ width, height: 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/?show=personas`)
    const main = page.getByRole("main")
    const grid = main.getByLabel("Characters", { exact: true })
    await expect(grid.getByRole("link", { name: /^Open / })).toHaveCount(PERSONAS.length)
    await expectTilesContained(grid, `${width} personas`)
    // No button of its own: the tile is the whole thing, as a character's is.
    await expect(grid.getByRole("button", { name: /^Persona actions for/ })).toHaveCount(0)

    // Right-click: the default persona, and its badge on a line inside the tile.
    const tile = grid.getByRole("link", { name: "Open Rhea", exact: true })
    await tile.click({ button: "right" })
    await page.getByRole("menuitem", { name: "Set as default persona", exact: true }).click()
    await expect.poll(async () => (await admin((api) => api.GetGenerationDefaults())).persona).not.toBeNull()
    await expect(grid.locator("[data-default-persona]")).toHaveCount(1)
    await expectTilesContained(grid, `${width} personas with a default`)
    await shot(page, `default-home-${width}`)
    if (audit) await expectLayout(page, info, `persona-grid-${width}`, { scope: GRID })
    await tile.click({ button: "right" })
    await page.getByRole("menuitem", { name: "Clear default persona", exact: true }).click()
    await expect(grid.locator("[data-default-persona]")).toHaveCount(0)

    // Character tiles: a fork's badge is inside its tile too; no default persona item for them.
    await page.goto(`${server().url}/?show=all`)
    await expect(grid.getByRole("link", { name: "Open Corin", exact: true })).toBeVisible()
    await expect(grid.getByRole("button", { name: /^Forks of / }).first()).toBeVisible()
    await expectTilesContained(grid, `${width} characters`)
    if (audit) await expectLayout(page, info, `character-grid-${width}`, { scope: GRID })
    await grid.getByRole("link", { name: "Open Corin", exact: true }).click({ button: "right" })
    await expect(page.getByRole("menuitem", { name: "Open", exact: true })).toBeVisible()
    await expect(page.getByRole("menuitem", { name: "Set as default persona", exact: true })).toHaveCount(0)
    await page.keyboard.press("Escape")

    // The library's persona grid: its visible More actions trigger stays inside the tile and opens.
    await page.goto(`${server().url}/library?show=personas&view=grid`)
    const library = main.getByRole("list", { name: "Cards" })
    await expect(library.locator(":scope > li")).toHaveCount(PERSONAS.length)
    await expectTilesContained(library, `${width} library personas`)
    await shot(page, `default-library-${width}`)
    if (audit) await expectLayout(page, info, `library-persona-grid-${width}`, { scope: 'main ul[aria-label="Cards"]' })
    await library.getByRole("button", { name: "More actions for Pia", exact: true }).click()
    await expect(page.getByRole("menuitem", { name: "Set as default persona", exact: true })).toBeVisible()
  })

// The library at a heavy user's scale: the realistic synthetic ST folder plus 420 more cards
// with pictures, long names, personas and forks. Every name is made up.
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { crc32, deflateSync } from "node:zlib"
import { expect, test, type Page } from "@playwright/test"
import { Effect } from "effect"
import { writeRealisticStFolder } from "../../server/test/support/stRealistic.ts"
import { cardChunk } from "../../server/test/formats/support.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)

const pngChunk = (type: string, data: Uint8Array) => {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data])
  const out = Buffer.alloc(body.length + 8)
  out.writeUInt32BE(data.length, 0)
  body.copy(out, 4)
  out.writeUInt32BE(crc32(body), body.length + 4)
  return out
}
/** A 64×96 picture: a vertical gradient in a hue picked from `seed`, with the card data in it. */
const picture = (seed: number, card: unknown) => {
  const [w, h] = [64, 96]
  const hue = (seed * 47) % 360
  const rgb = (l: number) => {
    const c = (1 - Math.abs(2 * l - 1)) * 0.6
    const x = c * (1 - Math.abs(((hue / 60) % 2) - 1))
    const [r, g, b] =
      hue < 60
        ? [c, x, 0]
        : hue < 120
          ? [x, c, 0]
          : hue < 180
            ? [0, c, x]
            : hue < 240
              ? [0, x, c]
              : hue < 300
                ? [x, 0, c]
                : [c, 0, x]
    const m = l - c / 2
    return [r + m, g + m, b + m].map((v) => Math.round(v * 255))
  }
  const rows = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    const [r, g, b] = rgb(0.25 + (0.5 * y) / h)
    for (let x = 0; x < w; x++) rows.set([r!, g!, b!], y * (w * 3 + 1) + 1 + x * 3)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(rows)),
    cardChunk("chara", card),
    pngChunk("IEND", new Uint8Array())
  ])
}
const FIRST = ["Aurelia", "Bram", "Cassia", "Dorian", "Elowen", "Fenwick", "Galen", "Hesper", "Isolde", "Jareth"]
const LAST = ["Ashdown", "Blackwood", "Corrigan", "Dunmore", "Everly", "Fairweather", "Greaves", "Hollis"]
const LONG = "Lady Seraphina Evangeline Montgomery-Ashworth of the Northern Reaches and the Glass Coast"
/** The extra cards: names, versions and whether they have a picture. */
export const EXTRA = Array.from({ length: 420 }, (_, i) => ({
  name:
    i === 7
      ? LONG
      : i === 8
        ? "Supercalifragilisticexpialidocious_Unbroken_Name_Without_Any_Spaces_At_All"
        : `${FIRST[i % FIRST.length]} ${LAST[Math.floor(i / FIRST.length) % LAST.length]}${i >= 80 ? ` ${Math.floor(i / 80) + 1}` : ""}`,
  version:
    i % 3 === 0 ? "" : i % 3 === 1 ? `v${(i % 7) + 1}.${i % 4}` : `Alternate universe, rewritten for slow burn ${i}`,
  picture: i % 5 !== 4
}))
export const LONG_NAME = LONG

export const seedLibrary = async (page: Page) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const folder = writeRealisticStFolder(join(server().dataDir, "synthetic-st"))
  for (const [i, spec] of EXTRA.entries()) {
    const card = {
      name: spec.name,
      spec: "chara_card_v2",
      spec_version: "2.0",
      data: {
        name: spec.name,
        description: `${spec.name} is made up for the library page.`,
        personality: "",
        scenario: "",
        first_mes: "Hello.",
        mes_example: "",
        creator_notes: "",
        system_prompt: "",
        post_history_instructions: "",
        tags: [],
        creator: "tests",
        character_version: spec.version,
        alternate_greetings: [],
        extensions: {}
      }
    }
    // ST gives every character a picture; the ones without are made here (New card).
    if (spec.picture) writeFileSync(join(folder, "characters", `extra-${i}.png`), picture(i, card))
  }
  await page.goto(`${server().url}/import/st`)
  await page.getByLabel("Folder path").fill(folder)
  await page.getByRole("button", { name: "Look in this folder" }).click()
  await page.getByRole("button", { name: "Import", exact: true }).click()
  await expect(page.getByRole("list", { name: "Imported" })).toBeVisible({ timeout: 280_000 })
  // Two generations of forks, and a fork of a long name.
  await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      for (const spec of EXTRA.filter((s) => !s.picture))
        yield* api.CreateCard({ label: spec.name, name: spec.name, version: spec.version })
      const cards = yield* api.ListLibrary({ kind: "card" })
      const aria = cards.find((c) => c.label === "Aria Vance")!
      const fork = yield* api.ForkCard({
        refId: aria.id,
        name: "Aria Vance",
        nickname: "Aria",
        characterVersion: "Stormbound rewrite",
        moveDrafts: false
      })
      yield* api.ForkCard({
        refId: fork.id,
        name: "Aria Vance",
        nickname: "Aria",
        characterVersion: "Stormbound, epilogue",
        moveDrafts: false
      })
      const long = cards.find((c) => c.label === LONG)!
      yield* api.ForkCard({
        refId: long.id,
        name: LONG,
        nickname: "Seraphina",
        characterVersion: "Court intrigue",
        moveDrafts: false
      })
    })
  )
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(400_000)
  const page = await browser.newPage()
  await seedLibrary(page)
  await page.close()
})

const shotDir = process.env.LIBRARY_SCREENSHOTS
const shot = async (page: Page, name: string, width: number) => {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
  if (!shotDir) return
  mkdirSync(shotDir, { recursive: true })
  await page.screenshot({ path: join(shotDir, `${name}.png`), animations: "disabled" })
}

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`the library at scale ${width} ${theme}`, async ({ page }) => {
      test.setTimeout(180_000)
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/library`)
      const list = page.getByRole("list", { name: "Cards" })
      const rows = list.locator(":scope > li")
      await expect(list).toContainText("Aria Vance", { timeout: 60_000 })
      await expect(page.getByRole("tab", { name: /^Cards · 4\d\d$/ })).toBeVisible()
      // No row wraps or clips: the name starts inside the viewport, the actions keep to one line.
      const layout = await rows.evaluateAll((items) =>
        items.slice(0, 80).map((li) => ({
          text: li.textContent,
          height: li.getBoundingClientRect().height,
          name: li.querySelector("[title]")!.getBoundingClientRect().left,
          right: li.getBoundingClientRect().right,
          actions: li.lastElementChild!.getBoundingClientRect().height
        }))
      )
      for (const row of layout) {
        expect(row.height, row.text!).toBeLessThan(90)
        expect(row.name, row.text!).toBeGreaterThan(0)
        expect(row.right, row.text!).toBeLessThanOrEqual(width)
        expect(row.actions, row.text!).toBeLessThanOrEqual(40)
      }
      await shot(page, `list-${width}-${theme}`, width)

      const search = page.getByRole("searchbox", { name: "Search cards" })
      await search.fill("Seraphina")
      await expect(rows).toHaveCount(2)
      await expect(page.getByText("2 of ", { exact: false })).toBeVisible()
      const long = rows.filter({ hasText: "Court intrigue" })
      await expect(long.getByRole("button", { name: /^Forks of / })).toBeVisible()
      await shot(page, `search-${width}-${theme}`, width)
      await long.getByRole("button", { name: /^More actions for / }).click()
      const menu = page.getByRole("menu")
      for (const item of ["Fork…", "Forks", "Compare with parent", "Mark as a fork of…", "Unlink from parent", "PNG"])
        await expect(menu.getByRole("menuitem", { name: item, exact: true })).toBeVisible()
      await expect(menu.getByRole("menuitemcheckbox", { name: "Persona" })).not.toBeChecked()
      // A fork has no import line to update from.
      await expect(menu.getByRole("menuitem", { name: /Update from file/ })).toHaveCount(0)
      await shot(page, `menu-${width}-${theme}`, width)
      await page.keyboard.press("Escape")
      await search.fill("")

      await page
        .getByRole("group", { name: "Show" })
        .getByRole("button", { name: /^Personas/ })
        .click()
      await expect(rows.first()).toContainText("Persona")
      expect(await rows.count()).toBeGreaterThan(0)
      for (const text of await rows.allTextContents()) expect(text).toContain("Persona")
      await shot(page, `personas-${width}-${theme}`, width)
      await page.getByRole("group", { name: "Show" }).getByRole("button", { name: "All", exact: true }).click()

      await page.getByRole("group", { name: "View" }).getByRole("button", { name: "Grid", exact: true }).click()
      await expect(rows.first()).toBeVisible()
      const tiles = await rows.evaluateAll((items) =>
        items.slice(0, 40).map((li) => ({ text: li.textContent, ...li.getBoundingClientRect().toJSON() }))
      )
      for (const tile of tiles) {
        expect(tile.left, tile.text!).toBeGreaterThanOrEqual(0)
        expect(tile.right, tile.text!).toBeLessThanOrEqual(width)
      }
      await shot(page, `grid-${width}-${theme}`, width)
      // The view is remembered.
      await page.reload()
      await expect(page.getByRole("group", { name: "View" }).getByRole("button", { name: "Grid" })).toHaveAttribute(
        "aria-pressed",
        "true",
        { timeout: 60_000 }
      )

      await page.getByRole("tab", { name: /^Presets/ }).click()
      await expect(page.getByRole("list", { name: "Presets" }).locator(":scope > li").first()).toBeVisible()
      await shot(page, `presets-${width}-${theme}`, width)
    })

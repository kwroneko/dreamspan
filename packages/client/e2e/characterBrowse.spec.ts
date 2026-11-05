// The characters' filter, sort and favourites (owner, 2026-11-01), one set of parts in every
// place that lists characters: the home grid, the left panel's grid. Each
// filter shows its count; the sort turns round and a date sort's date ends each tile's last
// line; a star marks a favourite without opening the card; ST's `fav` comes in with an import
// until the user sets the star here. Every card is synthetic.
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { Effect } from "effect"
import { card } from "../../server/test/support/stFolder.ts"
import { asUser, loginCookie } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
test.setTimeout(120_000)

/** Files through the ST import, as a SillyTavern folder's are: `fav` is ST's favourite flag. */
const stImport = async (files: ReadonlyArray<readonly [string, Uint8Array]>) => {
  const cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
  const run = await admin((api) => api.StartStImport({ unsupported: [] }))
  for (const [path, body] of files) {
    const response = await fetch(
      `${server().url}/st-import/file?${new URLSearchParams({ import: run.importId, path })}`,
      { method: "POST", headers: { cookie, "content-type": "application/octet-stream" }, body: new Uint8Array(body) }
    )
    expect(response.status).toBe(200)
  }
}
const favourites = async () =>
  (await admin((api) => api.GetShellLibrary())).cards.filter((c) => c.favourite).map((c) => c.card.label)

test.beforeAll(async () => {
  // Bram and Dora come from ST, Dora a favourite there; Ava and Cleo are written here after.
  await stImport([
    ["characters/Bram.png", card("Bram", "Bram nods.", { fav: false }, {}, { create_date: "2021-01-01T00:00:00Z" })],
    ["characters/Dora.png", card("Dora", "Dora smiles.", { fav: true }, {}, { create_date: "2022-01-01T00:00:00Z" })]
  ])
  await admin((api) =>
    Effect.gen(function* () {
      const ava = yield* api.CreateCard({ label: "Ava", name: "Ava" })
      const cleo = yield* api.CreateCard({ label: "Cleo", name: "Cleo" })
      const solo = yield* api.CreateChat({ title: "Ava alone" })
      yield* api.ChangeCast({ chatId: solo.id, slotId: null, change: { _tag: "Join", entityId: ava.entityId } })
      const pair = yield* api.CreateChat({ title: "The pair" })
      for (const entityId of [ava.entityId, cleo.entityId])
        yield* api.ChangeCast({ chatId: pair.id, slotId: null, change: { _tag: "Join", entityId } })
      // A line in each: a join alone doesn't put a character in a chat (castpresence).
      for (const chat of [solo, pair])
        yield* api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "Hello.", reply: false })
    })
  )
})

const unstarBram = () =>
  admin((api) =>
    Effect.gen(function* () {
      const bram = (yield* api.GetShellLibrary()).cards.find((c) => c.card.label === "Bram")!
      yield* api.SetCardFavourite({ entityId: bram.card.entityId, favourite: false })
    })
  )

const tiles = (scope: ReturnType<Page["getByRole"]>) =>
  scope.getByLabel("Characters", { exact: true }).getByRole("button", { name: /^Open / })
const labels = (buttons: ReturnType<typeof tiles>) =>
  buttons.evaluateAll((nodes) =>
    nodes.map((n) =>
      n
        .getAttribute("aria-label")!
        .replace(/^Open /, "")
        .replace(/ · .*$/, "")
    )
  )
const shots = process.env.SCREENSHOT_DIR
const shoot = async (page: Page, name: string) => {
  if (!shots) return
  mkdirSync(shots, { recursive: true })
  await page.screenshot({ path: join(shots, `${name}.png`) })
}

for (const width of [1440, 390]) {
  test(`${width}: the home grid's filter counts, favourites, sort, order and dates`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    // As the import left it, whatever an earlier width did.
    if (width === 390) await unstarBram()
    await page.goto(server().url)
    const main = page.getByRole("main")
    const show = main.getByRole("group", { name: "Show", exact: true })
    const counts = [
      /^All\s*4$/,
      /^With chats\s*2$/,
      /^Never used\s*2$/,
      /^Favourites\s*1$/,
      /^Personas\s*0$/,
      /^Groups\s*1$/
    ]
    await expect(show.getByRole("button")).toHaveText(counts)
    // The counts are what each filter holds, whatever the search.
    await main.getByRole("searchbox", { name: "Search characters and groups" }).fill("zzz")
    await expect(show.getByRole("button")).toHaveText(counts)
    await main.getByRole("searchbox", { name: "Search characters and groups" }).fill("")

    // The star marks a favourite where it stands; the tile isn't opened.
    await main.getByRole("button", { name: "Add Bram to favourites", exact: true }).click()
    await expect(main.getByRole("button", { name: "Remove Bram from favourites", exact: true })).toBeVisible()
    await expect(page).toHaveURL(`${server().url}/`)
    await expect(show.getByRole("button", { name: "Favourites", exact: true })).toHaveText(/^Favourites\s*2$/)
    await show.getByRole("button", { name: "Favourites", exact: true }).click()
    await expect.poll(async () => (await labels(tiles(main))).sort()).toEqual(["Bram", "Dora"])
    await show.getByRole("button", { name: "All", exact: true }).click()

    // Added inherits ST arrival for the imported cards; native cards use their arrival here.
    const sort = main.getByRole("group", { name: "Sort by", exact: true })
    await sort.getByRole("button", { name: "Added", exact: true }).click()
    await expect.poll(() => labels(tiles(main))).toEqual(["Cleo", "Ava", "Dora", "Bram"])
    const dates = main.getByLabel("Characters", { exact: true }).locator("[data-sort-date]")
    await expect(dates).toHaveCount(4)
    await expect(dates.first()).toHaveText(/^(now|\d+m ago)$/)
    await expect(dates.first()).toHaveAttribute("aria-label", /^Added: /)
    const inheritedDate = await page.evaluate(() =>
      new Date("2022-01-01T00:00:00Z").toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
    )
    await expect(
      main.getByRole("button", { name: /^Open Dora(?: ·.*)?$/ }).locator("[data-sort-date]")
    ).toHaveAttribute("aria-label", `Added: ${inheritedDate}`)
    // The tile keeps its height: the date shares the line with the chat count.
    const tile = tiles(main).first()
    const line = tile.locator("[data-sort-date]").locator("..")
    await expect(line).toContainText(/chat|Never used/)
    if (width === 1440) {
      // Each choice says what it orders by (the one just clicked keeps its tooltip shut).
      // The tooltip, and the option's description (a hidden copy of the same text).
      const created = sort.getByRole("button", { name: "Created", exact: true })
      await created.hover()
      await expect(page.getByText(/^By when the card was created$/).filter({ visible: true })).toBeVisible()
      await expect(created).toHaveAccessibleDescription(/^By when the card was created$/)
    }
    await shoot(page, `characters-added-${width}`)
    await main.getByRole("button", { name: "Order: Newest first", exact: true }).hover()
    await expect(page.getByText("Click to sort oldest first")).toBeVisible()
    await main.getByRole("button", { name: "Order: Newest first", exact: true }).click()
    await expect.poll(() => labels(tiles(main))).toEqual(["Bram", "Dora", "Ava", "Cleo"])
    await expect(main.getByRole("button", { name: "Order: Oldest first", exact: true })).toBeVisible()
    // Name: A to Z, and no date.
    await sort.getByRole("button", { name: "Name", exact: true }).click()
    await expect(main.getByRole("button", { name: "Order: A to Z", exact: true })).toBeVisible()
    await expect.poll(() => labels(tiles(main))).toEqual(["Ava", "Bram", "Cleo", "Dora"])
    await expect(dates).toHaveCount(0)
    // Remembered, as the page's other choices are.
    await page.reload()
    await expect(sort.getByRole("button", { name: "Name", exact: true })).toHaveAttribute("aria-pressed", "true")
    await sort.getByRole("button", { name: "Recent", exact: true }).click()

    // The left panel's grid: the same filter and sort, compact.
    if (width === 390) await page.getByRole("button", { name: "Chats and menu" }).click()
    const panel = width === 390 ? page.locator(".fixed.inset-0") : page.getByRole("complementary").first()
    // A chat's pin is a pin, not the favourite's star.
    const pin = panel.getByRole("button", { name: /^Pin Ava alone/ })
    await expect(pin).toHaveAttribute("aria-pressed", "false")
    await expect(pin).toHaveText("")
    await expect(pin.locator("svg")).toHaveCount(1)
    await panel.getByRole("group", { name: "Left panel", exact: true }).getByText("Characters").click()
    await panel.getByRole("combobox", { name: "Show" }).click()
    await expect(page.getByRole("option")).toHaveText([
      "All · 4",
      "With chats · 2",
      "Never used · 2",
      "Favourites · 2",
      "Personas · 0",
      "Groups · 1"
    ])
    await page.getByRole("option", { name: "Favourites · 2" }).click()
    await expect.poll(async () => (await labels(tiles(panel))).sort()).toEqual(["Bram", "Dora"])
    await panel.getByRole("button", { name: "Sort by: Recent" }).click()
    await page.getByRole("menuitemcheckbox", { name: /^Added/ }).click()
    await expect(panel.locator("[data-sort-date]")).toHaveCount(2)
    await shoot(page, `characters-sidebar-${width}`)
    await panel.getByRole("combobox", { name: "Show" }).click()
    await page.getByRole("option", { name: "Groups · 1" }).click()
    await expect(
      panel.getByLabel("Groups", { exact: true }).getByRole("link", { name: "Open chat The pair" })
    ).toBeVisible()
    await panel.getByRole("combobox", { name: "Show" }).click()
    await page.getByRole("option", { name: "All · 4" }).click()

    await expect(panel.getByRole("button", { name: "Start a chat", exact: true })).toHaveCount(0)

    await unstarBram()
  })
}

test("an ST import brings its favourites, and a star set here outlasts a re-import", async () => {
  expect(await favourites()).toEqual(["Dora"])
  const cards = (await admin((api) => api.GetShellLibrary())).cards
  // Both stars set here (Bram's by the tests above too), both off.
  for (const name of ["Dora", "Bram"]) {
    const entityId = cards.find((c) => c.card.label === name)!.card.entityId
    await admin((api) => api.SetCardFavourite({ entityId, favourite: false }))
  }
  // ST now marks Bram, and still Dora (a changed file, so both are imported again).
  await stImport([
    ["characters/Bram.png", card("Bram", "Bram nods again.", { fav: true })],
    ["characters/Dora.png", card("Dora", "Dora smiles again.", { fav: true })]
  ])
  // Set here, so ST's flag no longer changes them.
  expect(await favourites()).toEqual([])
  // A card whose star was never set here follows ST.
  await stImport([["characters/Esme.png", card("Esme", "Esme waves.", { fav: true })]])
  expect(await favourites()).toEqual(["Esme"])
  await stImport([["characters/Esme.png", card("Esme", "Esme waves twice.", { fav: false })]])
  expect(await favourites()).toEqual([])
})

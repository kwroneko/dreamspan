// The home page and sidebar after an ST import (UI audit, 2026-10-31): Recent orders the
// characters by their chats' imported dates, in both grids; group tiles count their members
// and lay out three faces with no empty slot; the sidebar's Characters grid opens unused characters; the header's image toggle is an icon; the open chat is marked.
import { expect, test, type Page } from "@playwright/test"
import { Effect } from "effect"
import { card, header, jsonl, message } from "../../server/test/support/stFolder.ts"
import { asUser, loginCookie } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
test.setTimeout(120_000)

test.beforeAll(async () => {
  const cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
  const run = await admin((api) => api.StartStImport({ unsupported: [] }))
  // Imported in this order, so each card is newer than the one before and than every
  // imported message (2025): the card's own time would put Cara first and Bob last.
  const chat = (name: string, minute: number) =>
    jsonl([
      header({}),
      message({ name, user: false, mes: `${name} waves.`, minute }),
      message({ name: "Sam", user: true, mes: "Hello.", minute: minute + 1 })
    ])
  for (const [path, body] of [
    ["characters/Bob.png", card("Bob", "Bob waves.")],
    ["characters/Alice.png", card("Alice", "Alice waves.")],
    ["characters/Cara.png", card("Cara", "Cara waves.")],
    ["chats/Bob/Bob - late.jsonl", chat("Bob", 50)],
    ["chats/Alice/Alice - early.jsonl", chat("Alice", 5)]
  ] as const) {
    const response = await fetch(
      `${server().url}/st-import/file?${new URLSearchParams({ import: run.importId, path })}`,
      {
        method: "POST",
        headers: { cookie, "content-type": "application/octet-stream" },
        body: new Uint8Array(typeof body === "string" ? Buffer.from(body) : body)
      }
    )
    expect(response.status).toBe(200)
  }
  await admin((api) =>
    Effect.gen(function* () {
      const ids = []
      for (const name of ["Dax", "Eve", "Fin"]) ids.push((yield* api.CreateCard({ label: name, name })).entityId)
      const trio = yield* api.CreateChat({ title: "The Trio" })
      for (const entityId of ids)
        yield* api.ChangeCast({ chatId: trio.id, slotId: null, change: { _tag: "Join", entityId } })
      // Today, so the trio's members come first.
      yield* api.SendMessage({ chatId: trio.id, parentSlotId: null, branch: false, content: "Three of us." })
      // Even newer activity must not put an archived character in the ordinary Recent grid.
      const hidden = yield* api.CreateCard({ label: "Archived newest", name: "Archived newest" })
      const chat = yield* api.CreateChat({ title: "Archived newest alone" })
      yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: hidden.entityId } })
      yield* api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "Hello.", reply: false })
      yield* api.SetRefArchived({ refId: hidden.id, archived: true })
    })
  )
})

const sidebar = (page: Page) => page.getByRole("complementary").first()
const tiles = (page: Page) =>
  page
    .getByRole("main")
    .getByLabel("Characters", { exact: true })
    .getByRole("link", { name: /^Open / })
const labels = (buttons: ReturnType<typeof tiles>) =>
  buttons.evaluateAll((nodes) =>
    nodes.map((n) =>
      n
        .getAttribute("aria-label")!
        .replace(/^Open /, "")
        .replace(/ · .*$/, "")
    )
  )

for (const width of [1440, 390]) {
  test(`${width}: Recent orders characters by their imported chats, the never-used last`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(server().url)
    await expect.poll(() => labels(tiles(page))).toContain("Cara")
    const order = await labels(tiles(page))
    // The trio's chat is today's, Bob's imported one later than Alice's; Cara has none.
    expect(order.slice(0, 3).sort()).toEqual(["Dax", "Eve", "Fin"])
    expect(order.slice(3)).toEqual(["Bob", "Alice", "Cara"])
    // Every filter, including the archive, has its count (characterBrowse.spec.ts has more).
    await expect(page.getByRole("group", { name: "Show", exact: true }).getByRole("button")).toHaveText([
      /^All\s*6$/,
      /^With chats\s*5$/,
      /^Never used\s*1$/,
      /^Favourites\s*0$/,
      /^Personas\s*0$/,
      /^Groups\s*1$/,
      /^Archived\s*1$/
    ])
    if (width === 1440) {
      // The left panel's grid uses the same key.
      await sidebar(page).getByRole("group", { name: "Left panel", exact: true }).getByText("Characters").click()
      const side = sidebar(page).getByRole("link", { name: /^Open (?!chat )/ })
      await expect(side.first()).toBeVisible()
      expect((await labels(side)).slice(3)).toEqual(["Bob", "Alice", "Cara"])
    }
  })
}

test("a group tile counts its members and shows three faces with no empty slot", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(server().url)
  await page.getByRole("group", { name: "Show", exact: true }).getByRole("button", { name: "Groups" }).click()
  const tile = page.getByRole("main").getByLabel("Groups", { exact: true }).getByRole("link", {
    name: "Open chat The Trio"
  })
  await expect(tile).toContainText("3 members")
  await expect(tile).not.toContainText("Dax, Eve")
  const faces = await tile.locator("[data-portrait]").evaluateAll((nodes) =>
    nodes.map((n) => {
      const r = n.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y, w: r.width }
    })
  )
  const box = (await tile.locator("[data-portrait]").first().locator("xpath=../..").boundingBox())!
  expect(faces).toHaveLength(3)
  // Two side by side, the third below them, centred, the same size.
  expect(Math.abs(faces[0]!.y - faces[1]!.y)).toBeLessThan(1)
  expect(faces[2]!.y).toBeGreaterThan(faces[0]!.y)
  expect(Math.abs(faces[2]!.x - (box.x + box.width / 2))).toBeLessThan(2)
  expect(Math.abs(faces[2]!.w - faces[0]!.w)).toBeLessThan(1)
})

for (const width of [1440, 390]) {
  test(`${width}: Characters replaces the header picker and opens an unused character`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(server().url)
    if (width === 390) await page.getByRole("button", { name: "Chats and menu" }).click()
    const panel = width === 390 ? page.locator(".fixed.inset-0") : sidebar(page)
    await expect(panel.getByRole("button", { name: "Start a chat", exact: true })).toHaveCount(0)
    await expect(panel.getByRole("button", { name: "Blur all images" })).toHaveText("")
    await expect(panel.getByRole("button", { name: /unsaved texts?$/ })).toHaveCount(0)
    await panel.getByRole("group", { name: "Left panel", exact: true }).getByText("Characters").click()
    await panel.getByLabel("Find a character").fill("Cara")
    await panel.getByRole("link", { name: "Open Cara", exact: true }).click()
    await expect(page).toHaveURL(/\/cards\/[^/]+\/chat\?/)
    await expect(page.getByRole("main")).toContainText("Cara waves.")
    if (width === 390) await expect(page.getByRole("button", { name: "Close the menu" })).toHaveCount(0)
  })
}

test("the chat open in the middle is marked in the left panel's list", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(server().url)
  const row = sidebar(page)
    .getByRole("link", { name: /^Open chat Bob/ })
    .first()
  await row.click()
  await expect(page).toHaveURL(/\/chats\//)
  await expect(row).toHaveAttribute("aria-current", "page")
  await expect(sidebar(page).locator('[data-shell-list] [aria-current="page"]')).toHaveCount(1)
  const branches = sidebar(page).getByRole("region", { name: "Branches of the open chat" })
  const disclosure = branches.getByRole("button", { name: /^Branches of / })
  await expect(disclosure).toBeVisible()
  if ((await disclosure.getAttribute("aria-expanded")) === "false") await disclosure.click()
  await expect(branches.locator('[aria-current="page"]')).toHaveCount(1)
})

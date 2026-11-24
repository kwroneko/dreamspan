// A card's page beside (owner, 2026-11-24: reading card after card to find a good one): a card
// tile's menu has Edit beside, which opens the editor as a preview tab in the pane on the right.
// The next card replaces that
// preview, so panes and tabs don't pile up; a kept tab makes the next one a new preview beside it,
// in the same pane. The grid keeps its scroll. Synthetic cards and the fake archive only.
import { createServer } from "node:net"
import { expect, type Locator, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, startServer, type TestServer, withAdmin } from "./support/server.ts"

test.setTimeout(300_000)

const SHOTS = process.env["CARD_BESIDE_SHOTS"]

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer()
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      probe.close(() => resolve(typeof address === "object" && address ? address.port : 0))
    })
  })

const frames = (page: Page) => page.locator("section[data-frame]")

/** The scroll offset of the nearest scrolling box around `tile`. */
const scrollOf = (tile: Locator) =>
  tile.evaluate((node) => {
    for (let el: Element | null = node; el; el = el.parentElement)
      if (el.scrollHeight > el.clientHeight + 1 && getComputedStyle(el).overflowY !== "visible") return el.scrollTop
    return document.scrollingElement?.scrollTop ?? 0
  })

/** Right-click a tile's open area and choose `item`. */
const choose = async (page: Page, tile: Locator, item: RegExp) => {
  await tile.getByRole("link").first().click({ button: "right" })
  await page.getByRole("menuitem", { name: item }).click()
}

/**
 * Three cards beside in a row: one side pane, one preview tab showing the third. Then a kept tab
 * makes the next a new preview beside it in that pane.
 */
const walk = async (page: Page, tiles: Locator, names: ReadonlyArray<string>, item: RegExp, shot: string) => {
  const grid = frames(page).first()
  for (let i = 0; i < 3; i++) {
    // The tile in view first (the split narrows the grid, which reflows), then its scroll.
    await tiles.nth(i).scrollIntoViewIfNeeded()
    const before = await scrollOf(tiles.nth(i))
    await choose(page, tiles.nth(i), item)
    await expect(frames(page)).toHaveCount(2)
    const side = frames(page).nth(1)
    await expect(side.locator("[data-tab]")).toHaveCount(1)
    await expect(side.locator("[data-tab][data-preview]")).toHaveCount(1)
    await expect(side.locator("[data-tab]").first()).toContainText(names[i]!)
    // The grid stays, at its scroll.
    await expect(tiles.nth(i)).toBeVisible()
    expect(await scrollOf(tiles.nth(i))).toBe(before)
  }
  await expect(grid.locator("[data-tab]").first()).not.toContainText(names[2]!)
  if (SHOTS) {
    await tiles.nth(3).getByRole("link").first().click({ button: "right" })
    await expect(page.getByRole("menuitem", { name: item })).toBeVisible()
    await page.screenshot({ path: `${SHOTS}/${shot}-menu.png` })
    await page.keyboard.press("Escape")
  }
  // Keep the preview: the next opens as a new preview tab beside it, in the same pane.
  const side = frames(page).nth(1)
  await side.locator("[data-tab]").first().getByRole("tab").dblclick()
  await expect(side.locator("[data-tab][data-preview]")).toHaveCount(0)
  await choose(page, tiles.nth(3), item)
  await expect(frames(page)).toHaveCount(2)
  await expect(side.locator("[data-tab]")).toHaveCount(2)
  await expect(side.locator("[data-tab]").nth(0)).not.toHaveAttribute("data-preview")
  await expect(side.locator("[data-tab]").nth(1)).toHaveAttribute("data-preview", "")
  await expect(side.locator("[data-tab]").nth(1)).toContainText(names[3]!)
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${shot}-split.png` })
}

const setup = async (page: Page, server: TestServer) => {
  await apiLogin(page.request, server, ADMIN.handle, ADMIN.password)
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" })
  await page.addInitScript(() => {
    localStorage.setItem("dreamspan.theme", "dark")
    // What a new browser tab would open.
    const opened: Array<string> = []
    ;(window as unknown as { __opened: Array<string> }).__opened = opened
    window.open = (url?: string | URL) => {
      opened.push(String(url))
      return null
    }
  })
}

const opened = (page: Page) => page.evaluate(() => (window as unknown as { __opened: Array<string> }).__opened)

for (const width of [1340, 390]) {
  test(`a held cardex tile's menu opens the same saved chat as its link at ${width}`, async ({ page }) => {
    const port = await freePort()
    const server = await startServer({ ...withAdmin, FAKE_CARD_SOURCE: String(port) })
    try {
      await setup(page, server)
      await page.setViewportSize({ width, height: 900 })
      const archive = `${server.url}/?show=src.cardex`
      const tile = page.getByRole("main").locator("[data-remote-card]").first()
      const link = tile.getByRole("link", { name: /^Open/ })
      await page.goto(archive)
      await link.click()
      await expect(page).toHaveURL(/\/sources\/cardex\/cards\/[^/]+\/chat/)
      const message = "This message belongs to the saved chat."
      await page.getByTestId("composer").fill(message)
      await page.getByRole("button", { name: "Send", exact: true }).click()
      await expect(page).toHaveURL(/\/chats\//)
      await expect(page.getByTestId("messages").getByText(message, { exact: true })).toBeVisible()

      await page.goto(archive)
      await expect(tile).toHaveAttribute("data-held", "true")
      await link.click()
      await expect(page).toHaveURL(/\/chats\/[^?]+\?.*character=/)
      const saved = new URL(page.url())
      for (const key of ["character", "panel", "fork", "slot"]) expect(saved.searchParams.get(key)).toBeTruthy()
      const expectSavedPlace = (url: URL) => {
        expect(url.pathname).toBe(saved.pathname)
        for (const key of ["character", "panel", "fork", "slot"])
          expect(url.searchParams.get(key), key).toBe(saved.searchParams.get(key))
      }

      await page.goto(archive)
      await choose(page, tile, /^Open in a new browser tab/)
      const newTab = new URL((await opened(page)).at(-1)!, server.url)
      if (width > 390) {
        await choose(page, tile, /^Open beside/)
        const side = frames(page).nth(1)
        await expect(side.getByTestId("messages").getByText(message, { exact: true })).toBeVisible()
        await side.locator("[data-tab]").getByRole("tab").click()
        await expect(page).toHaveURL(/\/chats\//)
        expectSavedPlace(new URL(page.url()))
      }
      expectSavedPlace(newTab)
    } finally {
      await server.stop()
    }
  })
}

test("library cards: Edit beside replaces the side pane's preview", async ({ page }) => {
  const server = await startServer(withAdmin)
  try {
    const names = ["Ava Beside", "Bela Beside", "Cora Beside", "Dina Beside"]
    await asUser(server, ADMIN.handle, ADMIN.password, (api) =>
      Effect.gen(function* () {
        for (const name of names) yield* api.CreateCard({ label: name, name })
      })
    )
    await setup(page, server)
    await page.goto(server.url)
    const grid = page.getByRole("main").getByLabel("Characters", { exact: true })
    const tiles = grid.locator(":scope > div")
    await expect(tiles).toHaveCount(4)
    const shown = await grid
      .getByRole("link")
      .evaluateAll((links) => links.map((l) => (l.getAttribute("aria-label") ?? "").replace(/^Open /, "")))
    // The menu: the open items first, then the card's page beside.
    await tiles.nth(0).getByRole("link").first().click({ button: "right" })
    const items = await page.getByRole("menuitem").allTextContents()
    expect(items[0]).toMatch(/^Open(?! beside| in)/)
    expect(items[1]).toMatch(/^Open beside/)
    expect(items[2]).toMatch(/^Open in a new browser tab/)
    expect(items[3]).toMatch(/^Edit beside/)
    await page.keyboard.press("Escape")
    await walk(page, tiles, shown, /^Edit beside/, "library")
    // The side pane shows the card's editor.
    await expect(page).toHaveURL(/./)
  } finally {
    await server.stop()
  }
})

test("Library rows: the card menu's Edit beside replaces the side pane's preview", async ({ page }) => {
  const server = await startServer(withAdmin)
  try {
    const names = ["Ava Shelf", "Bela Shelf", "Cora Shelf", "Dina Shelf"]
    await asUser(server, ADMIN.handle, ADMIN.password, (api) =>
      Effect.gen(function* () {
        for (const name of names) yield* api.CreateCard({ label: name, name })
      })
    )
    await setup(page, server)
    await page.goto(`${server.url}/library`)
    const rows = page
      .getByRole("main")
      .locator("li")
      .filter({ has: page.locator('a[href^="/cards/"]') })
    await expect(rows).toHaveCount(4)
    const shown = await rows.evaluateAll((items) =>
      items.map((li) => (li.querySelector('a[href^="/cards/"][title]')?.textContent ?? "").trim())
    )
    // The app's menu, not the browser's: the Characters tiles' items.
    await rows.nth(0).getByRole("link").first().click({ button: "right" })
    const items = await page.getByRole("menuitem").allTextContents()
    expect(items[0]).toMatch(/^Open(?! beside| in)/)
    expect(items[1]).toMatch(/^Open beside/)
    expect(items[2]).toMatch(/^Open in a new browser tab/)
    expect(items[3]).toMatch(/^Edit beside/)
    await page.getByRole("menuitem", { name: /^Open in a new browser tab/ }).click()
    expect((await opened(page)).at(-1)).toMatch(/^\/cards\/[^/]+$/)
    await walk(page, rows, shown, /^Edit beside/, "library-rows")
  } finally {
    await server.stop()
  }
})

test("cardex cards: Edit beside opens the editor as the side pane's preview, as Open in the editor does", async ({
  page
}) => {
  const port = await freePort()
  const server = await startServer({ ...withAdmin, FAKE_CARD_SOURCE: String(port) })
  try {
    await setup(page, server)
    await page.goto(server.url)
    const main = page.getByRole("main")
    await main.getByRole("button", { name: "cardex", exact: true }).click()
    const tiles = main.locator("[data-remote-card]")
    await expect(tiles.nth(3)).toBeVisible()
    const names = await tiles.evaluateAll((nodes) =>
      nodes.map((n) => (n.querySelector("a")?.getAttribute("aria-label") ?? "").replace(/^Open /, ""))
    )
    const remoteId = await tiles.first().getAttribute("data-remote-card")
    // The chat destinations are followed by one action per editor destination.
    await tiles.nth(0).getByRole("link").first().click({ button: "right" })
    const texts = await page.getByRole("menuitem").allTextContents()
    const editor = texts.findIndex((t) => /^Open in the editor/.test(t))
    expect(editor).toBe(3)
    expect(texts[editor + 1]).toMatch(/^Edit beside/)
    await expect(page.getByRole("menuitem", { name: /^(View(?: beside)?|Inspect)$/ })).toHaveCount(0)
    await page.getByRole("menuitem", { name: /^Open in a new browser tab/ }).click()
    expect((await opened(page)).at(-1)).toBe(`/sources/cardex/cards/${encodeURIComponent(remoteId!)}/chat`)
    await walk(page, tiles, names, /^Edit beside/, "cardex-editor")
    // The side pane shows the card's full editor, at the editor's URL.
    const side = frames(page).nth(1)
    await side.locator("[data-tab]").nth(1).getByRole("tab").click()
    await expect(page).toHaveURL(/\/library\//)
  } finally {
    await server.stop()
  }
})

test("cardex cards you have: Edit beside opens the saved card editor", async ({ page }) => {
  const port = await freePort()
  const server = await startServer({ ...withAdmin, FAKE_CARD_SOURCE: String(port) })
  try {
    await setup(page, server)
    await page.goto(server.url)
    const main = page.getByRole("main")
    await main.getByRole("button", { name: "cardex", exact: true }).click()
    const tiles = main.locator("[data-remote-card]")
    await expect(tiles.nth(1)).toBeVisible()
    const names = await tiles.evaluateAll((nodes) =>
      nodes.map((n) => (n.querySelector("a")?.getAttribute("aria-label") ?? "").replace(/^Open /, ""))
    )
    // A card you have opens its own editor.
    await choose(page, tiles.nth(0), /^Add to my cards/)
    await expect(tiles.nth(0)).toHaveAttribute("data-held", "true")
    await tiles.nth(0).getByRole("link").first().click({ button: "right" })
    const texts = await page.getByRole("menuitem").allTextContents()
    expect(texts[0]).toMatch(/^Open your card/)
    expect(texts[3]).toMatch(/^Open in the editor/)
    expect(texts[4]).toMatch(/^Edit beside/)
    await expect(page.getByRole("menuitem", { name: /^(View(?: beside)?|Inspect)$/ })).toHaveCount(0)
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/held-menu.png` })
    await page.getByRole("menuitem", { name: /^Edit beside/ }).click()
    await expect(frames(page)).toHaveCount(2)
    const side = frames(page).nth(1)
    await expect(side.locator("[data-tab][data-preview]")).toHaveCount(1)
    await expect(side.locator("[data-tab]").first()).toContainText(names[0]!)
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/held-split.png` })
    await side.locator("[data-tab]").first().getByRole("tab").click()
    // Your card's own editor (its id), not the source card's read-only one.
    await expect(page).toHaveURL(/\/library\/[0-9a-f-]{36}\?/)
  } finally {
    await server.stop()
  }
})

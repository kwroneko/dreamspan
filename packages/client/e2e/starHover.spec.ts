// Synthetic portraits and cards only. Exercise the star itself, including its open tooltip:
// tile-only hover does not apply IconButton's hover/popup background rules.
import { expect, test, type Locator, type Page } from "@playwright/test"
import { Effect } from "effect"
import type { ChatId } from "@rp/shared/chat.ts"
import { openPanel } from "./support/panel.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { shapeCard } from "./support/shapes.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
const names = Array.from({ length: 8 }, (_, i) => `Star ${i}`)
let chatId: ChatId

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage()
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  for (const name of names.slice(0, 4)) {
    const response = await page.request.post(`${server().url}/library/import?name=${encodeURIComponent(name)}.png`, {
      data: shapeCard({ name, width: 160, height: 240 }, 20),
      headers: { origin: server().url, "content-type": "application/octet-stream" }
    })
    expect(response.ok()).toBe(true)
  }
  await page.close()
  chatId = await admin((api) =>
    Effect.gen(function* () {
      for (const name of names.slice(4)) yield* api.CreateCard({ label: name, name })
      const parent = yield* api.CreateCard({ label: "Star parent", name: "Star parent" })
      const cards = yield* api.ListCards()
      const chat = yield* api.CreateChat({ title: "Star hover fixture" })
      for (const [i, name] of names.entries()) {
        const card = cards.find((c) => c.label === name)!
        yield* api.SetCardFavourite({ entityId: card.entityId, favourite: i % 2 === 1 })
        if (i % 4 >= 2)
          yield* api.SetCardParent({
            entityId: card.entityId,
            parentEntityId: parent.entityId
          })
        if (i < 4)
          yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: card.entityId } })
      }
      return chat.id
    })
  )
})

async function hitTest(star: Locator) {
  await expect(star).toHaveCSS("opacity", "1")
  expect(
    await star.evaluate((el) => {
      const r = el.getBoundingClientRect()
      return [
        [0.5, 0.5],
        [0.15, 0.15],
        [0.85, 0.85]
      ].every(([x, y]) => el.contains(document.elementFromPoint(r.left + r.width * x!, r.top + r.height * y!)))
    })
  ).toBe(true)
}

async function checkStars(page: Page, scope: Locator, surface: "home" | "sidebar" | "library" | "cast") {
  const portrait = surface !== "library"
  for (const [i, name] of names.entries()) {
    const namedStar = scope.getByRole("button", {
      name: new RegExp(`^(Add|Remove) ${name} (to|from) favourites$`),
      exact: true
    })
    const tile = namedStar.locator(
      "xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' tile-toggle-surface ')][1]"
    )
    const star = tile.locator(".tile-toggle")
    await tile.scrollIntoViewIfNeeded()
    await star.scrollIntoViewIfNeeded()
    await expect(tile.getByRole("button", { name: `Forks of ${name}`, exact: true })).toHaveCount(i % 4 >= 2 ? 1 : 0)
    if (surface === "cast") await expect(tile.getByText("In chat", { exact: true })).toHaveCount(i < 4 ? 1 : 0)
    await page.mouse.move(0, 0)
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur())
    await expect(star).toHaveCSS("opacity", i % 2 ? "1" : "0")
    // Hover beside the star at the same height. A tall library tile's centre can
    // scroll its footer (and the star) outside the viewport.
    const position = await star.evaluate((el) => {
      const r = el.getBoundingClientRect()
      const tile = el.closest(".tile-toggle-surface")!.getBoundingClientRect()
      return { x: r.left - tile.left - 4, y: r.top - tile.top + r.height / 2 }
    })
    await tile.hover({ position })
    await hitTest(star)
    const background = await star.evaluate((el) => getComputedStyle(el).backgroundColor)
    await star.hover()
    await hitTest(star)
    await expect(
      page.getByText(i % 2 ? "A favourite: click to remove" : "Add to favourites", { exact: true })
    ).toBeVisible()
    await hitTest(star)
    // Portrait controls must retain their contrast chip on hover and while explained.
    if (portrait) {
      if (i < 4)
        await test.info().attach(`${surface}-${name}`, {
          body: await tile.screenshot({ path: test.info().outputPath(`${surface}-${i}.png`) }),
          contentType: "image/png"
        })
      await expect
        .soft(star, `${name}: portrait chip survives hover and tooltip`)
        .toHaveCSS("background-color", background, { timeout: 1000 })
    }
    const url = page.url()
    await star.click()
    await expect(star).toHaveAttribute("aria-pressed", String(i % 2 === 0))
    await hitTest(star)
    await expect(page).toHaveURL(url)
    await star.click()
    await expect(star).toHaveAttribute("aria-pressed", String(i % 2 === 1))
    await page.mouse.move(0, 0)
    await star.focus()
    await hitTest(star)
  }
}

for (const theme of ["light", "dark"] as const)
  test(`${theme}: favourite stars survive hover, tooltip and clicks on every card surface`, async ({ page }, info) => {
    test.setTimeout(180_000)
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
    await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(server().url)
    await checkStars(page, page.getByRole("main"), "home")
    const sidebar = page.getByRole("complementary").first()
    await sidebar.getByRole("group", { name: "Left panel", exact: true }).getByText("Characters").click()
    await checkStars(page, sidebar, "sidebar")
    await page.goto(`${server().url}/library`)
    await page
      .getByRole("group", { name: "View", exact: true })
      .getByRole("button", { name: "Grid", exact: true })
      .click()
    await checkStars(page, page.getByRole("main"), "library")
    // Ordinary library rows never hide their stars.
    await page
      .getByRole("group", { name: "View", exact: true })
      .getByRole("button", { name: "List", exact: true })
      .click()
    for (const star of await page
      .getByRole("main")
      .getByRole("button", { name: / favourites$/ })
      .all()) {
      await star.hover()
      await hitTest(star)
    }
    await page.goto(`${server().url}/chats/${chatId}`)
    const cast = await openPanel(page, "Cast")
    await cast.getByRole("button", { name: "Add characters", exact: true }).click()
    await checkStars(page, cast.getByRole("region", { name: "Add characters", exact: true }), "cast")
    await info.attach("star-hover", { body: await page.screenshot(), contentType: "image/png" })
  })

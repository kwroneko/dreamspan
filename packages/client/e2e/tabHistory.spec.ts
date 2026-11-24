// Every tab its own back and forward (owner, 2026-11-24; spec/TAB-HISTORY.md): ← and → at the
// start of each frame's strip act on its shown tab. A search left for a result comes back with
// its words, filters and scroll; another pane's navigation leaves a pane's arrows alone; the next
// card replacing a preview tab is a step; the arrows follow the tab shown, are always there and
// explain themselves; the browser's Back is the browser's, as before; a reload keeps them.
// Synthetic cards and the fake archive only. SCREENSHOT_DIR saves screenshots; LAYOUT_AUDIT audits.
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, type Locator, type Page, test } from "@playwright/test"
import { expectLayout } from "./support/layoutAudit.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { gotoWithLayout } from "./support/workbench.ts"

const server = serverPerFile({ ...withAdmin, FAKE_CARD_SOURCE: "0" })
test.setTimeout(180_000)

const shots = process.env.SCREENSHOT_DIR
const shot = async (page: Page, name: string) => {
  if (!shots) return
  mkdirSync(shots, { recursive: true })
  await page.screenshot({ path: join(shots, `${name}.png`) })
}

const frames = (page: Page) => page.locator("section[data-frame]")
const back = (frame: Locator) =>
  frame.locator("[data-strip-history]").getByRole("button", { name: "Back", exact: true })
const forward = (frame: Locator) =>
  frame.locator("[data-strip-history]").getByRole("button", { name: "Forward", exact: true })

/** Hovers `button` and expects its explanation to say `text`. */
const explains = async (page: Page, button: Locator, text: string) => {
  await button.hover()
  await expect(hint(page, text)).toBeVisible()
  await page.mouse.move(0, 0)
  await expect(hint(page, text)).toHaveCount(0)
}
/** A hover's explanation, in its popup at the page's end. */
const hint = (page: Page, text: string) => page.locator("body > *").getByText(text, { exact: true })
const enabled = (button: Locator) => expect(button).not.toHaveAttribute("aria-disabled", "true")
const disabled = (button: Locator) => expect(button).toHaveAttribute("aria-disabled", "true")

const setup = async (page: Page, width = 1920, scheme: "dark" | "light" = "dark") => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.setViewportSize({ width, height: 1000 })
  await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" })
  await page.addInitScript((theme) => localStorage.setItem("dreamspan.theme", theme), scheme)
}

/** The page's scrolling box in a frame (CenterPage's, its scrollbar gutter kept), and its offset. */
const scrollerOf = (frame: Locator) => frame.locator("[data-frame-body] div[class*='scrollbar-gutter']").first()
const scrollTop = (frame: Locator) => scrollerOf(frame).evaluate((el) => el.scrollTop)

/** Home in the left frame (a preview tab, focused), Settings kept in the right one. */
const twoFrames = async (page: Page) => {
  await gotoWithLayout(page, server().url, "/", ["r", [0.5, 0.5], [0, "=~"], [0, "/settings"]])
  await expect(frames(page)).toHaveCount(2)
  return { left: frames(page).nth(0), right: frames(page).nth(1) }
}

/** The archive shown in a frame's Home: the Show tab is a step there. */
const showCardex = async (frame: Locator) => {
  await frame.getByRole("button", { name: "cardex", exact: true }).click()
  await expect(frame.locator("[data-remote-card]").nth(3)).toBeVisible()
}

test("a search left for a result comes back with its words, filter and scroll; → returns", async ({ page }) => {
  await setup(page)
  const { left } = await twoFrames(page)
  // Nowhere to go yet: both there, disabled, explaining.
  await disabled(back(left))
  await disabled(forward(left))
  await explains(page, back(left), "Nothing to go back to")
  await explains(page, forward(left), "Nothing to go forward to")
  await showCardex(left)
  await enabled(back(left))
  await explains(page, back(left), "Back to Characters")

  // Words typed and a filter set update the entry shown: no steps.
  const search = left.getByRole("searchbox", { name: "Search cardex", exact: true })
  await search.fill("a")
  const cover = left.getByRole("checkbox", { name: "Only cards with a cover", exact: true })
  await cover.click()
  const expected = await cover.isChecked()
  await expect(left.locator("[data-source-results]")).toHaveAttribute("aria-busy", "false")
  await expect(left.locator("[data-remote-card]").nth(8)).toBeVisible()
  await explains(page, back(left), "Back to Characters")
  const searched = new URL(page.url()).search

  // Scrolled down the results, then a result opened in place (the preview tab).
  await scrollerOf(left).evaluate((el) => el.scrollTo({ top: Math.min(600, el.scrollHeight - el.clientHeight) }))
  const tile = left.locator("[data-remote-card]").nth(6)
  await tile.scrollIntoViewIfNeeded()
  const scrolled = await scrollTop(left)
  expect(scrolled).toBeGreaterThan(100)
  const name = ((await tile.getByRole("link").first().getAttribute("aria-label")) ?? "").replace(/^Open /, "")
  await tile.getByRole("link").first().click()
  await expect(left.locator("[data-remote-card]")).toHaveCount(0)
  await expect(left.locator("[data-tab]").first()).toContainText(name)
  await explains(page, back(left), "Back to cardex search: a")
  await disabled(forward(left))
  await shot(page, "result-opened-1920-dark")

  // ← : the search as it was left.
  await back(left).click()
  await expect(search).toHaveValue("a")
  expect(await cover.isChecked()).toBe(expected)
  expect(new URL(page.url()).search).toBe(searched)
  await expect.poll(() => scrollTop(left)).toBeGreaterThan(scrolled - 4)
  expect(Math.abs((await scrollTop(left)) - scrolled)).toBeLessThanOrEqual(4)
  await enabled(forward(left))
  await explains(page, forward(left), `Forward to ${name}`)

  // → : the result again.
  await forward(left).click()
  await expect(left.locator("[data-tab]").first()).toContainText(name)
  await expect(left.locator("[data-remote-card]")).toHaveCount(0)
  await disabled(forward(left))

  // A reload keeps the tab's history (session storage).
  await page.reload()
  await expect(frames(page)).toHaveCount(2)
  await explains(page, back(frames(page).nth(0)), "Back to cardex search: a")
})

test("navigating in one pane leaves the other pane's arrows as they were, still working", async ({ page }) => {
  await setup(page)
  const { left, right } = await twoFrames(page)
  await showCardex(left)
  await enabled(back(left))
  await disabled(back(right))
  // In the right pane: Settings' Interface page, a step there.
  await right
    .getByRole("link", { name: /^Interface/ })
    .first()
    .click()
  await expect(right.getByRole("heading", { name: "Interface" }).first()).toBeVisible()
  await enabled(back(right))
  await explains(page, back(right), "Back to Connections")
  // The left pane's are as they were, and work.
  await explains(page, back(left), "Back to Characters")
  await disabled(forward(left))
  await back(left).click()
  await expect(left.locator("[data-remote-card]")).toHaveCount(0)
  await disabled(back(left))
  await explains(page, forward(left), "Forward to cardex")
  // The right pane didn't move.
  await expect(right.getByRole("heading", { name: "Interface" }).first()).toBeVisible()
  await enabled(back(right))
})

test("the next card replacing a preview tab beside is a step in that tab", async ({ page }) => {
  await setup(page)
  await page.goto(server().url)
  const home = frames(page).first()
  await showCardex(home)
  const tiles = home.locator("[data-remote-card]")
  const nameOf = async (i: number) =>
    ((await tiles.nth(i).getByRole("link").first().getAttribute("aria-label")) ?? "").replace(/^Open /, "")
  const first = await nameOf(0)
  const second = await nameOf(1)
  const viewBeside = async (i: number) => {
    await tiles.nth(i).getByRole("link").first().click({ button: "right" })
    await page.getByRole("menuitem", { name: /^View beside/ }).click()
  }
  await viewBeside(0)
  await expect(frames(page)).toHaveCount(2)
  const side = frames(page).nth(1)
  await expect(side.locator("[data-tab]")).toHaveCount(1)
  await expect(side.locator("[data-tab]").first()).toContainText(first)
  await disabled(back(side))
  await viewBeside(1)
  await expect(side.locator("[data-tab]")).toHaveCount(1)
  await expect(side.locator("[data-tab]").first()).toContainText(second)
  await enabled(back(side))
  await explains(page, back(side), `Back to ${first}`)
  await back(side).click()
  await expect(side.locator("[data-tab]").first()).toContainText(first)
  await explains(page, forward(side), `Forward to ${second}`)
  // The grid's pane is untouched by the side pane's steps.
  await explains(page, back(home), "Back to Characters")
})

test("the arrows follow the tab shown in their frame", async ({ page }) => {
  await setup(page)
  // Home (a preview, focused) and Settings in one frame, a second frame beside.
  await gotoWithLayout(page, server().url, "/", ["r", [0.5, 0.5], [0, "=~", "/settings"], [0, "/bin"]])
  const left = frames(page).nth(0)
  await showCardex(left)
  await enabled(back(left))
  // Settings shown: nothing to go back to in it.
  await left.locator("[data-tab]").nth(1).getByRole("tab").click()
  await disabled(back(left))
  await explains(page, back(left), "Nothing to go back to")
  // Home shown again: its history again.
  await left.locator("[data-tab]").nth(0).getByRole("tab").click()
  await enabled(back(left))
  await explains(page, back(left), "Back to Characters")
  if (process.env.LAYOUT_AUDIT) await expectLayout(page, test.info(), "tabhistory-switch-1920")
})

test("the browser's Back is the browser's, as before: it reverts the pane navigated last", async ({ page }) => {
  await setup(page)
  const { left, right } = await twoFrames(page)
  await showCardex(left)
  await right
    .getByRole("link", { name: /^Interface/ })
    .first()
    .click()
  await expect(page).toHaveURL(/\/settings\/interface/)
  // Back reverts the right pane first, as it did before tab history; the left keeps the archive.
  await page.goBack()
  await expect(page).not.toHaveURL(/\/settings\/interface/)
  await expect(right.getByRole("heading", { name: "Interface" })).toHaveCount(0)
  await expect(left.locator("[data-remote-card]").first()).toBeVisible()
  // Back again: the left pane's Characters, the browser's entry before.
  await page.goBack()
  await expect(left.locator("[data-remote-card]")).toHaveCount(0)
  expect(new URL(page.url()).pathname).toBe("/")
  expect(new URL(page.url()).searchParams.get("show")).toBeNull()
  // The left tab's own history followed it: its → goes to the archive again.
  await explains(page, forward(left), "Forward to cardex")
  await disabled(back(left))
})

for (const scheme of ["dark", "light"] as const)
  for (const width of [1920, 3840]) {
    test(`the arrows in the strips at ${width}, ${scheme}`, async ({ page }) => {
      await setup(page, width, scheme)
      const { left, right } = await twoFrames(page)
      await showCardex(left)
      await back(left).hover()
      await expect(hint(page, "Back to Characters")).toBeVisible()
      await shot(page, `strips-back-hover-${width}-${scheme}`)
      await back(right).hover()
      await expect(hint(page, "Nothing to go back to")).toBeVisible()
      await shot(page, `strips-disabled-hover-${width}-${scheme}`)
      await page.mouse.move(0, 0)
      await expect(hint(page, "Nothing to go back to")).toHaveCount(0)
      // The pair sits whole at the strip's start, before the first tab, the same size in both frames.
      for (const frame of [left, right]) {
        const strip = (await frame.locator("[data-tab-strip]").boundingBox())!
        const pair = (await frame.locator("[data-strip-history]").boundingBox())!
        const tab = (await frame.locator("[data-tab]").first().boundingBox())!
        expect(pair.x).toBeGreaterThanOrEqual(strip.x - 0.5)
        expect(pair.x + pair.width).toBeLessThanOrEqual(tab.x + 0.5)
        expect(pair.width).toBeLessThanOrEqual(68)
      }
      await shot(page, `strips-${width}-${scheme}`)
      if (process.env.LAYOUT_AUDIT) await expectLayout(page, test.info(), `tabhistory-strips-${width}-${scheme}`)
    })
  }

// Phones (one frame; its strip lists every tab once two are open) are unchanged for now
// (spec/TAB-HISTORY.md §8): the header's ← opens the app menu, it isn't a back, and the strip
// has no arrows.
for (const scheme of ["dark", "light"] as const)
  test(`on a phone the header's ← opens the app menu and the strip has no arrows, ${scheme}`, async ({ page }) => {
    await setup(page, 390, scheme)
    await gotoWithLayout(page, server().url, "/", [0, "=", "/settings"])
    await expect(page.locator("[data-tab-strip]")).toHaveCount(1)
    await expect(page.locator("[data-strip-history]")).toHaveCount(0)
    const menu = page.locator("[data-center-header]").getByRole("button", { name: "Chats and menu" })
    await expect(menu).toBeVisible()
    await shot(page, `phone-strip-and-header-390-${scheme}`)
    await menu.click()
    await shot(page, `phone-header-back-opens-menu-390-${scheme}`)
  })

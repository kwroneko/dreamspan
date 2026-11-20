// A message's actions (owner, 2026-11-01): its "More actions" menu lists every action, the
// toolbar's included, each with a checkbox that shows it as a button on the message. Ticking
// or unticking one changes the toolbar at once without closing the menu or running the
// action; the choice is the account's, so it holds across a reload and in another browser.
// Edit, Continue, Branch from here and Delete show by default; an action a message doesn't
// offer isn't on it, pinned or not; no two actions share an icon; many pins never wrap the
// message or scroll it sideways. Removed actions stay absent even with old stored pins.
import { expect, type Browser, type Locator, type Page, test } from "@playwright/test"
import { join } from "node:path"
import { showActions } from "./support/message.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "400", FAKE_GENERATOR_TOKENS: "40" })

const shoot = async (page: Page, name: string) => {
  const dir = process.env.SCREENSHOT_DIR
  if (dir) await page.screenshot({ path: join(dir, `${name}.png`) })
}

const generating = (page: Page) => page.getByText("generating", { exact: true })
const settled = (page: Page) => expect(generating(page)).toHaveCount(0, { timeout: 20_000 })
const reply = (page: Page) => page.getByRole("article", { name: "Reply", exact: true }).last()
const mine = (page: Page) => page.getByRole("article", { name: "Your message", exact: true }).first()
const toolbar = (message: Locator) => message.getByRole("toolbar", { name: "Message actions" }).locator("visible=true")
const menu = (page: Page) => page.getByRole("menu", { name: "More actions" })

/** Each test starts from the defaults: the account's choices are put back to them. */
const DEFAULTS = {
  "message.edit": true,
  "message.continue": true,
  "message.branch": true,
  "message.delete": true,
  "message.copy-text": false,
  "message.copy-link": false,
  "message.insert-above": false,
  "message.write-version": false,
  "message.add-guidance": false,
  "message.insert-below": false,
  "message.duplicate": false,
  "message.move-up": false,
  "message.move-down": false,
  "message.merge": false,
  "message.threads": false,
  "message.join-thread": false,
  "message.visibility": false,
  "message.context": false,
  "message.select": false,
  "message.delete-all": false
}
test.beforeEach(async () => {
  await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.SetDisplayPrefs({ prefs: { messageToolbar: DEFAULTS } })
  )
})

const phoneContext = (browser: Browser, colorScheme: "light" | "dark" = "light") =>
  browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme })

/** A chat whose reply has two versions. */
const newChat = async (page: Page, title: string) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats`)
  await page.getByLabel("Title of the new chat").fill(title)
  await page.getByRole("button", { name: "New chat", exact: true }).click()
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible()
  await page.getByLabel("Message", { exact: true }).fill("The lantern swings over the quay.")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(reply(page)).toBeVisible()
  await settled(page)
  await reply(page).getByRole("button", { name: "Generate another version", exact: true }).click()
  await expect(reply(page).getByRole("group", { name: "Versions", exact: true })).toContainText("2/2")
  await settled(page)
  return page.url()
}

/** The buttons on a message's toolbar, by name, More actions last. */
const buttons = async (message: Locator) => {
  await showActions(message)
  const bar = toolbar(message)
  await expect(bar).toBeVisible()
  return bar
    .locator(":is(button, a):visible")
    .evaluateAll((elements) => elements.map((element) => element.getAttribute("aria-label")))
}

const openMenu = async (message: Locator) => {
  await showActions(message)
  await toolbar(message).getByRole("button", { name: "More actions" }).click()
  await expect(menu(message.page())).toBeVisible()
}

const EVERY_REPLY_ACTION = [
  "Edit",
  "Continue",
  "Write your own version",
  "New version with guidance…",
  "Branch from here",
  "Start parallel threads here…",
  "Insert message below",
  "Duplicate",
  "Move up",
  "Move down",
  "Merge a chat here…",
  "Hide from the model",
  // "Open request inspector" is on a version with a recorded request: not the fake
  // generator's (inspector.spec.ts has it).
  "Copy text",
  "Copy link",
  "Select messages",
  "Delete version",
  "Delete all versions"
]

for (const width of [1440, 390] as const) {
  test(`every action is listed, pins follow the menu at once and the account everywhere (${width}px)`, async ({
    browser
  }) => {
    const context =
      width === 390 ? await phoneContext(browser) : await browser.newContext({ viewport: { width, height: 900 } })
    const page = await context.newPage()
    const url = await newChat(page, `Quay ${width}`)
    expect(await buttons(reply(page))).toEqual([
      "Edit",
      "Continue",
      "Branch from here",
      "Delete version",
      "More actions"
    ])

    await openMenu(reply(page))
    const items = menu(page).getByRole("menuitem")
    await expect(items).toHaveText(EVERY_REPLY_ACTION.map((name) => new RegExp(`^${name}`)))
    // Each row's checkbox names its action, and says whether it shows.
    for (const name of EVERY_REPLY_ACTION) {
      const checkbox = menu(page).getByRole("menuitemcheckbox", { name: `Show ${name} on the message`, exact: true })
      await expect(checkbox).toHaveAttribute(
        "aria-checked",
        ["Edit", "Continue", "Branch from here", "Delete version"].includes(name) ? "true" : "false"
      )
    }
    // No two actions share an icon.
    const icons = await items.evaluateAll((elements) =>
      elements.map((element) => element.querySelector("svg")!.innerHTML)
    )
    expect(new Set(icons).size).toBe(icons.length)
    if (width === 390) {
      // A real touch target, beside a row as tall.
      const box = (await menu(page)
        .getByRole("menuitemcheckbox", { name: "Show Copy text on the message" })
        .boundingBox())!
      expect(box.width).toBeGreaterThanOrEqual(44)
      expect(box.height).toBeGreaterThanOrEqual(44)
    }

    // Ticking and unticking change the toolbar at once; the menu stays open, nothing runs.
    await menu(page).getByRole("menuitemcheckbox", { name: "Show Copy text on the message" }).click()
    await menu(page).getByRole("menuitemcheckbox", { name: "Show Edit on the message" }).click()
    await expect(menu(page)).toBeVisible()
    await expect(page.getByRole("textbox", { name: /Edit/ })).toHaveCount(0)
    await expect(toolbar(reply(page)).getByRole("button", { name: "Copy text", exact: true })).toBeVisible()
    await expect(toolbar(reply(page)).getByRole("button", { name: "Edit", exact: true })).toHaveCount(0)
    await expect(menu(page).getByRole("menuitemcheckbox", { name: "Show Copy text on the message" })).toHaveAttribute(
      "aria-checked",
      "true"
    )
    // By keyboard: arrows reach the checkbox, Space ticks it, the menu stays.
    await page.keyboard.press("Home")
    for (let step = 0; step < 40; step++) {
      const focused = await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? "")
      if (focused === "Show Copy link on the message") break
      await page.keyboard.press("ArrowDown")
    }
    await page.keyboard.press("Space")
    await expect(menu(page)).toBeVisible()
    await expect(toolbar(reply(page)).getByRole("button", { name: "Copy link", exact: true })).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(menu(page)).toHaveCount(0)
    const pinned = ["Continue", "Branch from here", "Copy text", "Copy link", "Delete version", "More actions"]
    expect(await buttons(reply(page))).toEqual(pinned)

    // The account's choice: after a reload, and in another browser of the same account.
    await page.reload()
    await expect(reply(page)).toBeVisible()
    expect(await buttons(reply(page))).toEqual(pinned)
    const other = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const second = await other.newPage()
    await apiLogin(second.request, server(), ADMIN.handle, ADMIN.password)
    await second.goto(url)
    await expect(reply(second)).toBeVisible()
    expect(await buttons(reply(second))).toEqual(pinned)
    await other.close()

    // An action a message doesn't offer isn't on it, pinned or not: Insert message above is
    // only on the first message shown.
    await openMenu(mine(page))
    await menu(page).getByRole("menuitemcheckbox", { name: "Show Insert message above on the message" }).click()
    await page.keyboard.press("Escape")
    expect(await buttons(mine(page))).toContain("Insert message above")
    expect(await buttons(reply(page))).not.toContain("Insert message above")
    await context.close()
  })
}

test("many pins at a phone's width stay on one line, the rest in More actions", async ({ browser }) => {
  const context = await phoneContext(browser)
  const page = await context.newPage()
  await newChat(page, "Breakwater")
  await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.SetDisplayPrefs({
      prefs: {
        messageToolbar: {
          ...Object.fromEntries(Object.keys(DEFAULTS).map((id) => [id, true])),
          "message.threads": true
        }
      }
    })
  )
  await page.reload()
  await expect(reply(page)).toBeVisible()
  const shown = await buttons(reply(page))
  expect(shown.at(-1)).toBe("More actions")
  expect(shown.length).toBeGreaterThan(3)
  expect(shown.length).toBeLessThan(EVERY_REPLY_ACTION.length + 1)
  const bar = toolbar(reply(page))
  const fits = await bar.evaluate((element) => {
    const box = element.getBoundingClientRect()
    const message = element.closest("article")!.getBoundingClientRect()
    const tops = new Set(
      [...element.querySelectorAll(":scope > *")]
        .filter((child) => (child as HTMLElement).offsetWidth > 0)
        .map((child) => child.getBoundingClientRect().top)
    )
    return {
      inside: box.right <= message.right + 0.5,
      oneLine: tops.size === 1,
      noScroll:
        element.scrollWidth <= element.clientWidth + 0.5 && document.documentElement.scrollWidth <= window.innerWidth
    }
  })
  expect(fits).toEqual({ inside: true, oneLine: true, noScroll: true })
  // The ones without room are still ticked in the menu, which says why they aren't shown.
  await openMenu(reply(page))
  for (const name of EVERY_REPLY_ACTION)
    await expect(menu(page).getByRole("menuitemcheckbox", { name: `Show ${name} on the message` })).toHaveAttribute(
      "aria-checked",
      "true"
    )
  await context.close()
})

for (const width of [1440, 390]) {
  test(`removed model actions stay absent with an old account pin (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
      api.SetDisplayPrefs({ prefs: { messageToolbar: { "message.regenerate-with": true, "message.copy-text": true } } })
    )
    await newChat(page, `Old model pin ${width}`)
    await page.reload()
    for (const message of [reply(page), mine(page)]) {
      expect(await buttons(message)).toContain("Copy text")
      await expect(
        message.getByRole("button", { name: /Regenerate with|Generate a version with|Retry with/ })
      ).toHaveCount(0)
      await openMenu(message)
      await expect(
        menu(page).getByRole("menuitem", { name: /Regenerate with|Generate a version with|Retry with/ })
      ).toHaveCount(0)
      await expect(menu(page).getByRole("menuitem", { name: "Copy text", exact: true })).toBeVisible()
      await page.keyboard.press("Escape")
    }
    await expect(mine(page).getByText("Retry with…")).toHaveCount(0)
    await expect(reply(page).getByText("Retry with…")).toHaveCount(0)
  })
}

for (const scheme of ["light", "dark"] as const)
  for (const width of [1440, 390] as const)
    test(`screenshots of the menu and a toolbar with several pins (${width}px, ${scheme})`, async ({ browser }) => {
      test.skip(!process.env.SCREENSHOT_DIR, "screenshots only")
      const context =
        width === 390
          ? await phoneContext(browser, scheme)
          : await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme })
      const page = await context.newPage()
      await newChat(page, `Harbour ${width} ${scheme}`)
      await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        api.SetDisplayPrefs({
          prefs: { messageToolbar: { "message.copy-text": true, "message.visibility": true, "message.context": true } }
        })
      )
      await page.reload()
      await expect(reply(page)).toBeVisible()
      await buttons(reply(page))
      await shoot(page, `toolbar-${width}-${scheme}`)
      await openMenu(reply(page))
      await menu(page).getByRole("menuitem", { name: "Branch from here" }).hover()
      await page.waitForTimeout(600)
      await shoot(page, `menu-${width}-${scheme}`)
      await context.close()
    })

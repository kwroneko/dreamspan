// A pending chat (before the first send) has the saved chat's side panel (DESIGN §2.1, owner
// 2026-11-02: it looks and works like any other chat): resizable, with the same tabs; and a
// character added in its Cast tab before the first send is in the chat that send makes.
import { test, expect, type Page } from "@playwright/test"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { openPanel } from "./support/panel.ts"

const server = serverPerFile(withAdmin)

const importCard = (page: Page, name: string, first_mes: string) =>
  page.request.post(`${server().url}/library/import?name=${encodeURIComponent(name)}.json`, {
    data: Buffer.from(JSON.stringify({ spec: "chara_card_v2", spec_version: "2.0", data: { name, first_mes } })),
    headers: { origin: server().url, "content-type": "application/octet-stream" }
  })

const setup = async (page: Page) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const existing = await asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.ListCards())
  for (const [name, greeting] of [
    ["Panel Wren", "Wren waves."],
    ["Panel Ivo", "Ivo nods."]
  ] as const)
    if (!existing.some((card) => card.name === name)) await importCard(page, name, greeting)
  const cards = await asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.ListCards())
  return {
    wren: cards.find((card) => card.name === "Panel Wren")!,
    ivo: cards.find((card) => card.name === "Panel Ivo")!
  }
}

/**
 * Every tab the open panel offers: its tools (with those under More) and its cast strip; and
 * which of the tools are registered as offered only once the chat is saved (`savedOnly`).
 */
const tabNames = async (page: Page) => {
  const tools = page.getByRole("tablist", { name: "Chat panel" })
  await expect(tools).toBeVisible()
  const names = await tools.getByRole("tab").allInnerTexts()
  const savedOnly = await tools.locator("[data-saved-only]").allInnerTexts()
  const more = page.getByRole("button", { name: "More tools", exact: true })
  if (await more.isVisible()) {
    await more.click()
    const menu = page.getByRole("menu", { name: "More tools", exact: true })
    await expect(menu.getByRole("menuitem").last()).toBeVisible()
    names.push(...(await menu.getByRole("menuitem").allInnerTexts()))
    savedOnly.push(...(await menu.locator("[data-saved-only]").allInnerTexts()))
    await page.keyboard.press("Escape")
    await expect(menu).toHaveCount(0)
  }
  const cast = await page.getByRole("tablist", { name: "Characters", exact: true }).getByRole("tab").allInnerTexts()
  const trim = (list: Array<string>) => list.map((name) => name.trim())
  return {
    tabs: [...trim(names).sort(), "|", ...trim(cast)],
    savedOnly: trim(savedOnly).sort()
  }
}

test("a pending chat's side panel resizes and has the saved chat's tabs", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const { wren } = await setup(page)
  await page.goto(`${server().url}/cards/${wren.entityId}/chat`)
  await expect(page.getByRole("article", { name: "Greeting from Panel Wren" })).toBeVisible()
  await openPanel(page, "Cast")
  const pendingTabs = await tabNames(page)
  // Resizable, as the saved chat's panel is.
  const grip = page.getByRole("separator", { name: "Resize chat panel" })
  const panel = page.getByRole("complementary", { name: "Chat panel" })
  const before = (await panel.boundingBox())!.width
  await grip.focus()
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowLeft")
  await expect.poll(async () => (await panel.boundingBox())!.width).toBeGreaterThan(before + 20)
  // A tab that needs the saved chat says so, in its place.
  await openPanel(page, "Notes")
  await expect(page.getByRole("tabpanel", { name: "Notes" })).toContainText("Available once the chat is saved")
  // The first send saves it in place: the same panel, its tab and its width.
  const width = (await panel.boundingBox())!.width
  await page.getByLabel("Message", { exact: true }).fill("Hello, Wren.")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(page).toHaveURL(/\/chats\/[^/?]+\?.*panel=notes/)
  await expect(page.getByRole("tabpanel", { name: "Notes" })).not.toContainText("Available once the chat is saved")
  await expect(page.getByRole("tabpanel", { name: "Notes" })).toBeVisible()
  await expect.poll(async () => Math.abs(((await panel.boundingBox())?.width ?? 0) - width)).toBeLessThanOrEqual(1)
  // The same tabs, apart from those registered as offered only once the chat is saved: the
  // Workshop tab, whose workshop is attached to the saved chat (spec/WORKSHOP.md §4).
  const saved = await tabNames(page)
  expect(pendingTabs.savedOnly).toEqual([])
  expect(saved.savedOnly).toEqual(["Workshop"])
  expect(pendingTabs.tabs).not.toContain("Workshop")
  expect(saved.tabs.filter((name) => !saved.savedOnly.includes(name))).toEqual(pendingTabs.tabs)
  // With no workshop beside it yet, the tab explains itself and offers to start one.
  await openPanel(page, "Workshop")
  const start = page
    .getByRole("tabpanel", { name: "Workshop" })
    .getByRole("button", { name: "Start a workshop", exact: true })
  await expect(start).toBeVisible()
  await expect(start).toHaveAccessibleDescription(
    "Starts a new workshop beside this chat, to talk about it out of character."
  )
})

test("the first send opens the saved chat with no loading skeleton or placeholder title", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const { wren } = await setup(page)
  await page.goto(`${server().url}/cards/${wren.entityId}/chat`)
  await expect(page.getByRole("article", { name: "Greeting from Panel Wren" })).toBeVisible()
  // Everything the page adds from here on: the messages' skeleton, the header's placeholder name.
  await page.evaluate(() => {
    const seen: Array<string> = []
    ;(window as unknown as { seen: Array<string> }).seen = seen
    const check = (node: Node) => {
      if (!(node instanceof Element)) return
      for (const [selector, what] of [
        ['[data-testid="messages-loading"]', "skeleton"],
        ['[aria-label="Loading the chat"]', "placeholder title"]
      ] as const)
        if (node.matches(selector) || node.querySelector(selector)) seen.push(what)
    }
    new MutationObserver((records) => {
      for (const record of records) record.addedNodes.forEach(check)
    }).observe(document.body, { childList: true, subtree: true })
  })
  await page.getByLabel("Message", { exact: true }).fill("Hello again, Wren.")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(page).toHaveURL(/\/chats\/[^/?]+/)
  await expect(page.getByRole("article", { name: "Your message" })).toContainText("Hello again, Wren.")
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^Panel Wren, /)
  expect(await page.evaluate(() => (window as unknown as { seen: Array<string> }).seen)).toEqual([])
})

test("a character added in the pending Cast tab is in the chat the first send makes", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const { wren } = await setup(page)
  await page.goto(`${server().url}/cards/${wren.entityId}/chat`)
  const cast = await openPanel(page, "Cast")
  await cast.getByRole("button", { name: "Add characters" }).click()
  const add = cast.getByRole("button", { name: "Add Panel Ivo to this chat" })
  await add.click()
  await expect(cast.getByRole("listitem", { name: "Panel Ivo" })).toBeVisible()
  await expect(page.getByRole("article", { name: "Greeting from Panel Ivo" })).toBeVisible()
  // The header names both, as the saved chat will be named.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Panel Wren & Panel Ivo")
  // Two characters: who answers first is picked here too.
  await expect(cast.getByLabel("Reply from", { exact: true })).toBeVisible()
  await page.getByLabel("Message", { exact: true }).fill("Hello, both.")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(page).toHaveURL(/\/chats\/[^/?]+/)
  const saved = page.getByRole("tabpanel", { name: "Cast" })
  await expect(saved.getByRole("listitem", { name: "Panel Ivo" })).toBeVisible()
  await expect(saved.getByRole("listitem", { name: "Panel Wren" })).toBeVisible()
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Panel Wren & Panel Ivo")
})

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`saved-only URL and first-send tab continuity: ${width} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme })
      const { wren } = await setup(page)
      await page.goto(`${server().url}/cards/${wren.entityId}/chat?panel=workshop`)
      await expect(page).toHaveURL(/panel=chat(?:&|$)/)
      await expect(page.getByRole("tabpanel", { name: "This chat", exact: true })).toBeVisible()
      // Close the phone sheet so the composer can be used, then select a tab whose position
      // and focus must survive the first send. Programmatic click leaves focus on that tab.
      if (width === 390) await page.keyboard.press("Escape")
      await page.getByLabel("Message", { exact: true }).fill("Keep the panel steady.")
      await openPanel(page, "Notes")
      const notes = page.getByRole("tab", { name: "Notes", exact: true })
      await notes.focus()
      if (width === 390)
        await page.locator('[data-layout-overlay="Modal sheet covers the page"]').evaluate(async (sheet) => {
          await Promise.all(sheet.getAnimations().map((animation) => animation.finished))
        })
      await notes.evaluate((element) => {
        const before = element.getBoundingClientRect()
        const samples: Array<{ x: number; y: number; focused: boolean; connected: boolean }> = []
        const state = { done: false, samples, before: { x: before.x, y: before.y } }
        ;(window as unknown as { tabContinuity: typeof state }).tabContinuity = state
        const sample = () => {
          const current = [...document.querySelectorAll<HTMLElement>('[data-chat-panel-tabs] [role="tab"]')].find(
            (tab) => tab.textContent?.trim() === "Notes"
          )
          const box = current?.getBoundingClientRect()
          samples.push({
            x: box?.x ?? -1,
            y: box?.y ?? -1,
            focused: document.activeElement === current,
            connected: current?.isConnected ?? false
          })
          if (!state.done) requestAnimationFrame(sample)
        }
        sample()
      })
      await page
        .getByRole("button", { name: "Send", exact: true, includeHidden: true })
        .evaluate((button: HTMLButtonElement) => button.click())
      await expect(page).toHaveURL(/\/chats\/[^/?]+\?.*panel=notes/)
      await expect(page.getByRole("tabpanel", { name: "Notes" })).not.toContainText("Available once the chat is saved")
      await expect(notes).toBeFocused()
      const continuity = await page.evaluate(() => {
        const state = (
          window as unknown as {
            tabContinuity: {
              done: boolean
              before: { x: number; y: number }
              samples: Array<{ x: number; y: number; focused: boolean; connected: boolean }>
            }
          }
        ).tabContinuity
        state.done = true
        return state
      })
      expect(continuity.samples.length).toBeGreaterThan(0)
      for (const sample of continuity.samples) {
        expect(sample.connected).toBe(true)
        expect(sample.focused).toBe(true)
        expect(Math.abs(sample.x - continuity.before.x)).toBeLessThanOrEqual(1)
        expect(Math.abs(sample.y - continuity.before.y)).toBeLessThanOrEqual(1)
      }
      expect((await tabNames(page)).savedOnly).toEqual(["Workshop"])
      await openPanel(page, "Workshop")
      await expect(page).toHaveURL(/panel=workshop/)
      await expect(page.getByRole("button", { name: "Start a workshop", exact: true })).toBeVisible()
    })

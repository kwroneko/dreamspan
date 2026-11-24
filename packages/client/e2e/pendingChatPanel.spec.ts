// A new chat (a pending chat until its first send, DraftChatPage.tsx) has the chat's own side
// panel (DESIGN §2.1, owner 2026-11-02: it looks and works like any other chat): resizable, with
// the same tabs, a tab that needs a started chat saying so in its place; and a character added in
// its Cast tab before the first send is in the chat that send starts.
import { test, expect, type Page } from "@playwright/test"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { openPanel } from "./support/panel.ts"
import { expectNewSideHint, pendingSideChat } from "./support/workshopSideChat.ts"

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
 * which of the tools are registered as needing a started chat (`savedOnly`).
 */
const NOT_STARTED = "Available once the chat is started: send a message first."
const greeting = (page: Page, text: string) => page.getByRole("article").filter({ hasText: text })

const tabNames = async (page: Page) => {
  const tools = page.getByRole("tablist", { name: "Chat panel" })
  await expect(tools).toBeVisible()
  // The open tool shown as a guest is also under More: counted there, once.
  const names = await tools.locator('[role="tab"]:not([data-tab-guest])').allInnerTexts()
  const savedOnly = await tools.locator("[data-saved-only]:not([data-tab-guest])").allInnerTexts()
  const more = page.getByRole("button", { name: "More tools", exact: true })
  if (await more.isVisible()) {
    await more.click()
    const menu = page.getByRole("menu", { name: "More tools", exact: true })
    await expect(menu.locator('[role="menuitem"][data-tab-value]').last()).toBeVisible()
    // The tools, not Arrange tabs….
    names.push(...(await menu.locator('[role="menuitem"][data-tab-value]').allInnerTexts()))
    savedOnly.push(...(await menu.locator("[data-saved-only]").allInnerTexts()))
    await page.keyboard.press("Escape")
    await expect(menu).toHaveCount(0)
  }
  const cast = await page.getByRole("tablist", { name: "Characters", exact: true }).getByRole("tab").allInnerTexts()
  const trim = (list: Array<string>) => list.map((name) => name.replace(/\s*Shown above$/, "").trim())
  return {
    tabs: [...trim(names).sort(), "|", ...trim(cast)],
    savedOnly: trim(savedOnly).sort()
  }
}

test("a new chat's side panel resizes and has the started chat's tabs", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const { wren } = await setup(page)
  await page.goto(`${server().url}/cards/${wren.entityId}/chat`)
  await expect(greeting(page, "Wren waves.")).toBeVisible()
  await openPanel(page, "Cast")
  const pendingTabs = await tabNames(page)
  // Resizable, as the saved chat's panel is.
  const grip = page.getByRole("separator", { name: "Resize chat panel" })
  const panel = page.getByRole("complementary", { name: "Chat panel" })
  const before = (await panel.boundingBox())!.width
  await grip.focus()
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowLeft")
  await expect.poll(async () => (await panel.boundingBox())!.width).toBeGreaterThan(before + 20)
  // A tab that needs a started chat (the Workshop, attached to a started chat: spec/WORKSHOP.md
  // §4) stays in its place and says so.
  await openPanel(page, "Workshop")
  const workshop = page.getByRole("tabpanel", { name: "Workshop" })
  await expect(workshop).toContainText(NOT_STARTED)
  // The first send starts it in place: the same panel, its tab and its width.
  const width = (await panel.boundingBox())!.width
  await page.getByLabel("Message", { exact: true }).fill("Hello, Wren.")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(page).toHaveURL(/\/chats\/[^/?]+\?.*panel=workshop/)
  // (Its own placeholder: the header's disabled Changes says the same of a workshop not started.)
  await expect(workshop.getByText(NOT_STARTED, { exact: true })).toHaveCount(0)
  await expect.poll(async () => Math.abs(((await panel.boundingBox())?.width ?? 0) - width)).toBeLessThanOrEqual(1)
  // The same tabs before and after.
  const saved = await tabNames(page)
  expect(pendingTabs.savedOnly).toEqual(["Workshop"])
  expect(saved).toEqual(pendingTabs)
  // With no workshop beside it yet, the tab is its chat already: a new one, what it is on its
  // "new" badge's hover, and the composer.
  await expect(pendingSideChat(page)).toBeVisible({ timeout: 30_000 })
  await expectNewSideHint(page)
  await expect(workshop.getByLabel("Message", { exact: true })).toBeVisible()
})

test("the first send opens the saved chat with no loading skeleton or placeholder title", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const { wren } = await setup(page)
  await page.goto(`${server().url}/cards/${wren.entityId}/chat`)
  await expect(greeting(page, "Wren waves.")).toBeVisible()
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

test("the first send keeps its timeline when the header read fails", async ({ page }) => {
  const { wren } = await setup(page)
  let failed = false
  await page.routeWebSocket("**/rpc", (socket) => {
    const upstream = socket.connectToServer()
    socket.onMessage((data) => {
      const request = typeof data === "string" ? (JSON.parse(data) as { id?: string; tag?: string }) : null
      if (!failed && request?.tag === "GetSplitChats") {
        failed = true
        socket.send(
          JSON.stringify({
            _tag: "Exit",
            requestId: request.id,
            exit: {
              _tag: "Failure",
              cause: [{ _tag: "Fail", error: { _tag: "ServerError", message: "Header interrupted" } }]
            }
          })
        )
      } else upstream.send(data)
    })
  })
  await page.goto(`${server().url}/cards/${wren.entityId}/chat`)
  await expect(greeting(page, "Wren waves.")).toBeVisible()
  await page.evaluate(() => {
    const state = { showedSkeleton: false }
    Object.assign(window, { firstSend: state })
    const selector = '[data-testid="messages-loading"]'
    new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes)
          if (node instanceof Element && (node.matches(selector) || node.querySelector(selector)))
            state.showedSkeleton = true
    }).observe(document.body, { childList: true, subtree: true })
  })
  await page.getByLabel("Message", { exact: true }).fill("Hello after the header failure.")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(page).toHaveURL(/\/chats\/[^/?]+/)
  await expect(page.getByRole("article", { name: "Your message" })).toContainText("Hello after the header failure.")
  expect(failed).toBe(true)
  expect(
    await page.evaluate(
      () => (window as unknown as { firstSend: { showedSkeleton: boolean } }).firstSend.showedSkeleton
    )
  ).toBe(false)
})

test("a character added in a new chat's Cast tab is in the chat the first send starts", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const { wren } = await setup(page)
  await page.goto(`${server().url}/cards/${wren.entityId}/chat`)
  const cast = await openPanel(page, "Cast")
  await cast.getByRole("button", { name: "Add characters" }).click()
  const add = cast.getByRole("button", { name: "Add Panel Ivo to this chat" })
  await add.click()
  await expect(cast.getByRole("listitem", { name: "Panel Ivo" })).toBeVisible()
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
    test(`a waiting tab's URL and first-send tab continuity: ${width} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme })
      const { wren } = await setup(page)
      // The Workshop tab waits in its place on a new chat: its URL keeps it.
      await page.goto(`${server().url}/cards/${wren.entityId}/chat?panel=workshop`)
      await expect(page).toHaveURL(/panel=workshop(?:&|$)/)
      await expect(page.getByRole("tabpanel", { name: "Workshop", exact: true })).toContainText(NOT_STARTED)
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
      await expect(page.getByRole("tabpanel", { name: "Notes" })).toBeVisible()
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
      await expect(pendingSideChat(page)).toBeVisible({ timeout: 30_000 })
    })

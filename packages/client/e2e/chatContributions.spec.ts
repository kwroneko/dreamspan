// Vite lets a synthetic plugin import the very modules used by the mounted application.
// Production builds contain no test hook or global plugin interface.
import { expect, test, type Page } from "@playwright/test"
import { Effect } from "effect"
import { resolve } from "node:path"
import { createServer, type ViteDevServer } from "vite"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { showActions } from "./support/message.ts"
import type { install, close } from "./support/chatContributions.ts"

const server = serverPerFile(withAdmin)
let vite: ViteDevServer
let url: string
test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000)
  vite = await createServer({
    root: resolve(import.meta.dirname, ".."),
    server: {
      host: "127.0.0.1",
      port: 0,
      proxy: {
        "/rpc": { target: server().url.replace(/^http/, "ws"), ws: true },
        "/auth": { target: server().url }
      }
    }
  })
  await vite.listen()
  url = vite.resolvedUrls!.local[0]!.replace(/\/$/, "")
  // Compile the dev application's lazy chat/Markdown modules and the synthetic
  // plugin before timing individual interactions. Production suites use a build;
  // this file needs Vite's live module graph to exercise registry replacement.
  const warm = await browser.newPage()
  try {
    await setup(warm, 120_000)
    await expect(warm.locator("article .markdown")).toHaveText("A synthetic message.")
    await contribution(warm, "install", "cards")
    await contribution(warm, "close", "cards")
  } finally {
    await warm.close()
  }
})
test.afterAll(async () => {
  await vite?.close()
})

type Fixture = { install: typeof install; close: typeof close }
const contribution = (page: Page, operation: "install" | "close", id: Parameters<Fixture["install"]>[0]) =>
  page.evaluate(
    async ({ operation, id }) => {
      const path = "/e2e/support/chatContributions.ts"
      const fixture = (await import(/* @vite-ignore */ path)) as Fixture
      await fixture[operation](id)
    },
    { operation, id }
  )

const setup = async (page: Page, timeout = 30_000) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const chat = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const card = yield* api.CreateCard({ label: "Synthetic Mira", name: "Mira" })
      const chat = yield* api.CreateChat({ title: "Contribution review" })
      yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: card.entityId } })
      yield* api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "A synthetic message." })
      return chat
    })
  )
  await page.goto(`${url}/chats/${chat.id}`)
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeEditable({ timeout })
}

test("scoped contributions update mounted panels, controls, commands and dialogs, then disappear", async ({ page }) => {
  await setup(page)
  await contribution(page, "install", "plugin")
  await page.getByRole("button", { name: "Plugin send", exact: true }).click()
  await page.getByRole("textbox", { name: "Message", exact: true }).press("Control+Enter")
  await expect(page.locator("body")).toHaveAttribute("data-plugin-sends", "2")
  // A command's shortcut doesn't fire while typing in a text field (ac8a5a1).
  await page.getByRole("textbox", { name: "Message", exact: true }).blur()
  await page.keyboard.press("Control+y")
  await expect(page.locator("body")).toHaveAttribute("data-plugin-commands", "1")
  await page.getByRole("button", { name: "Chat actions", exact: true }).click()
  await page.getByRole("menuitem", { name: "Plugin command", exact: true }).click()
  await expect(page.locator("body")).toHaveAttribute("data-plugin-commands", "2")
  const message = page.getByRole("article", { name: "Your message", exact: true })
  await showActions(message)
  await message.getByRole("button", { name: "Plugin message action", exact: true }).click()
  await expect(page.getByRole("dialog", { name: "Plugin dialog", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Plugin panel", exact: true }).click()
  await expect(page.getByText("Scoped plugin panel", { exact: true })).toBeVisible()
  await contribution(page, "close", "plugin")
  await expect(page.getByRole("complementary", { name: "Chat panel", exact: true })).toHaveCount(0)
  await expect(page.getByRole("dialog", { name: "Plugin dialog", exact: true })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Plugin send", exact: true })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Plugin message action", exact: true })).toHaveCount(0)
  await expect(page.getByRole("button", { name: /^(Send|Mira replies)$/ })).toBeVisible()
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press("Control+y")
  await expect(page.locator("body")).toHaveAttribute("data-plugin-commands", "2")
})

test("panel disablement removes dependent settings buttons, notes links and history shortcuts", async ({ page }) => {
  await setup(page)
  await expect(page.getByRole("button", { name: "Model settings", exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Prompt preset settings", exact: true })).toBeVisible()
  await contribution(page, "install", "settings")
  await expect(page.getByRole("button", { name: "Model settings", exact: true })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Prompt preset settings", exact: true })).toHaveCount(0)
  await contribution(page, "close", "settings")
  await expect(page.getByRole("button", { name: "Model settings", exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Prompt preset settings", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Show Mira's card", exact: true }).click()
  // The character tab's More menu has the card's notes while the Notes panel is there.
  const notes = async (count: number) => {
    await page.getByRole("button", { name: "More for Mira", exact: true }).click()
    await expect(page.getByRole("menuitem", { name: "Mira's notes", exact: true })).toHaveCount(count)
    await page.keyboard.press("Escape")
  }
  await notes(1)
  await contribution(page, "install", "notes")
  await notes(0)
  await contribution(page, "close", "notes")
  await notes(1)
  await page.getByRole("button", { name: "Close the panel", exact: true }).click()
  await contribution(page, "install", "history")
  // The menu stays for the reply commands (ac8a5a1), without the history ones.
  await page.getByRole("button", { name: "Chat actions", exact: true }).click()
  await expect(page.getByRole("menuitem", { name: "Edit your last message (Ctrl+ArrowUp)" })).toBeVisible()
  await expect(page.getByRole("menuitem", { name: /^(Search and replace|History edits)$/ })).toHaveCount(0)
  await page.keyboard.press("Escape")
  await page.keyboard.press("Control+h")
  await expect(page.getByRole("complementary", { name: "Chat panel", exact: true })).toHaveCount(0)
  await contribution(page, "close", "history")
  await page.keyboard.press("Control+h")
  await expect(page.getByRole("heading", { name: "Search and replace", exact: true })).toBeVisible()
})

test("a dynamic family obeys individual disablement and never opens an unlisted URL", async ({ page }) => {
  await setup(page)
  await contribution(page, "install", "plugin")
  await contribution(page, "install", "family-tab")
  await expect(page.getByRole("button", { name: "Plugin panel", exact: true })).toHaveCount(0)
  await contribution(page, "close", "family-tab")
  await page.getByRole("button", { name: "Plugin panel", exact: true }).click()
  await page.getByRole("button", { name: "Unlisted family URL", exact: true }).click()
  // A family's tab this chat doesn't offer opens the panel's default tab instead (panelHere).
  await expect(page).toHaveURL(/panel=chat(&|$)/)
  const panel = page.getByRole("complementary", { name: "Chat panel", exact: true })
  await expect(panel.getByRole("tab", { name: "This chat", exact: true })).toHaveAttribute("aria-selected", "true")
  await expect(panel.getByRole("tabpanel", { name: /absent/i })).toHaveCount(0)
})

test("card contributions update every mounted placement and restore built-ins", async ({ page }) => {
  test.setTimeout(120_000)
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const card = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.CreateCard({ label: "Card seam review", name: "Card seam review" })
  )
  for (const path of [`/cards/${card.entityId}`, `/library/${card.id}`, "/library"]) {
    await page.goto(`${url}${path}`)
    const host =
      path === "/library"
        ? page.getByRole("list", { name: "Cards", exact: true }).locator("li").filter({ hasText: "Card seam review" })
        : page.locator("main")
    const fork = host.getByRole("button", { name: "Fork", exact: true })
    await expect(fork).toBeEnabled()
    await contribution(page, "install", "cards")
    await expect(host.getByText("Plugin card actions", { exact: true })).toBeVisible()
    await expect(host.getByText("Added card action", { exact: true })).toBeVisible()
    await expect(host.getByText("Plugin card provenance", { exact: true })).toBeVisible()
    if (path !== "/library") await expect(host.getByText("Plugin card family", { exact: true })).toBeVisible()
    await contribution(page, "install", "card-hide")
    await expect(host.getByText("Plugin card actions", { exact: true })).toHaveCount(0)
    await contribution(page, "close", "card-hide")
    await expect(host.getByText("Plugin card actions", { exact: true })).toBeVisible()
    await contribution(page, "close", "cards")
    await expect(host.getByText(/^Plugin card /)).toHaveCount(0)
    await expect(host.getByText("Added card action", { exact: true })).toHaveCount(0)
    await expect(fork).toBeEnabled()
    // Disabling an action also unmounts its open dialog.
    await fork.click()
    await expect(page.getByRole("dialog", { name: "Fork card", exact: true })).toBeVisible()
    await contribution(page, "install", "card-hide")
    await expect(page.getByRole("dialog", { name: "Fork card", exact: true })).toHaveCount(0)
    await contribution(page, "close", "card-hide")
    await expect(fork).toBeEnabled()
  }
  await page.goto(url)
  await expect(page.getByRole("button", { name: "Open Card seam review", exact: true })).toBeVisible()
  const tile = page.getByRole("button", { name: "Open Card seam review", exact: true }).locator("..")
  await contribution(page, "install", "cards")
  await expect(tile.getByText("Plugin card badge", { exact: true })).toBeVisible()
  await contribution(page, "close", "cards")
  await expect(tile.getByText("Plugin card badge", { exact: true })).toHaveCount(0)
})

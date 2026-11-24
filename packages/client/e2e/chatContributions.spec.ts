// Vite lets a synthetic plugin import the very modules used by the mounted application.
// Production builds contain no test hook or global plugin interface.
import { expect, test, type Page } from "@playwright/test"
import { Effect } from "effect"
import { resolve } from "node:path"
import { createServer, type ViteDevServer } from "vite"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { showActions } from "./support/message.ts"
import { openPanel } from "./support/panel.ts"
import { modelChip, presetChip } from "./support/strip.ts"
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
        "/auth": { target: server().url },
        // vite.config.ts sends these to the dev server's default port otherwise (merged config):
        // the app's plugin list and its health check would come from whatever runs there.
        "/plugins": { target: server().url },
        "/healthz": { target: server().url },
        "/frame/panel": { target: server().url }
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

test("a synchronous message editor takes the rendered text's place when it commits", async ({ page }) => {
  await setup(page)
  await contribution(page, "install", "text-editor")
  const message = page.getByRole("article", { name: "Your message", exact: true })
  await showActions(message)
  await message.getByRole("button", { name: "Edit", exact: true }).click()
  const editor = message.getByRole("textbox", { name: "Message text", exact: true })
  await expect(editor).toHaveValue("A synthetic message.")
  await expect(message.locator("[data-reply-text]")).toBeHidden()
  await expect(editor).toHaveCSS("pointer-events", "auto")
  await editor.fill("Synthetic edit.")
  await expect(editor).toHaveValue("Synthetic edit.")
})

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
  await openPanel(page, "Plugin panel")
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

/** Whether the chip's popover offers its side panel tab in its footer, then closes it. */
const expectFooter = async (page: Page, chip: "model" | "preset", shown: boolean) => {
  await (chip === "model" ? modelChip(page) : presetChip(page)).click()
  await expect(page.getByRole("radiogroup", { name: chip === "model" ? "Model" : "Prompt preset" })).toBeVisible()
  const row = page.getByRole("button", { name: chip === "model" ? "Model settings…" : "Edit preset…", exact: true })
  if (shown) await expect(row).toBeVisible()
  else await expect(row).toHaveCount(0)
  await page.keyboard.press("Escape")
  await expect(page.getByRole("radiogroup")).toHaveCount(0)
}

test("panel disablement removes dependent settings buttons, notes links and history shortcuts", async ({ page }) => {
  // Each settings check opens and closes a chip's popover: twelve round trips on a shared host.
  test.setTimeout(120_000)
  await setup(page)
  await expectFooter(page, "model", true)
  await expectFooter(page, "preset", true)
  await contribution(page, "install", "settings")
  await expectFooter(page, "model", false)
  await expectFooter(page, "preset", false)
  await contribution(page, "close", "settings")
  await expectFooter(page, "model", true)
  await expectFooter(page, "preset", true)
  await page.getByRole("button", { name: "Show Mira's card", exact: true }).click()
  // The character tab has no More menu: the card's notes are its own Notes sub-tab, with or
  // without the chat's Notes panel.
  const notes = async () => {
    await expect(page.getByRole("button", { name: "More for Mira", exact: true })).toHaveCount(0)
    await expect(
      page.getByRole("tablist", { name: "Card fields" }).getByRole("tab", { name: "Notes", exact: true })
    ).toBeVisible()
  }
  await notes()
  await contribution(page, "install", "notes")
  await notes()
  await contribution(page, "close", "notes")
  await notes()
  await page.getByRole("button", { name: "Hide panel", exact: true }).click()
  await contribution(page, "install", "history")
  // The menu stays for the chat's commands, without the history ones; keys are listed apart.
  await page.getByRole("button", { name: "Chat actions", exact: true }).click()
  await expect(page.getByRole("menuitem", { name: "Keyboard shortcuts", exact: true })).toBeVisible()
  await expect(page.getByRole("menuitem", { name: /^(Search and replace|Applied edits)$/ })).toHaveCount(0)
  await page.keyboard.press("Escape")
  await page.keyboard.press("Control+h")
  await expect(page.getByRole("complementary", { name: "Chat panel", exact: true })).toHaveCount(0)
  await contribution(page, "close", "history")
  await page.keyboard.press("Control+h")
  await expect(page.getByRole("heading", { name: "Searches", exact: true })).toBeVisible()
})

test("a dynamic family obeys individual disablement and never opens an unlisted URL", async ({ page }) => {
  await setup(page)
  await contribution(page, "install", "plugin")
  await contribution(page, "install", "family-tab")
  // The header has one panel toggle; the panel's tabs say what's there.
  await page.getByRole("button", { name: "Chat panel", exact: true }).click()
  await expect(page.getByRole("tablist", { name: "Chat panel" })).toBeVisible()
  await expect(page.getByRole("tab", { name: "Plugin panel", exact: true })).toHaveCount(0)
  await contribution(page, "close", "family-tab")
  await openPanel(page, "Plugin panel")
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
  for (const path of [`/cards/${card.entityId}`, `/library/${card.id}`]) {
    await page.goto(`${url}${path}`)
    const host = page.locator("main")
    const fork = host.getByRole("button", { name: "Fork", exact: true })
    await expect(fork).toBeEnabled()
    await contribution(page, "install", "cards")
    await expect(host.getByText("Plugin card actions", { exact: true })).toBeVisible()
    await expect(host.getByText("Added card action", { exact: true })).toBeVisible()
    await expect(host.getByText("Plugin card provenance", { exact: true })).toBeVisible()
    await expect(host.getByText("Plugin card family", { exact: true })).toBeVisible()
    await contribution(page, "install", "card-hide")
    await expect(host.getByText("Plugin card actions", { exact: true })).toHaveCount(0)
    await contribution(page, "close", "card-hide")
    await expect(host.getByText("Plugin card actions", { exact: true })).toBeVisible()
    await contribution(page, "close", "cards")
    await expect(host.getByText(/^Plugin card /)).toHaveCount(0)
    await expect(host.getByText("Added card action", { exact: true })).toHaveCount(0)
    await expect(fork).toBeEnabled()
    // Disabling an action also unmounts its open dialog, and restoring the action doesn't
    // bring the dialog back (its URL open entry went with it); what was typed in it stays.
    await fork.click()
    const dialog = page.getByRole("dialog", { name: "Fork card", exact: true })
    await expect(dialog).toBeVisible()
    await dialog.getByRole("textbox", { name: "Version (shown as subtitle)", exact: true }).fill("seam draft")
    await contribution(page, "install", "card-hide")
    await expect(dialog).toHaveCount(0)
    await contribution(page, "close", "card-hide")
    await expect(fork).toBeEnabled()
    await expect(dialog).toHaveCount(0)
    await fork.click()
    await expect(dialog.getByRole("textbox", { name: "Version (shown as subtitle)", exact: true })).toHaveValue(
      "seam draft"
    )
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
    await expect(dialog).toHaveCount(0)
  }
  // The library item: its overflow menu lists the card contributions' and the library's own
  // registered actions, live, and an action's dialog goes when the action does.
  await page.goto(`${url}/library`)
  const row = page
    .getByRole("list", { name: "Cards", exact: true })
    .locator("li")
    .filter({ hasText: "Card seam review" })
  const more = row.getByRole("button", { name: /^More actions for Card seam review/ })
  const menu = page.getByRole("menu")
  await more.click()
  await expect(menu.getByRole("menuitem", { name: "Fork…", exact: true })).toBeEnabled()
  await contribution(page, "install", "cards")
  await expect(menu.getByText("Plugin card actions", { exact: true })).toBeVisible()
  await expect(menu.getByText("Added card action", { exact: true })).toBeVisible()
  await expect(menu.getByText("Added library action", { exact: true })).toBeVisible()
  await expect(row.getByText("Plugin card badge", { exact: true })).toBeVisible()
  await expect(row.getByRole("link", { name: "Edit Card seam review", exact: true })).toBeVisible()
  await contribution(page, "install", "card-hide")
  await expect(menu.getByText("Plugin card actions", { exact: true })).toHaveCount(0)
  await expect(row.getByRole("link", { name: "Edit Card seam review", exact: true })).toHaveCount(0)
  await contribution(page, "close", "card-hide")
  await contribution(page, "close", "cards")
  await expect(menu.getByText(/^(Plugin card|Added) /)).toHaveCount(0)
  await expect(row.getByText("Plugin card badge", { exact: true })).toHaveCount(0)
  await menu.getByRole("menuitem", { name: "Fork…", exact: true }).click()
  await expect(page.getByRole("dialog", { name: "Fork card", exact: true })).toBeVisible()
  await contribution(page, "install", "card-hide")
  await expect(page.getByRole("dialog", { name: "Fork card", exact: true })).toHaveCount(0)
  await contribution(page, "close", "card-hide")
  await expect(row.getByRole("link", { name: "Edit Card seam review", exact: true })).toBeVisible()
  await page.goto(url)
  await expect(page.getByRole("link", { name: "Open Card seam review", exact: true })).toBeVisible()
  const tile = page.getByRole("link", { name: "Open Card seam review", exact: true }).locator("..")
  await contribution(page, "install", "cards")
  await expect(tile.getByText("Plugin card badge", { exact: true })).toBeVisible()
  await contribution(page, "close", "cards")
  await expect(tile.getByText("Plugin card badge", { exact: true })).toHaveCount(0)
})

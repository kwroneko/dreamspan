// A plugin or setting that disables the header's panel toggle (`chat.panel`) leaves only that
// button out: the panel still opens from the chat (a portrait, a link), so an open panel keeps
// a way to close itself. Vite lets the test disable the very registration the app mounted.
import { expect, test, type Page } from "@playwright/test"
import { Effect } from "effect"
import { mkdirSync } from "node:fs"
import { createServer as createNetServer } from "node:net"
import { resolve } from "node:path"
import { createServer, type ViteDevServer } from "vite"
import { openPanel } from "./support/panel.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, startServer, type TestServer, withAdmin } from "./support/server.ts"

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createNetServer()
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      probe.close(() => resolve(typeof address === "object" && address ? address.port : 0))
    })
  })

let running: TestServer | undefined
const server = () => running!
/** The synthetic card source the server starts: its cards open as chats not made yet. */
let fake: string
let vite: ViteDevServer
let url: string
test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000)
  const port = await freePort()
  fake = `http://127.0.0.1:${port}`
  running = await startServer({ ...withAdmin, FAKE_CARD_SOURCE: String(port) })
  vite = await createServer({
    root: resolve(import.meta.dirname, ".."),
    server: {
      host: "127.0.0.1",
      port: 0,
      proxy: {
        "/rpc": { target: server().url.replace(/^http/, "ws"), ws: true },
        "/auth": { target: server().url },
        "/plugins": { target: server().url },
        "/healthz": { target: server().url },
        "/frame/panel": { target: server().url },
        // The card source's portraits.
        "/sources": {
          target: server().url,
          bypass: (req) => (req.headers.accept?.includes("text/html") ? req.url : undefined)
        }
      }
    }
  })
  await vite.listen()
  url = vite.resolvedUrls!.local[0]!.replace(/\/$/, "")
  // A cold dev server compiles the chat's modules on first load: do that before timing steps.
  const warm = await browser.newPage()
  try {
    const { chat } = await fixture("Synthetic warm-up")
    await apiLogin(warm.request, server(), ADMIN.handle, ADMIN.password)
    await warm.goto(`${url}/chats/${chat.id}`, { timeout: 0 })
    await expect(warm.getByRole("textbox", { name: "Message", exact: true })).toBeEditable({ timeout: 0 })
    await openPanel(warm, "Notes")
  } finally {
    await warm.close()
  }
})
test.afterAll(async () => {
  await vite?.close()
  await running?.stop()
})

const fixture = (title: string) =>
  asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const card = yield* api.CreateCard({ label: `${title} Mira`, name: "Mira" })
      const chat = yield* api.CreateChat({ title })
      yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: card.entityId } })
      yield* api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "A synthetic message." })
      return { chat, card }
    })
  )

/** Disables `chat.panel` in a header slot, as a plugin would; "enable" undoes it. */
const toggle = (page: Page, operation: "disable" | "enable", slot: "chatHeaderActions" | "pendingChatHeaderActions") =>
  page.evaluate(
    async ({ operation, slot }) => {
      const path = "/src/features/chat/presentation.tsx"
      const slots = (await import(/* @vite-ignore */ path)) as Record<string, { disable: (id: string) => () => void }>
      const held = globalThis as { panelToggleUndo?: () => void }
      if (operation === "disable") held.panelToggleUndo = slots[slot]!.disable("chat.panel")
      else held.panelToggleUndo?.()
    },
    { operation, slot }
  )

/** Where to save screenshots for review, when asked (PANEL_SHOTS=dir). */
const shot = async (page: Page, name: string) => {
  const dir = process.env.PANEL_SHOTS
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  await page.screenshot({ path: `${dir}/${name}.png` })
}
const panel = (page: Page) => page.getByRole("complementary", { name: "Chat panel" })

test.use({ viewport: { width: 1920, height: 1080 }, colorScheme: "dark" })

test("an open panel can still be closed once the header's panel toggle is disabled", async ({ page }) => {
  test.setTimeout(120_000)
  const { chat } = await fixture("Panel toggle disabled")
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${url}/chats/${chat.id}`)
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeEditable({ timeout: 30_000 })
  await openPanel(page, "Notes")
  const header = page.getByRole("button", { name: "Hide panel", exact: true })
  await expect(header).toHaveCount(1)
  // With the header's toggle in place, the panel has no close of its own: one Hide panel.
  const own = panel(page).getByRole("button", { name: "Hide panel", exact: true })
  await expect(own).toHaveCount(0)
  const row = panel(page).locator("[data-chat-panel-tabs] > div").first()
  const before = await row.boundingBox()

  await toggle(page, "disable", "chatHeaderActions")
  // The header's button is gone; the panel keeps a close of its own, in its tab row.
  await expect(panel(page)).toBeVisible()
  await expect(own).toBeVisible()
  await expect(page.getByRole("button", { name: "Hide panel", exact: true })).toHaveCount(1)
  // The row keeps its height, and the close sits right after the tools, at the row's end.
  expect((await row.boundingBox())!.height).toBe(before!.height)
  const tabs = await panel(page).getByRole("tablist", { name: "Chat panel" }).boundingBox()
  const close = (await own.boundingBox())!
  const rowBox = (await row.boundingBox())!
  expect(close.x).toBeGreaterThan(tabs!.x + tabs!.width - 1)
  expect(rowBox.x + rowBox.width - (close.x + close.width)).toBeLessThanOrEqual(12)
  await shot(page, "saved-dark-1920")
  await own.click()
  await expect(panel(page)).toHaveCount(0)
  await expect(page).not.toHaveURL(/[?&]panel=/)

  // Opened again from the chat (a header portrait), it still closes.
  await page.getByRole("button", { name: /^Show Mira.*'s card$/ }).click()
  await expect(panel(page)).toBeVisible()
  await own.click()
  await expect(panel(page)).toHaveCount(0)

  // A link's ?panel= opens it after a reload, the plugin disabling the toggle again on start.
  await page.goto(`${url}/chats/${chat.id}?panel=notes`)
  await expect(panel(page)).toBeVisible({ timeout: 30_000 })
  await toggle(page, "disable", "chatHeaderActions")
  await expect(own).toBeVisible()
  // Enabled again, the header's toggle is back and the panel's own close goes.
  await toggle(page, "enable", "chatHeaderActions")
  await expect(own).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Hide panel", exact: true })).toHaveCount(1)
})

test("closing the panel by keyboard returns focus to its chat", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const { chat } = await fixture("Keyboard panel close")
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${url}/chats/${chat.id}`)
  const composer = page.getByRole("textbox", { name: "Message", exact: true })
  await expect(composer).toBeEditable()
  await toggle(page, "disable", "chatHeaderActions")
  await page.getByRole("button", { name: /^Show Mira.*'s card$/ }).click()
  await panel(page).getByRole("button", { name: "More tools", exact: true }).focus()
  await page.keyboard.press("Tab")
  await expect(panel(page).getByRole("button", { name: "Hide panel", exact: true })).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(panel(page)).toHaveCount(0)
  await expect(composer).toBeFocused()
})

test("the preset tab clears More tools as the panel's close appears", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 900 })
  await page.emulateMedia({ reducedMotion: "no-preference" })
  const { chat } = await fixture("Narrow panel tools")
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${url}/chats/${chat.id}?panel=preset&cpw=260`)
  const preset = panel(page).getByRole("tab", { name: "Prompt preset", exact: true })
  await expect(preset).toBeVisible()
  await expect(preset).not.toHaveAttribute("data-tab-guest", "true")
  await page.evaluate(async () => {
    await document.fonts.ready
  })

  const maxOverlap = await page.evaluate(async () => {
    const path = "/src/features/chat/presentation.tsx"
    const { chatHeaderActions } = (await import(/* @vite-ignore */ path)) as {
      chatHeaderActions: { disable: (id: string) => void }
    }
    const row = document.querySelector("[data-chat-panel-tabs]")!
    return new Promise<number>((resolve) => {
      let start: number | undefined
      let max = 0
      const frame = (now: number) => {
        if (!row.querySelector('[aria-label="Hide panel"]')) {
          requestAnimationFrame(frame)
          return
        }
        start ??= now
        const preset = row.querySelector('[role="tab"][data-tab-value="preset"]')?.getBoundingClientRect()
        const more = row.querySelector('[aria-label="More tools"]')?.getBoundingClientRect()
        if (preset && more) max = Math.max(max, Math.min(preset.right, more.right) - Math.max(preset.left, more.left))
        if (now - start < 250) requestAnimationFrame(frame)
        else resolve(max)
      }
      requestAnimationFrame(frame)
      chatHeaderActions.disable("chat.panel")
    })
  })
  await expect(panel(page).getByRole("button", { name: "Hide panel", exact: true })).toBeVisible()
  await expect(preset).toHaveAttribute("data-tab-guest", "true")
  expect(maxOverlap).toBeLessThanOrEqual(1)
})

test("a chat not made yet keeps its panel's close when its panel toggle is disabled", async ({ page }) => {
  test.setTimeout(120_000)
  // A card source's card before its first send.
  const listed = (await (await fetch(`${fake}/api/v1/search?limit=1&sort=name`)).json()) as {
    items: ReadonlyArray<{ slug: string }>
  }
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${url}/sources/cardex/cards/${listed.items[0]!.slug}/chat?panel=notes`)
  await expect(panel(page)).toBeVisible({ timeout: 30_000 })
  await toggle(page, "disable", "pendingChatHeaderActions")
  const own = panel(page).getByRole("button", { name: "Hide panel", exact: true })
  await expect(own).toBeVisible()
  await shot(page, "pending-dark-1920")
  await own.click()
  await expect(panel(page)).toHaveCount(0)
  await toggle(page, "enable", "pendingChatHeaderActions")
})

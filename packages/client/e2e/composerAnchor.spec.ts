// The composer stays at the bottom of the chat column however short the chat (owner,
// 2026-11-17: a new chat with one greeting had its composer right under the greeting, the
// rest of the screen empty). A saved chat with one message, a card's chat before its first
// send, a card source's card's (the page that fell out of the shell's list of filling
// screens), at 1440 and 390, and two chats side by side in split panes. Synthetic cards only;
// the card source is the fake archive.
import { createServer } from "node:net"
import { expect, type Locator, type Page, test } from "@playwright/test"
import type { EntityId } from "@dreamspan/shared/chat.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, startServer, type TestServer, withAdmin } from "./support/server.ts"

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer()
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      probe.close(() => resolve(typeof address === "object" && address ? address.port : 0))
    })
  })

let server: TestServer
let fake: string
test.beforeAll(async () => {
  const port = await freePort()
  fake = `http://127.0.0.1:${port}`
  server = await startServer({ ...withAdmin, FAKE_CARD_SOURCE: String(port) })
})
test.afterAll(async () => {
  await server?.stop()
})

const importCard = async (page: Page, name: string) => {
  const response = await page.request.post(`${server.url}/library/import?name=card.json`, {
    headers: { origin: server.url, "content-type": "application/octet-stream" },
    data: Buffer.from(
      JSON.stringify({
        spec: "chara_card_v2",
        spec_version: "2.0",
        data: {
          name,
          first_mes: "The harbour bell rings once, and the fog comes in.",
          alternate_greetings: ["Gulls circle the empty pier."]
        }
      })
    )
  })
  expect(response.ok()).toBeTruthy()
  return (await response.json()).library.ref.entityId as EntityId
}

/** A saved chat with one message: the card's greeting. */
const oneMessageChat = async (page: Page, title: string) => {
  const card = await importCard(page, `Ashen ${title}`)
  const chat = await asUser(server, ADMIN.handle, ADMIN.password, (api) => api.CreateChat({ title }))
  await asUser(server, ADMIN.handle, ADMIN.password, (api) =>
    api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: card } })
  )
  await asUser(server, ADMIN.handle, ADMIN.password, (api) =>
    api.SendMessage({
      chatId: chat.id,
      parentSlotId: null,
      branch: false,
      content: "The harbour bell rings once, and the fog comes in.",
      speakerEntityId: card
    })
  )
  return chat.id
}

/** Where the chat column, its last block and its frame end, and where the composer's box is. */
const measure = (scope: Locator) =>
  scope.locator("[data-chat-main]").evaluate((column) => {
    const host = column.parentElement!.closest("main, [data-frame-body]")!
    const blocks = [...column.children].filter((child) => {
      const box = child.getBoundingClientRect()
      const style = getComputedStyle(child)
      return box.height > 0 && style.position !== "absolute" && style.position !== "fixed"
    })
    const text = column.querySelector('[data-testid="composer"]')!
    const box = text.getBoundingClientRect()
    return {
      inLast: blocks.at(-1)!.contains(text),
      host: host.getBoundingClientRect().bottom,
      column: column.getBoundingClientRect().bottom,
      last: blocks.at(-1)!.getBoundingClientRect().bottom,
      composer: box.bottom
    }
  })

const expectAnchored = async (scope: Locator) => {
  await expect(scope.getByTestId("composer")).toBeVisible()
  await expect(async () => {
    const at = await measure(scope)
    // The column reaches its frame's bottom, and the composer's block ends there.
    expect(Math.abs(at.host - at.column), JSON.stringify(at)).toBeLessThanOrEqual(2)
    expect(Math.abs(at.column - at.last), JSON.stringify(at)).toBeLessThanOrEqual(2)
    // The text box is in that block, with only the composer's own rows of chips under it.
    expect(at.inLast, JSON.stringify(at)).toBe(true)
    expect(at.column - at.composer, JSON.stringify(at)).toBeLessThan(240)
  }).toPass({ timeout: 10_000 })
}

const closePhonePanel = async (page: Page, width: number) => {
  if (width !== 390) return
  const close = page.getByRole("button", { name: "Close", exact: true })
  if (await close.isVisible()) await close.click()
}

for (const [width, height] of [
  [1440, 900],
  [390, 844]
] as const)
  for (const theme of ["light", "dark"] as const) {
    const label = `${width} ${theme}`
    test.describe(label, () => {
      test.beforeEach(async ({ page }) => {
        await page.setViewportSize({ width, height })
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
        await page.addInitScript((shown) => localStorage.setItem("dreamspan.theme", shown), theme)
        await apiLogin(page.request, server, ADMIN.handle, ADMIN.password)
      })

      test(`${label}: a saved chat with one message`, async ({ page }, info) => {
        const chat = await oneMessageChat(page, `One ${label}`)
        await page.goto(`${server.url}/chats/${chat}`)
        await expect(page.locator("[data-chat-main]").getByText("The harbour bell rings once").first()).toBeVisible()
        await closePhonePanel(page, width)
        await expectAnchored(page.locator("body"))
        if (process.env.LAYOUT_AUDIT) await expectLayout(page, info, `saved-${width}-${theme}`)
      })

      test(`${label}: a card's chat before its first send`, async ({ page }, info) => {
        const card = await importCard(page, `Pending ${label}`)
        await page.goto(`${server.url}/cards/${card}/chat`)
        await expect(page.locator("[data-chat-main]").getByText("The harbour bell rings once").first()).toBeVisible()
        await closePhonePanel(page, width)
        await expectAnchored(page.locator("body"))
        if (process.env.LAYOUT_AUDIT) await expectLayout(page, info, `pending-${width}-${theme}`)
      })

      test(`${label}: a card source's card before its first send`, async ({ page }, info) => {
        const listed = (await (await fetch(`${fake}/api/v1/search?limit=1&sort=name`)).json()) as {
          items: ReadonlyArray<{ slug: string; name: string }>
        }
        await page.goto(`${server.url}/sources/cardex/cards/${listed.items[0]!.slug}/chat`)
        await expect(page.getByTestId("composer")).toBeVisible()
        await closePhonePanel(page, width)
        await expectAnchored(page.locator("body"))
        if (process.env.LAYOUT_AUDIT) await expectLayout(page, info, `remote-${width}-${theme}`)
      })
    })
  }

for (const theme of ["light", "dark"] as const)
  test(`1440 ${theme}: two one-message chats in split panes`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
    await page.addInitScript((shown) => localStorage.setItem("dreamspan.theme", shown), theme)
    await apiLogin(page.request, server, ADMIN.handle, ADMIN.password)
    const left = await oneMessageChat(page, `Left ${theme}`)
    await oneMessageChat(page, `Right ${theme}`)
    await page.goto(`${server.url}/chats/${left}`)
    await expect(page.locator("[data-chat-main]").getByText("The harbour bell rings once").first()).toBeVisible()
    await page.getByRole("button", { name: "Split right" }).first().click()
    await page
      .getByRole("complementary", { name: "Sidebar" })
      .getByRole("link", { name: new RegExp(`^Open chat Right ${theme}`) })
      .click()
    const frames = page.locator("[data-frame]")
    await expect(frames).toHaveCount(2)
    for (const frame of [frames.first(), frames.last()]) await expectAnchored(frame)
    if (process.env.LAYOUT_AUDIT) await expectLayout(page, info, `split-${theme}`)
  })

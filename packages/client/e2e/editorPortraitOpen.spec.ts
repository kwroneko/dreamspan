// A click on the card's portrait in the full editor (its header and Metadata's Picture) and in
// the side panel's card editor opens the whole image, as a message's portrait does (owner,
// 2026-11-24: "Clicking on the card portrait in the full size editor does nothing"). The cards
// here are made up. EDITOR_PORTRAIT_SHOTS=<dir> saves dark screenshots at 1920.
import { createServer } from "node:net"
import { join } from "node:path"
import { expect, type Locator, type Page, test } from "@playwright/test"
import type { EntityId } from "@dreamspan/shared/chat.ts"
import { cardFieldsTab } from "./support/cardEditor.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, startServer, withAdmin } from "./support/server.ts"
import { shapeCard } from "./support/shapes.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "200" })
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
test.setTimeout(120_000)
const shots = process.env.EDITOR_PORTRAIT_SHOTS
const VIEW = "View Tall's picture"

let chat = ""
let tall = { id: "", entityId: "" as EntityId }
test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage()
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const response = await page.request.post(`${server().url}/library/import?name=Tall.png`, {
    data: shapeCard({ name: "Tall", width: 1024, height: 1536 }, 0),
    headers: { origin: server().url, "content-type": "application/octet-stream" }
  })
  expect(response.ok()).toBeTruthy()
  await page.close()
  const list = await admin((api) => api.ListLibrary({ kind: "card" }))
  const ref = list.find((r) => r.label === "Tall")!
  tall = { id: ref.id as string, entityId: ref.entityId as EntityId }
  const started = await admin((api) =>
    api.StartChat({
      cards: [tall.entityId],
      persona: null,
      greeting: 0,
      first: { _tag: "Send", content: "Is anyone here?", speakerEntityId: null }
    })
  )
  chat = started.chat.id
})

/** The same hover text and cursor as a message's portrait. */
const expectViewable = async (button: Locator) => {
  await expect(button).toHaveAttribute("title", "View Tall's full portrait")
  expect(await button.evaluate((node) => getComputedStyle(node).cursor)).toBe("pointer")
}

const shoot = async (page: Page, name: string) => {
  if (!shots) return
  await page.mouse.move(0, 0)
  await page.screenshot({ animations: "disabled", path: join(shots, name) })
}

/** The full-screen viewer a portrait opens outside a chat: the image, then closed again. */
const opensFullScreen = async (page: Page, button: Locator, shot?: string) => {
  await expectViewable(button)
  await button.click()
  const viewer = page.getByRole("dialog", { name: "Tall", exact: true })
  await expect(viewer).toBeVisible()
  const image = viewer.locator("[data-image-viewer] img:not([aria-hidden])")
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(1024)
  if (shot) await shoot(page, shot)
  await viewer.getByRole("button", { name: "Close", exact: true }).click()
  await expect(viewer).toHaveCount(0)
}

test("the full editor's portraits open the whole image, as elsewhere", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" })
  await page.setViewportSize({ width: 1920, height: 1080 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/library/${tall.id}`)
  const editor = page.getByRole("region", { name: "Card editor", exact: true })
  const header = editor.locator("[data-card-header-portrait]").getByRole("button", { name: VIEW, exact: true })
  await shoot(page, "card-page-1920-dark.png")
  await opensFullScreen(page, header, "card-page-viewer-1920-dark.png")
  const metadata = await cardFieldsTab(editor, "Metadata")
  await opensFullScreen(
    page,
    metadata.getByRole("region", { name: "Picture" }).getByRole("button", { name: VIEW, exact: true })
  )
  // Changing the picture stays on its own visible button.
  await expect(editor.locator("[data-card-header-portrait] [data-picture-button]")).toBeVisible()
})

test("the side panel's card editor opens the image in the chat's column, as a message's portrait does", async ({
  page
}) => {
  await page.emulateMedia({ colorScheme: "dark" })
  await page.setViewportSize({ width: 1920, height: 1080 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chat}?panel=${encodeURIComponent(`card:${tall.entityId}`)}`)
  const header = page
    .getByRole("tabpanel", { name: "Tall" })
    .locator("[data-card-header-portrait]")
    .getByRole("button", { name: VIEW, exact: true })
  await expectViewable(header)
  const viewer = page.getByRole("complementary", { name: "Tall's portrait", exact: true })
  await header.click()
  await expect(viewer).toBeVisible()
  await shoot(page, "side-panel-viewer-1920-dark.png")
  await header.click()
  await expect(viewer).toHaveCount(0)
})

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer()
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      probe.close(() => resolve(typeof address === "object" && address ? address.port : 0))
    })
  })

test("a card source's card, opened for reading, opens its whole picture the same way", async ({ page }) => {
  const port = await freePort()
  const own = await startServer({ ...withAdmin, FAKE_CARD_SOURCE: String(port) })
  try {
    const listed = (await (await fetch(`http://127.0.0.1:${port}/api/v1/search?limit=20&sort=name`)).json()) as {
      items: ReadonlyArray<{ slug: string; name: string; image_url: string | null; kind: string }>
    }
    const card = listed.items.find((item) => item.image_url !== null && item.kind === "character")!
    await apiLogin(page.request, own, ADMIN.handle, ADMIN.password)
    await page.emulateMedia({ colorScheme: "dark" })
    await page.setViewportSize({ width: 1920, height: 1080 })
    await page.goto(`${own.url}/sources/cardex/cards/${encodeURIComponent(card.slug)}`)
    const editor = page.locator("[data-read-only-card]")
    const button = editor.getByRole("button", { name: `View ${card.name}'s portrait`, exact: true })
    await expect(button).toHaveAttribute("title", `View ${card.name}'s full portrait`)
    expect(await button.evaluate((node) => getComputedStyle(node).cursor)).toBe("pointer")
    await button.click()
    const viewer = page.getByRole("dialog", { name: card.name, exact: true })
    await expect(viewer).toBeVisible()
    const image = viewer.locator("[data-image-viewer] img:not([aria-hidden])")
    await expect
      .poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
      .toBeGreaterThan(0)
    await shoot(page, "source-card-viewer-1920-dark.png")
    await viewer.getByRole("button", { name: "Close", exact: true }).click()
    await expect(viewer).toHaveCount(0)
  } finally {
    await own.stop()
  }
})

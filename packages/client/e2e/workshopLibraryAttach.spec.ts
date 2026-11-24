// Attaching library items to a workshop's message in the browser (spec/WORKSHOP-CARDS.md §4,
// units C3 and C4): the paperclip is a menu in a workshop; Cards… and Lorebooks… open their
// pickers with ticks for several and Attach with the count; the items wait in the composer as
// tiles (kept over a reload, each with its X), a card dropped on the composer joins them, and
// the send carries them: the message shows the same tiles and the model reads them. A story's
// paperclip stays the one-tap image picker. Synthetic cards and a scripted loopback provider only.
import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import type { EntityId } from "@dreamspan/shared/chat.ts"
import type { RefId } from "@dreamspan/shared/library.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { asUser, type Client } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { startWorkshopProvider } from "./support/workshopProvider.ts"

const shots = process.env.SCREENSHOT_DIR
/** The reply names the attached items the request carried, so the test sees what the model read. */
const seen = (body: { messages: ReadonlyArray<{ role: string; content?: unknown }> }) => {
  const names = [...JSON.stringify(body.messages).matchAll(/<attached_(?:card|lorebook) name=\\"([^"\\]+)\\"/g)].map(
    (match) => match[1]
  )
  return names.length ? `I can see ${[...new Set(names)].join(" and ")}.` : "Nothing is attached."
}

test.describe("workshop library attachments", () => {
  const server = serverPerFile(withAdmin)
  let provider: Awaited<ReturnType<typeof startWorkshopProvider>>
  const admin = <A>(use: (client: Client) => Effect.Effect<A, unknown>) =>
    asUser(server(), ADMIN.handle, ADMIN.password, use)
  test.beforeAll(async () => {
    provider = await startWorkshopProvider({ perTask: true, calls: [], answer: seen })
    await admin((api) =>
      Effect.gen(function* () {
        const connection = yield* api.CreateConnection({
          kind: "openai-chat",
          settings: {
            name: "Synthetic workshop",
            baseUrl: provider.baseUrl,
            compat: {},
            cacheTtlS: null,
            maxConcurrent: null,
            presetOverrideRefId: null
          }
        })
        const model = yield* api.AddUserModel({ connectionId: connection.id, key: "workshop-small", overrides: {} })
        yield* api.SetGenerationDefaults({
          defaults: { model: { connection: connection.id, model: model.id }, preset: null }
        })
      })
    )
  })
  test.afterAll(async () => {
    await provider.stop()
  })

  const importCard = async (page: Page, name: string) => {
    const data = {
      name,
      description: "A synthetic lighthouse keeper.",
      personality: "Careful.",
      scenario: "A calm night.",
      first_mes: "",
      mes_example: "",
      creator_notes: "",
      system_prompt: "",
      post_history_instructions: "",
      alternate_greetings: [],
      tags: [],
      creator: "Synthetic",
      character_version: "",
      extensions: {}
    }
    const response = await page.request.post(`${server().url}/library/import?name=card.json`, {
      data: Buffer.from(JSON.stringify({ spec: "chara_card_v3", spec_version: "3.0", data })),
      headers: { origin: server().url, "content-type": "application/octet-stream" }
    })
    expect(response.status()).toBe(200)
    return (await response.json()).library.ref as { id: RefId; entityId: EntityId }
  }

  for (const width of [1340, 390])
    for (const theme of ["dark", "light"] as const)
      test(`cards and lorebooks attach from the paperclip and a drop, and go with the message, at ${width} ${theme}`, async ({
        page
      }, info) => {
        test.setTimeout(180_000)
        const tag = `${width} ${theme}`
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
        await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
        await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
        const wren = await importCard(page, `Wren ${tag}`)
        await importCard(page, `Tide ${tag}`)
        const dropped = await importCard(page, `Gull ${tag}`)
        const book = await admin((api) => api.CreateLorebook({ label: `Harbor lore ${tag}` }))
        const workshop = await admin((api) => api.CreateWorkshop({ title: `Attach ${tag}` }))
        const shot = async (label: string) => {
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
          if (!shots) return
          mkdirSync(shots, { recursive: true })
          await page.waitForTimeout(200)
          await page.screenshot({ path: resolve(shots, `library-attach-${label}-${width}-${theme}.png`) })
        }
        const tip = page.locator('[data-layout-overlay="Tooltip floats above the page"][data-open]')
        const tiles = page.getByLabel("Attachments", { exact: true }).locator("[data-library-tile]")

        await page.goto(`${server().url}/chats/${workshop.id}`)
        const attach = page.getByRole("button", { name: "Attach", exact: true })
        await attach.hover()
        await expect(tip).toHaveText(
          "Attach files, or cards, lorebooks and presets from your library. You can also paste or drop them here."
        )
        await attach.click()
        const menu = page.getByRole("menu", { name: "Attach" })
        // Each with its explanation beside it, or under it on a narrow window.
        await expect(menu.getByRole("menuitem")).toHaveText([
          /^Files from this device…/,
          /^Cards…Attach cards from your library\./,
          /^Lorebooks…/,
          /^Presets…/
        ])
        await shot("menu")
        await menu.getByRole("menuitem", { name: "Cards…" }).click()

        // Several ticked at once; Attach counts them.
        const dialog = page.getByRole("dialog", { name: "Attach cards" })
        await expect(dialog).toBeVisible()
        await dialog.getByRole("searchbox", { name: "Find a card" }).fill(tag)
        await dialog.getByRole("checkbox", { name: `Wren ${tag}` }).click()
        // The keyboard too: Down from the search into the rows (newest first: Gull, Tide), Space ticks.
        await dialog.getByRole("searchbox", { name: "Find a card" }).press("ArrowDown")
        await expect(dialog.getByRole("checkbox", { name: `Gull ${tag}` })).toBeFocused()
        await page.keyboard.press("ArrowDown")
        await expect(dialog.getByRole("checkbox", { name: `Tide ${tag}` })).toBeFocused()
        await page.keyboard.press("Space")
        await expect(dialog.getByRole("checkbox", { name: `Tide ${tag}` })).toHaveAttribute("aria-checked", "true")
        await expect(dialog.getByRole("checkbox", { name: `Gull ${tag}` })).toHaveAttribute("aria-checked", "false")
        await expect(dialog.getByRole("checkbox", { name: `Wren ${tag}` })).toHaveAttribute("aria-checked", "true")
        await expect(dialog.getByRole("button", { name: "Attach 2" })).toBeEnabled()
        await page.mouse.move(0, 0)
        await shot("cards")
        await expectLayout(page, info, `library-attach-cards-${width}-${theme}`, { scope: "[role=dialog]" })
        await dialog.getByRole("button", { name: "Attach 2" }).click()
        await expect(dialog).toBeHidden()
        await expect(tiles).toHaveCount(2)
        await expect(tiles.nth(0)).toHaveAttribute("data-library-tile", wren.id)

        // Kept on the server: a reload shows them again, in order.
        await page.reload()
        await expect(tiles).toHaveCount(2)
        await expect(tiles.locator("span.truncate")).toHaveText([`Wren ${tag}`, `Tide ${tag}`])
        // The X shows on the tile's hover (always, on a touch screen).
        await tiles.nth(1).locator("a").hover()
        await page.getByRole("button", { name: `Remove Tide ${tag}` }).click()
        await expect(tiles).toHaveCount(1)

        await attach.click()
        await page.getByRole("menu", { name: "Attach" }).getByRole("menuitem", { name: "Lorebooks…" }).click()
        const books = page.getByRole("dialog", { name: "Attach lorebooks" })
        await books.getByRole("checkbox", { name: `Harbor lore ${tag}` }).click()
        await books.getByRole("button", { name: "Attach 1" }).click()
        await expect(tiles).toHaveCount(2)

        // A card dragged onto the composer joins them (C4).
        await page
          .locator(".composer-text")
          .first()
          .evaluate((target, href) => {
            const data = new DataTransfer()
            data.setData("application/x-rp-card-tab", href)
            for (const type of ["dragover", "drop"])
              target.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }))
          }, `/library/${dropped.id}`)
        await expect(tiles).toHaveCount(3)
        await tiles.nth(0).locator("a").hover()
        await expect(tip).toHaveText(
          `Opens Wren ${tag}. It goes with your message, and the assistant can read and change it from then on.`
        )
        await page.mouse.move(0, 0)
        await shot("composer")
        await expectLayout(page, info, `library-attach-composer-${width}-${theme}`, {
          scope: '[aria-label="Attachments"]'
        })

        // The send carries them: the message shows the same tiles, and the model read them.
        await page.getByLabel("Message", { exact: true }).fill("Tighten these.")
        await page.getByRole("button", { name: /^Send( as .+)?$/ }).click()
        await expect(
          page.getByRole("article").filter({ hasText: `I can see Wren ${tag} and Harbor lore ${tag} and Gull ${tag}.` })
        ).toHaveCount(1, { timeout: 30_000 })
        await expect(tiles).toHaveCount(0)
        const message = page.getByRole("article").filter({ hasText: "Tighten these." })
        const sent = message.getByLabel("Attached from your library").locator("[data-library-tile]")
        await expect(sent).toHaveCount(3)
        await expect(sent.nth(1)).toHaveAttribute("data-library-tile", book.id)
        await shot("sent")
        await expectLayout(page, info, `library-attach-sent-${width}-${theme}`, {
          scope: '[aria-label="Attached from your library"]'
        })
      })

  test("a stale composer cannot send a card removed in another tab", async ({ page, context }) => {
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const card = await importCard(page, "Cross-tab card")
    const workshop = await admin((api) =>
      Effect.gen(function* () {
        const chat = yield* api.CreateWorkshop({ title: "Cross-tab removal" })
        const draft = yield* api.OpenComposer({ chatId: chat.id, forkId: null })
        yield* api.SetComposerLibrary({ chatId: chat.id, draftId: draft.id, add: [card.id], remove: [] })
        return chat
      })
    )
    const other = await context.newPage()
    const url = `${server().url}/chats/${workshop.id}`
    await page.goto(url)
    await other.goto(url)
    const tile = `[data-library-tile="${card.id}"]`
    await expect(page.locator(tile)).toBeVisible()
    await expect(other.locator(tile)).toBeVisible()
    await page.locator(tile).locator("a").hover()
    await page.getByRole("button", { name: "Remove Cross-tab card" }).click()
    await expect(page.locator(tile)).toHaveCount(0)

    const message = other.getByLabel("Message", { exact: true })
    const send = other.getByRole("button", { name: /^Send( as .+)?$/ })
    await message.fill("Please check this draft.")
    await send.click()
    await expect(other.locator(tile)).toHaveCount(0)
    await expect(message).toContainText("Please check this draft.")
    const posted = other.getByRole("article").filter({ hasText: "Please check this draft." })
    await expect(posted).toHaveCount(0)
    await send.click()
    await expect(posted).toHaveCount(1)
    await expect(posted.locator(tile)).toHaveCount(0)
  })

  test("a story's paperclip stays the image picker", async ({ page }) => {
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const story = await admin((api) => api.CreateChat({ title: "Story paperclip" }))
    await page.goto(`${server().url}/chats/${story.id}`)
    await expect(page.getByRole("button", { name: "Attach images" })).toBeVisible()
    await expect(page.getByRole("button", { name: "Attach", exact: true })).toHaveCount(0)
  })
})

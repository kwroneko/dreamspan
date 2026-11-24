// "Work on in a workshop" in the browser (spec/WORKSHOP-CARDS.md §4.1 point 3, unit C5): a
// lorebook's editor offers the workshops open in this browser tab's frames and A new workshop.
// Picking the open one puts the lorebook back in its message and focuses its composer; A new
// workshop opens the workshop not made yet with the item in its first message, which carries it.
// A card's More menu has the same as a submenu. Synthetic items and a scripted provider only.
import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
import { asUser, type Client } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { startWorkshopProvider } from "./support/workshopProvider.ts"

const shots = process.env.SCREENSHOT_DIR

test.describe("work on in a workshop", () => {
  const server = serverPerFile(withAdmin)
  let provider: Awaited<ReturnType<typeof startWorkshopProvider>>
  const admin = <A>(use: (client: Client) => Effect.Effect<A, unknown>) =>
    asUser(server(), ADMIN.handle, ADMIN.password, use)
  test.beforeAll(async () => {
    provider = await startWorkshopProvider({ perTask: true, calls: [], answer: () => "Noted." })
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

  const setUp = async (page: Page, width: number, theme: "dark" | "light") => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
    await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  }
  const shooter = (page: Page, width: number, theme: string) => async (label: string) => {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    if (!shots) return
    mkdirSync(shots, { recursive: true })
    await page.waitForTimeout(200)
    await page.screenshot({ path: resolve(shots, `workon-${label}-${width}-${theme}.png`) })
  }
  const tip = (page: Page) => page.locator('[data-layout-overlay="Tooltip floats above the page"][data-open]')

  for (const [width, theme] of [
    [1340, "dark"],
    [1340, "light"],
    [1920, "dark"]
  ] as const)
    test(`a lorebook's editor puts it in the workshop open beside, at ${width} ${theme}`, async ({ page }, info) => {
      test.setTimeout(150_000)
      await setUp(page, width, theme)
      const shot = shooter(page, width, theme)
      const book = await admin((api) => api.CreateLorebook({ label: `Harbor lore ${theme}` }))
      const workshop = await admin((api) => api.CreateWorkshop({ title: `Work ${theme}` }))
      const draft = await admin((api) => api.OpenComposer({ chatId: workshop.id, forkId: null }))
      await admin((api) =>
        api.SetComposerLibrary({ chatId: workshop.id, draftId: draft.id, add: [book.id], remove: [] })
      )

      await page.goto(`${server().url}/chats/${workshop.id}`)
      const tiles = page.getByLabel("Attachments", { exact: true }).locator("[data-library-tile]")
      await expect(tiles).toHaveCount(1)
      // Its tile, Alt-clicked, opens the lorebook in a frame beside; meanwhile it leaves the message.
      await tiles
        .first()
        .locator("a")
        .click({ modifiers: ["Alt"] })
      await expect(page.locator("[data-frame]")).toHaveCount(2)
      const work = page.getByRole("button", { name: "Work on in a workshop" })
      await expect(work).toBeVisible()
      // The editor's toolbar keeps one row in its half frame: the button follows the frame's width.
      const editor = page.locator("[data-frame]").nth(1)
      const centers = await Promise.all(
        ["History", "Make a variant", "Work on in a workshop"].map(async (name) => {
          const box = (await editor.getByRole("button", { name, exact: true }).boundingBox())!
          return Math.round(box.y + box.height / 2)
        })
      )
      expect(new Set(centers).size).toBe(1)
      await admin((api) =>
        api.SetComposerLibrary({ chatId: workshop.id, draftId: draft.id, add: [], remove: [book.id] })
      )

      await work.hover()
      await expect(tip(page)).toHaveText("Puts this in a workshop's message, so the assistant can work on it.")
      await work.click()
      const menu = page.getByRole("menu", { name: "Work on in a workshop" })
      await expect(menu.getByRole("menuitem")).toHaveText([new RegExp(`^Work ${theme}`), /^A new workshop/])
      await menu.getByRole("menuitem", { name: `Work ${theme}` }).hover()
      await shot("menu")
      await expectLayout(page, info, `workon-menu-${width}-${theme}`, { scope: "[role=menu]" })
      await menu.getByRole("menuitem", { name: `Work ${theme}` }).click()
      await expect(tiles).toHaveCount(1)
      await expect(tiles.first()).toHaveAttribute("data-library-tile", book.id)
      // Its composer has focus, to say what to do with it.
      await expect(page.getByLabel("Message", { exact: true })).toBeFocused()
      await shot("attached")
    })

  for (const [width, theme] of [
    [1340, "dark"],
    [390, "dark"],
    [390, "light"]
  ] as const)
    test(`A new workshop carries the item in its first message, at ${width} ${theme}`, async ({ page }, info) => {
      test.setTimeout(150_000)
      await setUp(page, width, theme)
      const shot = shooter(page, width, theme)
      const tag = `${width} ${theme}`
      const book = await admin((api) => api.CreateLorebook({ label: `Reef notes ${tag}` }))
      await page.goto(`${server().url}/library/${book.id}`)
      await page.getByRole("button", { name: "Work on in a workshop" }).click()
      const menu = page.getByRole("menu", { name: "Work on in a workshop" })
      // No workshop open in this browser tab: only a new one.
      await expect(menu.getByRole("menuitem")).toHaveText([/^A new workshop/])
      await menu.getByRole("menuitem", { name: "A new workshop" }).click()

      await expect(page).toHaveURL(/\/new\/workshop\?workshopAttach=/)
      const tiles = page.getByLabel("Attachments", { exact: true }).locator("[data-library-tile]")
      await expect(tiles).toHaveCount(1)
      await expect(tiles.first()).toHaveAttribute("data-library-tile", book.id)
      await shot("new")
      await expectLayout(page, info, `workon-new-${width}-${theme}`, { scope: '[aria-label="Attachments"]' })

      await page.getByLabel("Message", { exact: true }).fill("Sort these out.")
      await page.getByRole("button", { name: /^Send( as .+)?$/ }).click()
      await expect(page).toHaveURL(/\/chats\//, { timeout: 30_000 })
      const message = page.getByRole("article").filter({ hasText: "Sort these out." })
      const sent = message.getByLabel("Attached from your library").locator("[data-library-tile]")
      await expect(sent).toHaveCount(1)
      await expect(sent.first()).toHaveAttribute("data-library-tile", book.id)
      await shot("sent")
    })

  test("a card's More menu has it as a submenu", async ({ page }) => {
    await setUp(page, 1340, "dark")
    const card = await admin((api) =>
      api.CreateCard({ label: "Gull Keeper", name: "Gull Keeper", description: "Sorts." })
    )
    await page.goto(`${server().url}/library`)
    await page.getByRole("button", { name: `More actions for ${card.label}`, exact: true }).click()
    await page.getByRole("menuitem", { name: "Work on in a workshop" }).click()
    const sub = page.getByRole("menu", { name: "Work on in a workshop" })
    await sub.getByRole("menuitem", { name: "A new workshop" }).click()
    await expect(page).toHaveURL(/\/new\/workshop\?workshopAttach=/)
    await expect(page.getByLabel("Attachments", { exact: true }).locator("[data-library-tile]")).toHaveCount(1)
    await expect(
      page.getByLabel("Attachments", { exact: true }).locator("[data-library-tile] span.truncate")
    ).toHaveText("Gull Keeper")
  })
})

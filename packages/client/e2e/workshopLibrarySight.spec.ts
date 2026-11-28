// What a workshop's assistant may look at, in the browser (spec/WORKSHOP-CARDS.md §2, unit C7):
// reading a card outside view asks with its line and the four scopes; Allow always for the
// assistant card holds in the chip with its standing, in Settings → Assistant tools and on the
// card's Extra tab, where Remove takes it back. Synthetic data and a scripted loopback provider only.
import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
import { asUser, type Client } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { nextReply } from "./support/strip.ts"
import { startWorkshopProvider } from "./support/workshopProvider.ts"

const shots = process.env.SCREENSHOT_DIR

test.describe("library sight", () => {
  const server = serverPerFile(withAdmin)
  let provider: Awaited<ReturnType<typeof startWorkshopProvider>>
  const admin = <A>(use: (client: Client) => Effect.Effect<A, unknown>) =>
    asUser(server(), ADMIN.handle, ADMIN.password, use)
  test.beforeAll(async () => {
    provider = await startWorkshopProvider({
      perTask: true,
      calls: [{ name: "read_card", arguments: { card: "Mara Quill" } }],
      answer: "Mara keeps the lighthouse."
    })
    await admin((api) =>
      Effect.gen(function* () {
        yield* api.SetDisplayPrefs({ prefs: { steps: "expanded" } })
        const connection = yield* api.CreateConnection({
          kind: "openai-chat",
          settings: {
            providerSettings: { toolLoading: "every" },
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
        yield* api.CreateCard({ label: "Mara Quill", name: "Mara Quill", description: "Mara keeps the lighthouse." })
      })
    )
  })
  test.afterAll(async () => {
    await provider.stop()
  })

  test("keeps an unsaved library approval note across a reload and sends it with Decline", async ({ page }) => {
    test.setTimeout(120_000)
    const workshop = await admin((api) => api.CreateWorkshop({ title: "Approval note" }))
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    let holdDraft = true
    let heldDrafts = 0
    await page.routeWebSocket(/\/rpc$/, (socket) => {
      const upstream = socket.connectToServer()
      socket.onMessage((data) => {
        if (holdDraft && typeof data === "string" && data.includes('"tag":"SaveUserDraft"')) {
          heldDrafts++
          return
        }
        upstream.send(data)
      })
      upstream.onMessage((data) => socket.send(data))
    })

    await page.goto(`${server().url}/chats/${workshop.id}`)
    await page.getByLabel("Message", { exact: true }).fill("Look at Mara.")
    await page.getByRole("button", { name: /^Send( as .+)?$/ }).click()
    const panel = page.locator('[data-approval-scoped="library.cards"]')
    await expect(panel).toBeVisible({ timeout: 60_000 })
    await panel.getByRole("button", { name: "Add a note", exact: true }).click()
    const box = panel.getByRole("textbox", { name: "Note for the assistant" })
    const note = "Please use the attached card instead.\nAsk me if you need anything else."
    await box.fill(note)
    await expect.poll(() => heldDrafts).toBeGreaterThan(0)
    // The first save never reached the server. Let the reloaded page replay the local draft.
    holdDraft = false
    await page.reload()
    await expect(box).toHaveValue(note)

    await panel.getByRole("button", { name: "Decline", exact: true }).click()
    await expect(page.getByRole("article").filter({ hasText: "Mara keeps the lighthouse." })).toHaveCount(1, {
      timeout: 30_000
    })
    const result = provider.toolResults().at(-1)
    expect(result).toContain("Please use the attached card instead.")
    expect(result).toContain("Ask me if you need anything else.")
  })

  for (const width of [1340, 390, 1920])
    for (const theme of ["dark", "light"] as const)
      test(`asks, holds always for the card, and is removed at ${width} ${theme}`, async ({ page }, info) => {
        test.setTimeout(180_000)
        // Each run starts with nothing allowed always.
        await admin((api) =>
          Effect.gen(function* () {
            const grants = yield* api.ListLibraryGrants({})
            for (const card of grants.cards)
              for (const capability of card.classes)
                yield* api.RemoveLibraryGrant({ capability, entityId: card.entityId })
            for (const capability of grants.always) yield* api.RemoveLibraryGrant({ capability })
          })
        )
        const workshop = await admin((api) => api.CreateWorkshop({ title: `Sight ${width} ${theme}` }))
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
        await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
        await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
        const shot = async (name: string) => {
          if (shots) {
            mkdirSync(shots, { recursive: true })
            await page.waitForTimeout(200)
            await page.screenshot({ path: resolve(shots, `library-sight-${name}-${width}-${theme}.png`) })
          }
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        }

        await page.goto(`${server().url}/chats/${workshop.id}`)
        await expect(page.getByTestId("composer")).toBeVisible()
        await page.getByLabel("Message", { exact: true }).fill("Look at Mara.")
        await page.getByRole("button", { name: /^Send( as .+)?$/ }).click()
        const panel = page.locator('[data-approval-scoped="library.cards"]')
        await expect(panel).toBeVisible({ timeout: 60_000 })
        await expect(panel).toContainText("Let the assistant look through your cards?")
        await expect(panel).toContainText("It wants to open the card “Mara Quill”.")
        for (const label of [
          "Allow",
          "Allow in this chat",
          "Allow always for Assistant",
          "Allow always",
          "Decline",
          "Add a note"
        ])
          await expect(panel.getByRole("button", { name: label, exact: true })).toBeVisible()
        await panel.scrollIntoViewIfNeeded()
        await shot("asked")
        await expectLayout(page, info, `library-sight-asked-${width}-${theme}`, { scope: "[data-approval-scoped]" })
        await panel.getByRole("button", { name: "Allow always for Assistant", exact: true }).click()
        await expect(page.getByText("Mara keeps the lighthouse.").last()).toBeVisible({ timeout: 60_000 })

        // The chip's row says where the standing comes from.
        await nextReply(page)
          .getByRole("button", { name: /^What the assistant may do: / })
          .click()
        const popover = page.getByRole("dialog", { name: "What the assistant may do" })
        const row = popover.locator('[data-capability="library.cards"]')
        await expect(row.locator("[data-capability-standing]")).toHaveText("Allowed always for Assistant.")
        await expect(row.getByRole("button", { name: "Allowed", exact: true })).toHaveAttribute("aria-pressed", "true")
        await row.scrollIntoViewIfNeeded()
        await shot("chip")
        await expectLayout(page, info, `library-sight-chip-${width}-${theme}`, { scope: '[role="dialog"]' })
        await page.keyboard.press("Escape")

        // Settings → Assistant tools lists it, with Remove.
        await page.goto(`${server().url}/settings/assistant-tools`)
        const section = page.locator("[data-library-grants]")
        await expect(section).toContainText("For Assistant")
        await expect(section.locator('[data-library-grant="library.cards"]')).toContainText("Look through your cards")
        await shot("settings")
        await expectLayout(page, info, `library-sight-settings-${width}-${theme}`, { scope: "[data-library-grants]" })

        // The card's Extra tab shows it too; Remove there takes it back everywhere.
        const grants = await admin((api) => api.ListLibraryGrants({}))
        await page.goto(`${server().url}/library/${grants.cards[0]!.refId}`)
        await page.getByRole("tab", { name: "Extra", exact: true }).click()
        const own = page.locator("[data-card-library-grants]")
        await expect(own).toContainText("Allowed for this assistant")
        await own.scrollIntoViewIfNeeded()
        await shot("card-extra")
        await expectLayout(page, info, `library-sight-card-extra-${width}-${theme}`, {
          scope: "[data-card-library-grants]"
        })
        await own.getByRole("button", { name: "Remove", exact: true }).click()
        await expect(own).toHaveCount(0)
        await page.goto(`${server().url}/settings/assistant-tools`)
        await expect(page.locator("[data-library-grants-empty]")).toHaveText(
          "Nothing is allowed always. Each workshop asks first."
        )
        await shot("settings-empty")
      })
})

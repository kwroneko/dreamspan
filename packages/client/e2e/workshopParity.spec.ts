// The assistant's notes tools in the browser (job wsb3): a shared note made after an approval that
// says what it will make, then put in the bin by a second call; the bin change's Undo, from the
// Changes tab, takes it back out, and Open is offered again only then. Synthetic data and a
// scripted loopback provider only.
import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
import { openPanel } from "./support/panel.ts"
import { asUser, type Client } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { nextReply } from "./support/strip.ts"
import { startWorkshopProvider, WORKSHOP_ANSWER } from "./support/workshopProvider.ts"

const shots = process.env.SCREENSHOT_DIR
const TITLE = "House rules"

test.describe("workshop notes tools", () => {
  const server = serverPerFile(withAdmin)
  let provider: Awaited<ReturnType<typeof startWorkshopProvider>>
  const admin = <A>(use: (client: Client) => Effect.Effect<A, unknown>) =>
    asUser(server(), ADMIN.handle, ADMIN.password, use)
  test.beforeAll(async () => {
    provider = await startWorkshopProvider({
      perTask: true,
      calls: [
        { name: "create_shared_note", arguments: { title: TITLE, content: "No smoking indoors." } },
        { name: "delete_note", arguments: { note: TITLE } }
      ]
    })
    await admin((api) =>
      Effect.gen(function* () {
        yield* api.SetDisplayPrefs({ prefs: { steps: "expanded" } })
        const connection = yield* api.CreateConnection({
          kind: "openai-chat",
          settings: {
            name: "Synthetic workshop",
            baseUrl: provider.baseUrl,
            compat: {},
            cacheTtlS: null,
            maxConcurrent: null,
            presetOverrideRefId: null,
            // Each scripted step calls its tool directly, including the one that waits for approval.
            providerSettings: { toolLoading: "every" as const }
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

  for (const width of [1440, 390])
    for (const theme of ["light", "dark"] as const)
      test(`a note is made after an approval, binned and taken back out at ${width} ${theme}`, async ({
        page
      }, info) => {
        test.setTimeout(180_000)
        // One test's notes are gone before the next makes its own under the same name.
        await admin((api) =>
          Effect.gen(function* () {
            for (const note of yield* api.ListSharedNotes({})) yield* api.DeleteNote({ noteRefId: note.ref.id })
          })
        )
        const workshop = await admin((api) => api.CreateWorkshop({ title: `Notes ${width} ${theme}` }))
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
        await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
        await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
        const shot = async (name: string) => {
          if (shots) {
            mkdirSync(shots, { recursive: true })
            await page.waitForTimeout(200)
            await page.screenshot({ path: resolve(shots, `workshop-parity-${name}-${width}-${theme}.png`) })
          }
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        }
        const effects = () => admin((api) => api.ListRolloutEffects({ chatId: workshop.id }))
        const notes = () => admin((api) => api.ListSharedNotes({}))

        await page.goto(`${server().url}/chats/${workshop.id}`)
        await expect(page.getByTestId("composer")).toBeVisible()
        const chip = nextReply(page).getByRole("button", { name: /^What the assistant may do: / })
        await chip.click()
        const row = page
          .getByRole("dialog", { name: "What the assistant may do" })
          .locator('[data-capability="library.write"]')
        await row.getByRole("button", { name: "Ask first", exact: true }).click()
        await expect(row.getByRole("button", { name: "Ask first", exact: true })).toHaveAttribute(
          "aria-pressed",
          "true"
        )
        await page.keyboard.press("Escape")

        // The note waits for an answer, saying what it will make; nothing is made yet.
        await page.getByLabel("Message", { exact: true }).fill("Keep a note of the house rules.")
        await page.getByRole("button", { name: /^Send( as .+)?$/ }).click()
        const reply = page.getByRole("article").last()
        const asked = reply.locator("[data-approval]")
        await expect(asked).toBeVisible({ timeout: 30_000 })
        await expect(asked).toContainText(TITLE)
        await expect(asked).toContainText("Asks first: Create and edit library items")
        expect(await notes()).toHaveLength(0)
        await shot("asking")
        await expectLayout(page, info, `workshop-parity-asking-${width}-${theme}`, { scope: "article:last-of-type" })
        await asked.getByRole("button", { name: "Allow", exact: true }).click()
        await expect.poll(async () => (await notes()).length, { timeout: 30_000 }).toBe(1)

        // Moving it to the bin asks too.
        const again = page.getByRole("article").last().locator("[data-approval]")
        await expect(again).toBeVisible({ timeout: 30_000 })
        await expect(again).toContainText(TITLE)
        await again.getByRole("button", { name: "Allow", exact: true }).click()
        await expect(page.getByRole("article").filter({ hasText: WORKSHOP_ANSWER })).toHaveCount(1, {
          timeout: 30_000
        })
        expect(await notes()).toHaveLength(0)
        const made = await effects()
        expect(made.map((e) => e.kind)).toEqual(["library.delete", "library.create"])

        // Changes: the bin change has Undo and nothing to open; undone, the note is back and opens.
        const changes = await openPanel(page, "Changes")
        const rows = changes.locator("[data-effect]")
        await expect(rows).toHaveCount(2)
        const binned = changes.locator('[data-effect-kind="library.delete"]')
        await expect(binned.getByRole("link", { name: "Open", exact: true })).toHaveCount(0)
        await expect(binned).toContainText(`Moved the note ${TITLE} to the bin`)
        // The row that made it has nothing to open while it is in the bin either.
        const created = changes.locator('[data-effect-kind="library.create"]')
        await expect(created.getByRole("link", { name: "Open", exact: true })).toHaveCount(0)
        const undo = binned.getByRole("button", { name: "Undo", exact: true })
        await expect(undo).toHaveAccessibleDescription("Takes it back out of the bin.")
        await shot("changes")
        await expectLayout(page, info, `workshop-parity-changes-${width}-${theme}`, {
          scope: width === 390 ? '[role="dialog"]' : 'aside[aria-label="Chat panel"]'
        })
        await undo.click()
        await expect(binned).toContainText("Undone")
        await expect(binned.getByRole("link", { name: "Open", exact: true })).toBeVisible()
        await expect(created.getByRole("link", { name: "Open", exact: true })).toBeVisible()
        const back = await notes()
        expect(back.map((n) => n.title)).toEqual([TITLE])
        await shot("undone")
        await expectLayout(page, info, `workshop-parity-undone-${width}-${theme}`, {
          scope: width === 390 ? '[role="dialog"]' : 'aside[aria-label="Chat panel"]'
        })
      })
})

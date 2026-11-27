// Workshop library edits and reverts update an open card editor in a side-by-side pane live,
// without needing a page reload. Synthetic data and a scripted loopback provider only.
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { asUser, type Client } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { startWorkshopProvider, WORKSHOP_ANSWER } from "./support/workshopProvider.ts"

const CARD_NAME = "Harbor Lantern"
const ORIGINAL_DESCRIPTION = "Original harbor description."
const UPDATED_DESCRIPTION = "Updated harbor description with glowing pier."
const ADDED_EXAMPLE = "<START>\n{{char}}: The lantern swings in the fog."

test.describe("workshop live editor sync", () => {
  const server = serverPerFile(withAdmin)
  let provider: Awaited<ReturnType<typeof startWorkshopProvider>>
  const admin = <A>(use: (client: Client) => Effect.Effect<A, unknown>) =>
    asUser(server(), ADMIN.handle, ADMIN.password, use)

  test.beforeAll(async () => {
    provider = await startWorkshopProvider({
      perTask: true,
      calls: [
        {
          name: "edit_card",
          arguments: {
            card: CARD_NAME,
            changes: [
              { field: "description", text: UPDATED_DESCRIPTION },
              { field: "mes_example", text: ADDED_EXAMPLE }
            ]
          }
        }
      ]
    })
    await admin((api) =>
      Effect.gen(function* () {
        const connection = yield* api.CreateConnection({
          kind: "openai-chat",
          settings: {
            providerSettings: { toolLoading: "every" },
            name: "Synthetic workshop sync",
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

  test("side-by-side card editor reflects workshop edit_card and Revert live without reloading", async ({ page }) => {
    test.setTimeout(120_000)
    const card = await admin((api) =>
      api.CreateCard({ label: CARD_NAME, name: CARD_NAME, description: ORIGINAL_DESCRIPTION })
    )

    await page.setViewportSize({ width: 1440, height: 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)

    // Start a workshop attached to the card, split right, and open the card editor beside it.
    await page.goto(`${server().url}/library`)
    await page.getByRole("button", { name: `More actions for ${CARD_NAME}`, exact: true }).click()
    await page.getByRole("menuitem", { name: "Work on in a workshop" }).click()
    await page
      .getByRole("menu", { name: "Work on in a workshop" })
      .getByRole("menuitem", { name: "A new workshop" })
      .click()
    await expect(page.getByTestId("composer")).toBeVisible({ timeout: 15_000 })
    await page.getByRole("button", { name: "Split right" }).click()

    const panes = page.locator("[data-frame]")
    await expect(panes).toHaveCount(2)
    const leftPane = panes.nth(0)
    const rightPane = panes.nth(1)

    await page.getByRole("link", { name: "Library", exact: true }).click()
    await rightPane.locator(`a[href="/library/${card.id}"]`).first().click()

    const descriptionBox = rightPane.getByRole("textbox", { name: "Description" })
    const examplesBox = rightPane.getByRole("textbox", { name: "Example messages" })
    await expect(rightPane.getByRole("heading", { name: CARD_NAME })).toBeVisible({ timeout: 15_000 })
    await expect(descriptionBox).toContainText(ORIGINAL_DESCRIPTION)

    // Ask the workshop assistant to edit the card while the editor stays open beside it.
    await leftPane.getByLabel("Message", { exact: true }).fill("Edit Harbor Lantern now.")
    await leftPane.getByRole("button", { name: /^Send( as .+)?$/ }).click()
    await expect(leftPane.getByRole("article").filter({ hasText: WORKSHOP_ANSWER })).toHaveCount(1, {
      timeout: 30_000
    })

    // Without reloading, the open card editor on the right shows both edited fields.
    await expect(descriptionBox).toContainText(UPDATED_DESCRIPTION, { timeout: 15_000 })
    await expect(examplesBox).toContainText("The lantern swings in the fog.", { timeout: 15_000 })

    // Reverting the change from the workshop chat updates the open card editor live too.
    await leftPane.locator("[data-change-action]").getByText("Revert", { exact: true }).click()
    await expect(leftPane.locator("[data-change-state]").getByText("Reverted", { exact: true })).toBeVisible({
      timeout: 15_000
    })
    await expect(descriptionBox).toContainText(ORIGINAL_DESCRIPTION, { timeout: 15_000 })
    await expect(descriptionBox).not.toContainText(UPDATED_DESCRIPTION)
    await expect(examplesBox).not.toContainText("The lantern swings in the fog.")
  })
})

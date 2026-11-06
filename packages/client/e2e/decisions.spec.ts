// Decision models' settings (spec/AGENTIC.md §7): a decision connection's Decisions card, where
// nothing can be turned on until its model is chosen, a point's switch and confidence, kept
// across a reload; an ordinary connection has no such card; a decision connection's models
// aren't offered for replies. Screenshots of the card at 1440 and 390, light and dark.
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
import { openEntry, openSettings } from "./support/lorebook.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const shots = process.env["DECISIONS_SHOTS"]

const setup = () =>
  asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const existing = (yield* api.ListConnections()).find((c) => c.name === "Jev")
      if (existing) return existing.id
      const connection = yield* api.CreateConnection({
        kind: "system-one",
        settings: {
          name: "Jev",
          baseUrl: "http://127.0.0.1:9/decide",
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        }
      })
      yield* api.AddUserModel({ connectionId: connection.id, key: "typesafe/jev-1.13", overrides: {} })
      yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: "Chat",
          baseUrl: "http://127.0.0.1:9/v1",
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        }
      })
      return connection.id
    })
  )

test("a decision connection's points stay off until its model is chosen, and keep their settings", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const id = await setup()
  await page.goto(`${server().url}/settings/connections/${id}`)
  await expect(page.getByRole("heading", { name: "Decisions" })).toBeVisible()
  const lore = page.getByRole("switch", { name: "Lorebook entries" })
  const presence = page.getByRole("switch", { name: "Who is in the scene" })
  await expect(lore).toBeDisabled()
  await expect(presence).toBeDisabled()
  await expect(page.getByText("Choose the decision model to turn decisions on.")).toBeVisible()

  await page.getByRole("button", { name: "Decision model", exact: true }).click()
  await page.getByRole("radio", { name: /typesafe\/jev-1.13$/ }).click()
  await expect(lore).toBeEnabled()
  await expect(lore).not.toBeChecked()
  await lore.click()
  await expect(lore).toBeChecked()
  await expect(page.getByRole("slider", { name: "Confidence needed" })).toBeVisible()
  await expect(page.getByText("70%", { exact: true })).toBeVisible()

  await page.reload()
  await expect(page.getByRole("switch", { name: "Lorebook entries" })).toBeChecked()
  await expect(page.getByRole("switch", { name: "Who is in the scene" })).not.toBeChecked()

  // An ordinary connection has no Decisions card.
  await page.goto(`${server().url}/settings/connections`)
  await page.getByRole("link", { name: "Chat", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Chat", level: 1 })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Decisions" })).toHaveCount(0)
})

for (const width of [1440, 390])
  for (const colorScheme of ["light", "dark"] as const)
    test(`the Decisions card at ${width} ${colorScheme}`, async ({ page }) => {
      test.skip(!shots, "screenshots only when DECISIONS_SHOTS names a folder")
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
      await page.emulateMedia({ colorScheme })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const id = await setup()
      await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        Effect.gen(function* () {
          const [model] = yield* api.ListModels({ connectionId: id, includeHidden: false })
          yield* api.SetDecisionSettings({
            connectionId: id,
            model: model!.id,
            points: { lore: { on: true, threshold: 0.7 } }
          })
        })
      )
      await page.goto(`${server().url}/settings/connections/${id}`)
      const heading = page.getByRole("heading", { name: "Decisions" })
      await expect(page.getByRole("switch", { name: "Lorebook entries" })).toBeChecked()
      await heading.evaluate((element) => element.scrollIntoView({ block: "start" }))
      await page.screenshot({ path: `${shots}/decisions-${width}-${colorScheme}.png`, animations: "disabled" })
      await expectLayout(page, test.info(), `decisions-${width}-${colorScheme}`)
    })

// A synthetic book; nothing here comes from a real one.
const book = (name: string) => ({
  name,
  entries: { 0: { uid: 0, key: ["airship"], comment: "Airship", content: "The airship hums overhead.", order: 10 } }
})

for (const width of [1440, 390])
  test(`a lorebook entry's question for the decision model at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const response = await page.request.post(`${server().url}/library/import?name=Skyway ${width}.json`, {
      headers: { "content-type": "application/octet-stream", origin: server().url },
      data: Buffer.from(JSON.stringify(book(`Skyway ${width}`)))
    })
    expect(response.status()).toBe(200)
    const { library } = await response.json()
    await page.goto(`${server().url}/library/${library.ref.id}`)
    const entry = page.getByRole("group", { name: "Lorebook entry 0", exact: true })
    await openEntry(page, "Airship")
    await openSettings(entry)
    const question = entry.getByRole("textbox", { name: "Question for the decision model" })
    await question.scrollIntoViewIfNeeded()
    await question.fill("The airship is near the characters.")
    await question.blur()
    await page.reload()
    await openEntry(page, "Airship")
    await openSettings(entry)
    await expect(entry.getByRole("textbox", { name: "Question for the decision model" })).toHaveValue(
      "The airship is near the characters."
    )
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme })
      await entry.getByRole("textbox", { name: "Question for the decision model" }).scrollIntoViewIfNeeded()
      if (shots) await page.screenshot({ path: `${shots}/lorebook-question-${width}-${colorScheme}.png` })
      await expectLayout(page, test.info(), `lorebook-question-${width}-${colorScheme}`)
    }
  })

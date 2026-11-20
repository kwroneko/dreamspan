// A fresh install to a working chat (uiaudit §2): the home's steps, a new connection whose test
// lists its models for the user to choose the default from, and the note a composer shows without a model.
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { chooseCustomServer, type FakeProvider, startProvider, chooseDefaultModelIfNone } from "./support/provider.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
test.describe.configure({ mode: "serial" })
let provider: FakeProvider
test.beforeAll(async () => {
  provider = await startProvider()
})
test.afterAll(async () => {
  await provider.stop()
})
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
const clearDefaultModel = () =>
  admin((api) =>
    Effect.gen(function* () {
      const now = yield* api.GetGenerationDefaults()
      yield* api.SetGenerationDefaults({
        defaults: { model: null, preset: now.preset, judge: now.judge ?? null, lcm: now.lcm ?? {} }
      })
    })
  )

test("the empty home leads to a connection, and the user chooses its default model", async ({ page }) => {
  test.setTimeout(180_000)
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(server().url)
  const steps = page.getByRole("region", { name: "Get started" })
  await expect(steps).toContainText("0 of 3 done")
  await expect(page.getByText("No characters here")).toHaveCount(0)
  // With nothing to filter, the filters and search stay out of the way of the steps.
  await expect(page.getByRole("searchbox", { name: "Search characters and groups" })).toHaveCount(0)
  await expect(page.getByRole("group", { name: "Show", exact: true })).toHaveCount(0)
  await steps.getByRole("link", { name: "Connect a model" }).click()
  await expect(page).toHaveURL(/\/settings\/connections\/new$/)

  await chooseCustomServer(page)
  await page.getByLabel("Name", { exact: true }).fill("First run")
  await page.getByLabel("Base URL", { exact: true }).fill(provider.baseUrl)
  // The kind takes no key: left empty, none is sent.
  // With no default model yet, the form asks for one; nothing is chosen for the user.
  await page.getByRole("button", { name: "Create connection" }).click()
  await expect(page.getByText("Choose the model new chats use.")).toBeVisible()
  expect((await admin((api) => api.ListConnections())).length).toBe(0)
  // Test lists the models to choose from.
  await page.getByRole("button", { name: "Test", exact: true }).click()
  await expect(page.getByText("2 models listed")).toBeVisible()
  await page.getByRole("combobox", { name: "Default model for new chats", exact: true }).click()
  await page.getByRole("option", { name: "fake-small" }).click()
  await page.getByRole("button", { name: "Create connection" }).click()
  await expect(page.getByText("Found 2 models.")).toBeVisible()
  const using = page.getByRole("status").filter({ hasText: "for new chats" })
  await expect(using).toContainText("Using Fake Small for new chats")
  const defaults = await admin((api) => api.GetGenerationDefaults())
  expect(defaults.model).not.toBeNull()
  // Each model's id shows only where it differs from its name.
  const models = page.getByRole("list", { name: "Models" })
  await expect(models.getByText("fake-large", { exact: true })).toBeVisible()

  await using.getByRole("link", { name: "Change" }).click()
  await expect(page).toHaveURL(/\/settings\/chats$/)
  await expect(page.getByRole("heading", { name: "Replies" })).toBeVisible()

  await page.goto(server().url)
  await expect(steps).toContainText("1 of 3 done")
  await expect(steps).toContainText("Using Fake Small for new chats")
  await expect(steps.getByRole("link", { name: "Import" })).toBeVisible()

  // A second connection leaves the chosen default alone. Its name, left empty, is the server's.
  const before = await admin((api) => api.GetGenerationDefaults())
  await page.goto(`${server().url}/settings/connections/new`)
  await chooseCustomServer(page)
  await page.getByLabel("Base URL", { exact: true }).fill(provider.baseUrl)
  const host = new URL(provider.baseUrl).host
  await expect(page.getByLabel("Name", { exact: true })).toHaveAttribute("placeholder", host)
  await chooseDefaultModelIfNone(page)
  await page.getByRole("button", { name: "Create connection" }).click()
  await expect(page.getByRole("heading", { name: host, exact: true })).toBeVisible()
  await expect(page.getByText("Found 2 models.")).toBeVisible()
  await expect(page.getByRole("status").filter({ hasText: "for new chats" })).toHaveCount(0)
  expect((await admin((api) => api.GetGenerationDefaults())).model).toEqual(before.model)
})

test("a composer with no model says so and offers the choice", async ({ page }) => {
  test.setTimeout(180_000)
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const ref = await admin((api) => api.CreateCard({ label: "First run fixture", name: "Lamp keeper" }))
  await clearDefaultModel()
  // With no model and no chats yet, the home asks for a model again.
  await page.goto(server().url)
  await expect(
    page.getByRole("region", { name: "Get started" }).getByRole("link", { name: "Choose a model" })
  ).toBeVisible()

  // A chat not started yet.
  await page.goto(`${server().url}/cards/${ref.entityId}/chat`)
  await expect(page.getByText("No model chosen")).toBeVisible()
  // In a row of its own above the composer, never squeezing the speaker or the message box.
  const note = await page.getByRole("status").filter({ hasText: "No model chosen" }).boundingBox()
  const box = await page.getByTestId("composer").boundingBox()
  expect(note!.y + note!.height).toBeLessThanOrEqual(box!.y)
  expect(note!.width).toBeGreaterThan(box!.width / 2)
  await page.getByRole("button", { name: "Choose a model for all chats" }).click()
  await page.getByRole("radiogroup", { name: "Model", exact: true }).getByRole("radio").first().click()
  await expect(page.getByText("No model chosen")).toHaveCount(0)
  expect((await admin((api) => api.GetGenerationDefaults())).model).not.toBeNull()

  // An open chat: the note sits above its composer until a model is chosen.
  const started = await admin((api) =>
    api.StartChat({
      cards: [ref.entityId],
      persona: null,
      greeting: null,
      first: { _tag: "Send", content: "A synthetic opening.", speakerEntityId: null }
    })
  )
  await clearDefaultModel()
  await page.goto(`${server().url}/chats/${started.chat.id}`)
  await expect(page.getByText("No model chosen")).toBeVisible()
  await page.getByRole("button", { name: "Choose a model for all chats" }).click()
  await page.getByRole("radiogroup", { name: "Model", exact: true }).getByRole("radio").first().click()
  await expect(page.getByText("No model chosen")).toHaveCount(0)

  // Every step done: the home shows only the characters.
  await page.goto(server().url)
  await expect(page.getByRole("heading", { name: "Characters", level: 1 })).toBeVisible()
  await expect(page.getByRole("region", { name: "Get started" })).toHaveCount(0)
})

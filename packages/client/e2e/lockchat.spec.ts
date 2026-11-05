import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { startProvider, type FakeProvider } from "./support/provider.ts"
import { type Client, loginCookie, withCookie } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { modelChip, presetChip } from "./support/strip.ts"

const server = serverPerFile(withAdmin)
let provider: FakeProvider
let cookie: string
const rpc = <A>(run: (api: Client) => Effect.Effect<A, unknown>) => withCookie(server(), cookie, run)
test.beforeAll(async () => {
  provider = await startProvider()
  cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
})
test.afterAll(async () => {
  await provider?.stop()
})

for (const width of [390, 1440])
  test(`preset and model locks keep only this chat's selection (${width}px)`, async ({ page, context }) => {
    const data = await rpc((api) =>
      Effect.gen(function* () {
        const connection = yield* api.CreateConnection({
          kind: "openai-chat",
          settings: {
            name: `Locks ${width}`,
            baseUrl: provider.baseUrl,
            compat: {},
            cacheTtlS: null,
            maxConcurrent: null,
            presetOverrideRefId: null
          },
          apiKey: "synthetic-key"
        })
        yield* api.RefreshModels({ connectionId: connection.id })
        const models = yield* api.ListModels({ connectionId: connection.id, includeHidden: false })
        const a = yield* api.CreatePreset({ label: `Lock A ${width}` })
        const b = yield* api.CreatePreset({ label: `Lock B ${width}` })
        yield* api.ChangeGenerationDefaults({
          change: { preset: a.id, model: { connection: connection.id, model: models[0]!.id } }
        })
        const card = yield* api.CreateCard({ label: `Lock card ${width}`, name: "Lock card" })
        const start = () =>
          api.StartChat({
            cards: [card.entityId],
            persona: null,
            greeting: null,
            first: { _tag: "Send", content: "Synthetic lock test", speakerEntityId: null }
          })
        const one = yield* start()
        const two = yield* start()
        return { one, two, a, b, models, connection }
      })
    )
    await page.setViewportSize({ width, height: 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const other = await context.newPage()
    await other.setViewportSize({ width, height: 900 })
    await page.goto(`${server().url}/chats/${data.one.chat.id}`)
    await other.goto(`${server().url}/chats/${data.two.chat.id}`)
    for (const kind of ["preset", "model"] as const) {
      const chip = kind === "preset" ? presetChip : modelChip
      const title = kind === "preset" ? "Prompt preset" : "Model"
      const name = (index: number) =>
        kind === "preset" ? (index === 0 ? data.a.label : data.b.label) : data.models[index]!.key
      const choose = async (tab: Page, index: number) => {
        await chip(tab).click()
        await tab
          .getByRole("radiogroup", { name: title, exact: true })
          .getByRole("radio", {
            name: kind === "preset" ? name(index) : `Locks ${width} · ${name(index)}`,
            exact: true
          })
          .click()
      }
      await chip(page).click()
      const lockLabel = page.getByText("Lock for this chat", { exact: true })
      const scopeDescription = page.getByText(/^Picking a (preset|model) here changes it for/)
      await expect(scopeDescription).toHaveCount(0)
      await expect(lockLabel).toHaveCSS("font-size", "14px")
      await expect(page.getByRole("switch", { name: "Lock for this chat" })).toHaveAccessibleDescription(
        `This chat keeps this ${kind} when you change it elsewhere.`
      )
      await page.keyboard.press("Escape")
      await choose(page, 1)
      await expect(chip(other)).toContainText(name(1))
      await chip(page).click()
      await page.getByRole("switch", { name: "Lock for this chat" }).click()
      await expect(scopeDescription).toHaveCount(0)
      await page.keyboard.press("Escape")
      await expect(
        chip(page).getByRole("img", { name: `${kind === "preset" ? "Preset" : "Model"} locked for this chat` })
      ).toBeVisible()
      await choose(page, 0)
      await expect(chip(page)).toContainText(name(0))
      await expect(chip(other)).toContainText(name(1))
      const defaults = await rpc((api) => api.GetGenerationDefaults())
      expect(kind === "preset" ? defaults.preset : defaults.model?.model).toBe(
        kind === "preset" ? data.b.id : data.models[1]!.id
      )
      // The next request uses the locked selection, rather than merely drawing its name.
      const next = await rpc((api) =>
        api.GetNextContext({ chatId: data.one.chat.id, leafSlotId: data.one.entry.slotId })
      )
      if (kind === "model") expect(next.model?.model).toBe(data.models[0]!.id)
      else expect(next.budget?.presetName).toBe(data.a.label)
      await page.reload()
      await expect(chip(page)).toContainText(name(0))
      await chip(page).click()
      await expect(page.getByRole("switch", { name: "Lock for this chat" })).toBeChecked()
      await page.getByRole("switch", { name: "Lock for this chat" }).click()
      await expect(scopeDescription).toHaveCount(0)
      await page.keyboard.press("Escape")
      await expect(chip(page)).toContainText(name(1))
      await expect(chip(page).getByRole("img")).toHaveCount(0)
      await choose(other, 0)
      await expect(chip(page)).toContainText(name(0))
    }
    // An empty preset binding pins the built-in preset as well.
    await presetChip(page).click()
    await page
      .getByRole("radiogroup", { name: "Prompt preset", exact: true })
      .getByRole("radio", { name: "Default (built-in)", exact: true })
      .click()
    await presetChip(page).click()
    await page.getByRole("switch", { name: "Lock for this chat" }).click()
    await expect(page.getByText(/^Picking a preset here changes it for/)).toHaveCount(0)
    await page.keyboard.press("Escape")
    await presetChip(other).click()
    await other
      .getByRole("radiogroup", { name: "Prompt preset", exact: true })
      .getByRole("radio", { name: data.b.label, exact: true })
      .click()
    await expect(presetChip(page)).toContainText("Default (built-in)")
    const next = await rpc((api) => api.GetNextContext({ chatId: data.one.chat.id, leafSlotId: data.one.entry.slotId }))
    expect(next.budget?.presetName).toBe("Default (built-in)")
    await other.close()
  })

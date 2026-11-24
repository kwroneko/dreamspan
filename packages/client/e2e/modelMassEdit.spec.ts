// Edit N… on a connection's model list (modelmassedit1): the model settings form for the
// selected models shown, a tick per field; only the ticked fields are saved, on exactly those
// models, in one change, with Undo. Copy settings from a model fills and ticks what that model
// sets. At 1440 and 390 px in both themes, with the layout audit. The provider is a fake one
// listing 300 synthetic models.
import { mkdirSync } from "node:fs"
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
import { type FakeProvider, startProvider } from "./support/provider.ts"
import { asUser, type Client } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
let provider: FakeProvider
const SHOTS = "/tmp/dreamspan-shots/modelmassedit"

const FAMILIES = [
  ["gemini", "Synth Gemini"],
  ["claude", "Synth Claude"],
  ["llama", "Synth Llama"]
] as const
const MODELS = FAMILIES.flatMap(([id, name]) =>
  Array.from({ length: 100 }, (_, i) => ({
    id: `synthetic/${id}-${String(i).padStart(3, "0")}`,
    name: `${name} ${i}`,
    context_length: 32768 * (1 + (i % 4))
  }))
)

test.beforeAll(async () => {
  provider = await startProvider({ models: MODELS })
  mkdirSync(SHOTS, { recursive: true })
})
test.afterAll(async () => {
  await provider.stop()
})

const admin = <A>(use: (client: Client) => Effect.Effect<A, unknown>) =>
  asUser(server(), ADMIN.handle, ADMIN.password, use)

/**
 * A connection with the 300 models fetched; gemini 0–9 have their own temperature and Top P,
 * claude 0–4 their own temperature, and a source model to copy from.
 */
const connectionWithModels = () =>
  admin((api) =>
    Effect.gen(function* () {
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: `Mass edit ${Math.random().toString(36).slice(2, 8)}`,
          baseUrl: provider.baseUrl,
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        }
      })
      yield* api.RefreshModels({ connectionId: connection.id })
      const models = yield* api.ListModels({ connectionId: connection.id, includeHidden: true })
      const byKey = new Map(models.map((model) => [model.key, model]))
      for (let i = 0; i < 10; i++) {
        const model = byKey.get(`synthetic/gemini-${String(i).padStart(3, "0")}`)!
        yield* api.EditModel({
          modelId: model.id,
          overrides: { settings: { samplers: { temperature: 0.2, top_p: 0.95 } } },
          expectedRowVersion: model.rowVersion
        })
      }
      for (let i = 0; i < 5; i++) {
        const model = byKey.get(`synthetic/claude-${String(i).padStart(3, "0")}`)!
        yield* api.EditModel({
          modelId: model.id,
          overrides: { settings: { samplers: { temperature: 0.3 } } },
          expectedRowVersion: model.rowVersion
        })
      }
      yield* api.AddUserModel({
        connectionId: connection.id,
        key: `copy-source-${connection.id}`,
        overrides: {
          name: "The source",
          reasoning: false,
          settings: { samplers: { temperature: 0.4 }, stop: ["END"] }
        }
      })
      return connection.id
    })
  )

const listed = (connectionId: string) =>
  admin((api) => api.ListModels({ connectionId: connectionId as never, includeHidden: true })).then(
    (models) => new Map(models.map((model) => [model.key, model]))
  )

const open = async (page: Page, connectionId: string) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/settings/connections/${connectionId}`)
  await expect(page.getByRole("table", { name: "Models" })).toBeVisible()
}

const filter = (page: Page) => page.getByRole("searchbox", { name: "Filter models", exact: true })
const headerTick = (page: Page) => page.getByRole("checkbox", { name: "Select all shown", exact: true })
const count = (page: Page) => page.locator("[data-selection-count]")
const tick = (page: Page, label: string) => page.getByRole("checkbox", { name: `Change ${label}`, exact: true })

test("edits only the ticked fields on exactly the selected models shown, with Undo", async ({ page }) => {
  test.setTimeout(120_000)
  const id = await connectionWithModels()
  const before = await listed(id)
  await open(page, id)
  // Gemini and llama selected; only gemini shown, so only gemini is edited.
  await filter(page).fill("llama")
  await headerTick(page).click()
  await filter(page).fill("gemini")
  await headerTick(page).click()
  await expect(count(page)).toHaveText("200 selected (100 not shown)")
  const edit = page.getByRole("button", { name: "Edit 100…", exact: true })
  await edit.hover()
  await expect(page.locator('[data-layout-overlay="Tooltip floats above the page"]')).toContainText(
    "Changes settings of the selected models shown here, all at once."
  )
  await edit.click()

  const dialog = page.getByRole("dialog", { name: "Edit 100 models", exact: true })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeDisabled()
  // The models differ in Temperature: the mark after its label says so, and how.
  const marker = dialog.locator('[data-mass-field="temperature"] [data-mixed]')
  await expect(marker).toHaveText("Differs")
  await marker.hover()
  await expect(page.locator('[data-layout-overlay="Tooltip floats above the page"]')).toContainText(
    "The selected models don't all have the same value: not set on 90, 0.2 on 10."
  )
  // Editing two fields ticks both; unticking one leaves it as each model has it.
  await dialog.getByRole("textbox", { name: "Temperature", exact: true }).fill("0.55")
  await expect(tick(page, "Temperature")).toBeChecked()
  await dialog.getByRole("textbox", { name: "Top P", exact: true }).fill("0.8")
  await expect(tick(page, "Top P")).toBeChecked()
  await expect(tick(page, "Reasoning")).not.toBeChecked()
  await tick(page, "Top P").click()
  await expect(tick(page, "Top P")).not.toBeChecked()
  // The typed value stays in the field, unticked.
  await expect(dialog.getByRole("textbox", { name: "Top P", exact: true })).toHaveValue("0.8")
  await dialog.getByRole("button", { name: "Save", exact: true }).click()
  await expect(page.getByText("100 models changed")).toBeVisible()
  await expect(dialog).toBeHidden()

  const after = await listed(id)
  for (const [key, model] of after)
    if (key.startsWith("synthetic/gemini-")) expect(model.overrides.settings?.samplers?.temperature).toBe(0.55)
  const gemini0 = after.get("synthetic/gemini-000")!
  expect(gemini0.overrides.settings?.samplers?.top_p).toBe(0.95)
  expect(after.get("synthetic/gemini-050")!.overrides.settings?.samplers?.top_p).toBeUndefined()
  // Not shown, or not selected: untouched.
  for (const key of [...before.keys()].filter((key) => !key.startsWith("synthetic/gemini-")))
    expect(after.get(key)!.overrides).toEqual(before.get(key)!.overrides)

  // Undo puts back exactly what was there.
  await page.getByRole("button", { name: "Undo", exact: true }).click()
  await expect
    .poll(async () => (await listed(id)).get("synthetic/gemini-050")!.overrides.settings?.samplers?.temperature)
    .toBeUndefined()
  const undone = await listed(id)
  for (const key of before.keys()) expect(undone.get(key)!.overrides).toEqual(before.get(key)!.overrides)
})

test("copy settings from a model fills and ticks its fields; an unticked one isn't saved", async ({ page }) => {
  test.setTimeout(120_000)
  const id = await connectionWithModels()
  const before = await listed(id)
  await open(page, id)
  await filter(page).fill("claude-0")
  await headerTick(page).click()
  await expect(count(page)).toHaveText("100 selected")
  await page.getByRole("button", { name: "Edit 100…", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Edit 100 models", exact: true })

  await dialog.getByRole("button", { name: "Copy settings from another model", exact: true }).click()
  await page.getByRole("searchbox", { name: "Find a model", exact: true }).fill(`copy-source-${id}`)
  await page.getByRole("radio", { name: new RegExp(`copy-source-${id}`) }).click()
  await expect(dialog.getByRole("textbox", { name: "Temperature", exact: true })).toHaveValue("0.4")
  await expect(dialog.getByRole("textbox", { name: "Stop string 1", exact: true })).toHaveValue("END")
  for (const label of ["Temperature", "Reasoning", "Stop strings"]) await expect(tick(page, label)).toBeChecked()
  // What the source doesn't set stays unticked.
  await expect(tick(page, "Top P")).not.toBeChecked()
  await tick(page, "Stop strings").click()
  await dialog.getByRole("button", { name: "Save", exact: true }).click()
  await expect(page.getByText("100 models changed")).toBeVisible()

  const after = await listed(id)
  for (const [key, model] of after) {
    if (!key.startsWith("synthetic/claude-")) {
      expect(model.overrides).toEqual(before.get(key)!.overrides)
      continue
    }
    expect(model.overrides.settings?.samplers?.temperature).toBe(0.4)
    expect(model.overrides.reasoning).toBe(false)
    expect(model.overrides.settings?.stop).toBeUndefined()
    // The source's display name isn't a setting copied.
    expect(model.overrides.name).toBeUndefined()
  }
})

// Review of 15a906b99 (3): two tabs on one bulk edit, one a step behind. An untick in one and a
// tick in the other both stand, and Save uses both.
test("an untick in one tab and a tick in another, a step behind, both stand", async ({ page }) => {
  test.setTimeout(120_000)
  const id = await connectionWithModels()
  const before = await listed(id)
  const other = await page.context().newPage()
  // The other tab's draft saves wait until released: it types on the start it saw.
  let hold = false
  const held: Array<() => void> = []
  await other.routeWebSocket(/\/rpc$/, (socket) => {
    const upstream = socket.connectToServer()
    socket.onMessage((data) => {
      const request = typeof data === "string" ? (JSON.parse(data) as { tag?: string }) : null
      if (hold && request?.tag === "SaveUserDraft") held.push(() => upstream.send(data))
      else upstream.send(data)
    })
    upstream.onMessage((data) => socket.send(data))
  })
  // This tab's draft saves, as the server answers them.
  const asked = new Set<string>()
  let answered = 0
  await page.routeWebSocket(/\/rpc$/, (socket) => {
    const upstream = socket.connectToServer()
    socket.onMessage((data) => {
      const request = typeof data === "string" ? (JSON.parse(data) as { tag?: string; id?: string }) : null
      if (request?.tag === "SaveUserDraft" && request.id) asked.add(request.id)
      upstream.send(data)
    })
    upstream.onMessage((data) => {
      const reply = typeof data === "string" ? (JSON.parse(data) as { _tag?: string; requestId?: string }) : null
      if (reply?._tag === "Exit" && reply.requestId && asked.has(reply.requestId)) answered++
      socket.send(data)
    })
  })
  const dialogs = []
  for (const tab of [page, other]) {
    await open(tab, id)
    await filter(tab).fill("claude-0")
    await headerTick(tab).click()
    await tab.getByRole("button", { name: "Edit 100…", exact: true }).click()
    dialogs.push(tab.getByRole("dialog", { name: "Edit 100 models", exact: true }))
  }
  const [mine, theirs] = dialogs as [ReturnType<Page["getByRole"]>, ReturnType<Page["getByRole"]>]
  // The start both tabs share: Temperature and Top P ticked.
  await mine.getByRole("textbox", { name: "Temperature", exact: true }).fill("0.55")
  await mine.getByRole("textbox", { name: "Top P", exact: true }).fill("0.8")
  await expect(tick(other, "Top P")).toBeChecked()
  await expect(theirs.getByRole("textbox", { name: "Top P", exact: true })).toHaveValue("0.8")
  hold = true
  // The other tab ticks Reasoning, its save held; this one unticks Temperature, saved.
  await tick(other, "Reasoning").click()
  await expect.poll(() => held.length).toBeGreaterThan(0)
  const answeredBefore = answered
  await tick(page, "Temperature").click()
  await expect(tick(page, "Temperature")).not.toBeChecked()
  await expect.poll(() => answered).toBeGreaterThan(answeredBefore)
  hold = false
  for (const send of held.splice(0)) send()
  // Both stand, in both tabs.
  for (const tab of [page, other]) {
    await expect(tick(tab, "Reasoning")).toBeChecked()
    await expect(tick(tab, "Temperature")).not.toBeChecked()
    await expect(tick(tab, "Top P")).toBeChecked()
  }
  await mine.getByRole("button", { name: "Save", exact: true }).click()
  await expect(page.getByText("100 models changed")).toBeVisible()
  const after = await listed(id)
  for (const [key, model] of after) {
    if (!key.startsWith("synthetic/claude-0")) continue
    expect(model.overrides.settings?.samplers?.top_p).toBe(0.8)
    expect(model.overrides.settings?.samplers?.temperature).toBe(
      before.get(key)!.overrides.settings?.samplers?.temperature
    )
  }
  await other.close()
})

for (const [width, height] of [
  [1440, 900],
  [390, 844]
] as const)
  for (const theme of ["light", "dark"] as const)
    test(`the mass edit's layout: ${width} ${theme}`, async ({ page }, info) => {
      test.setTimeout(120_000)
      const id = await connectionWithModels()
      await page.setViewportSize({ width, height })
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      await open(page, id)
      await filter(page).fill("gemini")
      await headerTick(page).click()
      const bar = page.getByRole("toolbar", { name: "Selected models" })
      // Every action of the bar is on screen.
      for (const name of ["Edit 100…", "Hide 100", "Show 0", "Invert selection", "Clear selection"]) {
        const box = (await bar.getByRole("button", { name, exact: true }).boundingBox())!
        expect(box.x).toBeGreaterThanOrEqual(0)
        expect(box.x + box.width).toBeLessThanOrEqual(width)
      }
      await expectLayout(page, info, `model-mass-bar-${width}-${theme}`, { scope: "main" })
      await page.screenshot({ path: `${SHOTS}/table-${width}-${theme}.png` })
      await page.getByRole("button", { name: "Edit 100…", exact: true }).click()
      const dialog = page.getByRole("dialog", { name: "Edit 100 models", exact: true })
      await dialog.getByRole("textbox", { name: "Temperature", exact: true }).fill("0.7")
      await expect(tick(page, "Temperature")).toBeChecked()
      // Each tick is on its label's line, slider rows included; the mark sits right after the label.
      for (const field of ["openai_max_context", "temperature", "top_p", "reasoning", "vision"]) {
        const row = dialog.locator(`[data-mass-field="${field}"]`)
        const box = (await row.getByRole("checkbox").first().boundingBox())!
        const label = (await row.locator("[data-mass-body] label").first().boundingBox())!
        expect(Math.abs(box.y + box.height / 2 - (label.y + label.height / 2))).toBeLessThanOrEqual(2)
      }
      const label = (await dialog.locator('[data-mass-field="top_p"] [data-mass-body] label').first().boundingBox())!
      const mark = (await dialog.locator('[data-mass-field="top_p"] [data-mixed]').boundingBox())!
      expect(mark.x).toBeGreaterThan(label.x + label.width)
      expect(mark.x).toBeLessThan(label.x + label.width + 40)
      expect(Math.abs(mark.y + mark.height / 2 - (label.y + label.height / 2))).toBeLessThanOrEqual(2)
      if (width === 1440) {
        // Two columns, level at the top: the right one's first heading has no divider and gap over it.
        const columns = dialog.locator("[data-model-columns] > *")
        const left = (await columns.nth(0).boundingBox())!
        const right = (await columns.nth(1).boundingBox())!
        expect(right.x).toBeGreaterThan(left.x + left.width)
        const heading = (await dialog.getByText("Samplers", { exact: true }).boundingBox())!
        expect(Math.abs(heading.y - left.y)).toBeLessThanOrEqual(4)
      }
      await expectLayout(page, info, `model-mass-edit-${width}-${theme}`, { scope: "[role=dialog]" })
      await page.screenshot({ path: `${SHOTS}/dialog-${width}-${theme}.png` })
      await dialog.getByText("Advanced", { exact: true }).click()
      await expectLayout(page, info, `model-mass-edit-advanced-${width}-${theme}`, { scope: "[role=dialog]" })
      await dialog.locator('[data-mass-field="cacheRetention"]').scrollIntoViewIfNeeded()
      await page.screenshot({ path: `${SHOTS}/dialog-advanced-${width}-${theme}.png` })
    })

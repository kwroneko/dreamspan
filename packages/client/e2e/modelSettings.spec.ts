// The model settings page (modelsettings1, owner 2026-11-23): Context and Reply length are
// sliders with a number to type, bounded by the model's limits, each with its pencil; reasoning
// is assumed on and its effort sits at the top; verbosity shows only for a model that takes it;
// nothing is raw JSON; and what's set survives Save and a reload. At 1440 and 390 px, with the
// layout audit.
import { expect, test, type Locator, type Page } from "@playwright/test"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
import { type FakeProvider, startProvider } from "./support/provider.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
let provider: FakeProvider
let connectionId = ""

test.beforeAll(async () => {
  provider = await startProvider()
  connectionId = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: "Local server",
          baseUrl: provider.baseUrl,
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        }
      })
      yield* api.RefreshModels({ connectionId: connection.id })
      for (const width of [1440, 390]) {
        yield* api.AddUserModel({ connectionId: connection.id, key: `unknown-${width}`, overrides: {} })
        yield* api.AddUserModel({ connectionId: connection.id, key: `gpt-5-synthetic-${width}`, overrides: {} })
        yield* api.AddUserModel({
          connectionId: connection.id,
          key: `copy-source-${width}`,
          overrides: {
            name: "The source",
            context: 300_000,
            maxOutput: 64_000,
            reasoning: false,
            sampling: { top_n_sigma: 2 },
            settings: {
              samplers: { openai_max_context: 300_000, openai_max_tokens: 50_000, temperature: 0.4 },
              stop: ["END"]
            }
          }
        })
        yield* api.AddUserModel({
          connectionId: connection.id,
          key: `copy-target-${width}`,
          overrides: { name: "The target", maxOutput: 8000, settings: { samplers: { temperature: 1.2 } } }
        })
      }
      return connection.id
    })
  )
})
test.afterAll(async () => {
  await provider.stop()
})

const saved = (key: string) =>
  asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.ListModels({ connectionId: connectionId as never, includeHidden: true })
  ).then((models) => models.find((model) => model.key === key)!)

const top = async (locator: Locator) => (await locator.boundingBox())!.y
const TOOLTIP = '[data-layout-overlay="Tooltip floats above the page"]'

const open = async (page: Page, key: string) => {
  await page.getByRole("button", { name: `Edit ${key}`, exact: true }).click()
  const dialog = page.getByRole("dialog", { name: `Edit ${key}`, exact: true })
  await expect(dialog.getByRole("textbox", { name: "Display name", exact: true })).toBeVisible()
  return dialog
}

for (const [width, height] of [
  [1440, 900],
  [390, 844]
] as const)
  test(`model settings at ${width}: sliders, limits, reasoning, verbosity, save and reload`, async ({ page }, info) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width, height })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/settings/connections/${connectionId}`)
    const key = `unknown-${width}`
    let dialog = await open(page, key)

    // Reasoning nobody reports is assumed on, and its effort is at the top, before the lengths.
    const thinking = dialog.getByRole("group", { name: "Thinking", exact: true })
    await expect(thinking.getByRole("combobox", { name: "Reasoning", exact: true })).toHaveText(/Yes \(assumed\)/)
    const effort = thinking.getByRole("combobox", { name: "Reasoning effort", exact: true })
    await expect(effort).toBeEnabled()
    const length = dialog.getByRole("group", { name: "Length", exact: true })
    const samplers = dialog.getByRole("group", { name: "Samplers", exact: true })
    expect(await top(effort)).toBeLessThan(await top(length))
    // One column on a phone; on a wide screen the samplers have a column of their own.
    if (width === 390) expect(await top(length)).toBeLessThan(await top(samplers))
    else expect(await top(samplers)).toBeLessThan(await top(length))
    // Verbosity is for models that take it: not this one.
    await expect(dialog.getByRole("group", { name: "Verbosity" })).toHaveCount(0)
    // No raw JSON anywhere.
    await expect(dialog.getByRole("textbox", { name: /JSON/ })).toHaveCount(0)
    await expectLayout(page, info, `model-settings-${width}`, { scope: "[role=dialog]" })

    // Context: a slider bounded by the window, a number beside it; at the end, all of the window.
    const context = length.getByRole("textbox", { name: "Context", exact: true })
    const contextSlider = length.getByRole("slider", { name: "Context slider" })
    await expect(context).toHaveValue("")
    await expect(length.locator('[data-limit="context"]')).toContainText("Max 128,000 (assumed)")
    await contextSlider.focus()
    await page.keyboard.press("Home")
    await expect(context).toHaveValue("1024")
    // A log step: a hundredth of the track, to a readable value.
    await page.keyboard.press("ArrowRight")
    await expect(context).toHaveValue("1100")
    await page.keyboard.press("End")
    await expect(context).toHaveValue("")
    // Exact entry.
    await context.fill("50000")
    await expect(contextSlider).toHaveAttribute("aria-valuetext", "50,000")

    // The window's own limit, in the same control.
    await length.getByRole("button", { name: "Set the context window yourself", exact: true }).click()
    const window = length.getByRole("textbox", { name: "Your context window (tokens)", exact: true })
    await expect(window).toBeFocused()
    await window.fill("60000")
    await expect(length.locator('[data-limit="context"]')).toContainText("Max 60,000")

    // Reply length: below its default by one (log) step.
    const reply = length.getByRole("textbox", { name: "Reply length", exact: true })
    await expect(reply).toHaveAttribute("placeholder", "4,096")
    await length.getByRole("slider", { name: "Reply length slider" }).focus()
    await page.keyboard.press("ArrowLeft")
    await expect(reply).toHaveValue("3900")

    // A sampler: slid, then typed.
    const temperature = samplers.getByRole("textbox", { name: "Temperature", exact: true })
    await samplers.getByRole("slider", { name: "Temperature slider" }).focus()
    await page.keyboard.press("ArrowRight")
    await expect(temperature).toHaveValue("1.01")
    await temperature.fill("0.7")

    // Advanced: collapsed, with the parameters as rows.
    await dialog.getByText("Advanced", { exact: true }).click()
    await dialog.getByRole("button", { name: "Add a parameter", exact: true }).click()
    await dialog.getByRole("textbox", { name: "Parameter name 1", exact: true }).fill("top_n_sigma")
    await dialog.getByRole("textbox", { name: "Parameter value 1", exact: true }).fill("1.5")
    await expect(dialog.locator('[data-rows="sampling"]')).toContainText("number")
    await expectLayout(page, info, `model-settings-advanced-${width}`, { scope: "[role=dialog]" })

    await dialog.getByRole("button", { name: "Save model settings", exact: true }).click()
    await expect(dialog).toBeHidden()
    const stored = await saved(key)
    expect(stored.overrides.context).toBe(60000)
    expect(stored.overrides.settings?.samplers).toMatchObject({
      openai_max_context: 50000,
      openai_max_tokens: 3900,
      temperature: 0.7
    })
    expect(stored.overrides.sampling).toEqual({ top_n_sigma: 1.5 })
    expect(stored.overrides.reasoning).toBeUndefined()

    // A reload shows what was saved.
    await page.reload()
    dialog = await open(page, key)
    await expect(dialog.getByRole("textbox", { name: "Context", exact: true })).toHaveValue("50000")
    await expect(dialog.getByRole("textbox", { name: "Your context window (tokens)", exact: true })).toHaveValue(
      "60000"
    )
    await expect(dialog.getByRole("textbox", { name: "Reply length", exact: true })).toHaveValue("3900")
    await expect(dialog.getByRole("textbox", { name: "Temperature", exact: true })).toHaveValue("0.7")
    // Advanced was open, and the URL keeps it open.
    await expect(dialog.getByRole("textbox", { name: "Parameter value 1", exact: true })).toHaveValue("1.5")
    await page.keyboard.press("Escape")
    await expect(dialog).toBeHidden()

    // A model that takes verbosity shows it, apart from the effort.
    const gpt = `gpt-5-synthetic-${width}`
    dialog = await open(page, gpt)
    const verbosity = dialog.getByRole("group", { name: "Verbosity", exact: true })
    await expect(verbosity).toBeVisible()
    await verbosity.getByRole("button", { name: "High", exact: true }).click()
    await dialog.getByRole("button", { name: "Save model settings", exact: true }).click()
    await expect(dialog).toBeHidden()
    expect((await saved(gpt)).overrides.settings?.samplers?.verbosity).toBe("high")
  })

// Context and Reply length run on a log scale (logslider1, owner 2026-11-24): a quarter of the
// track is far below a tenth of the maximum, keys move by log steps, a typed value sits at its
// log place, and nothing in the layout moves.
test("context and reply length sliders are logarithmic, at 1340 dark", async ({ page }, info) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1340, height: 900 })
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/settings/connections/${connectionId}`)
  const dialog = await open(page, "copy-source-1440")
  const length = dialog.getByRole("group", { name: "Length", exact: true })
  const context = length.getByRole("textbox", { name: "Context", exact: true })
  const slider = length.getByRole("slider", { name: "Context slider" })
  const shot = (name: string) => length.screenshot({ path: info.outputPath(`${name}.png`) })
  await expect(context).toHaveValue("300000")
  const before = await length.boundingBox()
  await shot("1-context-300000")

  // A drag to a quarter of the track: a log value, far under a tenth of the 300,000 maximum.
  const track = (await slider.locator("xpath=../..").boundingBox())!
  const y = track.y + track.height / 2
  await page.mouse.move(track.x + track.width * 0.9, y)
  await page.mouse.down()
  await page.mouse.move(track.x + track.width * 0.25, y, { steps: 8 })
  await page.mouse.up()
  const quarter = Number(await context.inputValue())
  expect(quarter).toBeGreaterThan(1024)
  expect(quarter).toBeLessThan(30_000 / 3)
  await shot("2-context-quarter")

  // Keys: Home and End are the ends; arrows a log step; Page Up a bigger one.
  await slider.focus()
  await page.keyboard.press("Home")
  await expect(context).toHaveValue("1024")
  await page.keyboard.press("ArrowRight")
  const one = Number(await context.inputValue())
  expect(one).toBeGreaterThan(1024)
  expect(one).toBeLessThan(1200)
  await page.keyboard.press("PageUp")
  const big = Number(await context.inputValue())
  expect(big / one).toBeGreaterThan(1.5)
  expect(big / one).toBeLessThan(2.5)
  await page.keyboard.press("ArrowLeft")
  expect(Number(await context.inputValue())).toBeLessThan(big)
  await shot("3-context-low")
  await page.keyboard.press("End")
  await expect(context).toHaveValue("")

  // A typed value stays exact, its thumb at its log place: 17,527 is halfway from 1,024 to 300,000.
  await context.fill("17527")
  await expect(slider).toHaveAttribute("aria-valuetext", "17,527")
  const thumb = (await slider.locator("xpath=..").boundingBox())!
  // The thumb's centre runs from half a thumb in to half a thumb before the end.
  const halfway = track.x + track.width / 2
  expect(Math.abs(thumb.x + thumb.width / 2 - halfway)).toBeLessThan(4)
  await shot("4-context-17527")

  // Reply length too: Home is 64, a quarter of the way in keys is a few hundred.
  const reply = length.getByRole("textbox", { name: "Reply length", exact: true })
  await length.getByRole("slider", { name: "Reply length slider" }).focus()
  await page.keyboard.press("Home")
  await expect(reply).toHaveValue("64")
  for (let i = 0; i < 25; i += 1) await page.keyboard.press("ArrowRight")
  expect(Number(await reply.inputValue())).toBeLessThan(1000)
  await shot("5-reply-quarter")

  // Nothing moved.
  expect(await length.boundingBox()).toEqual(before)
  await expectLayout(page, info, "model-settings-log-1340", { scope: "[role=dialog]" })
})

test("on a large screen the dialog is wide, in columns, and needs no scrolling", async ({ page }, info) => {
  await page.setViewportSize({ width: 2560, height: 1440 })
  await page.emulateMedia({ reducedMotion: "reduce" })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/settings/connections/${connectionId}`)
  const dialog = await open(page, "unknown-1440")
  const box = (await dialog.boundingBox())!
  expect(box.width).toBeGreaterThan(1200)
  expect(box.width).toBeLessThanOrEqual(1500)
  const fits = await dialog.evaluate((element) => element.scrollHeight <= element.clientHeight)
  expect(fits).toBe(true)
  // Three columns: the main settings, the samplers, and what it can do with Advanced.
  const left = async (name: string) => (await dialog.getByRole("group", { name, exact: true }).boundingBox())!.x
  const [thinking, samplers, capabilities] = await Promise.all(["Thinking", "Samplers", "What it can do"].map(left))
  expect(samplers).toBeGreaterThan(thinking! + 300)
  expect(capabilities).toBeGreaterThan(samplers! + 300)
  expect(await top(dialog.getByRole("group", { name: "Samplers", exact: true }))).toBeLessThan(
    await top(dialog.getByRole("group", { name: "Length", exact: true }))
  )
  await expectLayout(page, info, "model-settings-2560", { scope: "[role=dialog]" })
})

for (const [width, height] of [
  [1440, 900],
  [390, 844]
] as const)
  test(`copy settings from another model at ${width}: filled, limited, unsaved until Save`, async ({ page }, info) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width, height })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/settings/connections/${connectionId}`)
    const key = `copy-target-${width}`
    let dialog = await open(page, key)

    // The app's model picker, with its search, lists the other models but not this one.
    await dialog.getByRole("button", { name: "Copy settings from another model", exact: true }).click()
    await page.getByRole("searchbox", { name: "Find a model", exact: true }).fill("copy-")
    await expect(page.getByRole("radio", { name: new RegExp(`copy-target-${width}`) })).toHaveCount(0)
    await page.getByRole("radio", { name: new RegExp(`copy-source-${width}`) }).click()

    const length = dialog.getByRole("group", { name: "Length", exact: true })
    await expect(dialog.getByRole("textbox", { name: "Temperature", exact: true })).toHaveValue("0.4")
    await expect(dialog.getByRole("combobox", { name: "Reasoning", exact: true })).toHaveText(/^No/)
    await expect(dialog.getByRole("textbox", { name: "Stop string 1", exact: true })).toHaveValue("END")
    // Its own name and limits stay.
    await expect(dialog.getByRole("textbox", { name: "Display name", exact: true })).toHaveValue("The target")
    await expect(length.locator('[data-limit="maxOutput"]')).toContainText("Max 8,000")
    // Over this model's limits: brought down to them, and the field says why.
    await expect(length.getByRole("textbox", { name: "Context", exact: true })).toHaveValue("")
    await expect(length.getByRole("textbox", { name: "Reply length", exact: true })).toHaveValue("8000")
    await length.locator('[data-range="openai_max_tokens"]').getByText("Limited", { exact: true }).hover()
    await expect(page.locator(TOOLTIP)).toContainText("has 50,000: limited to this model’s output limit, 8,000.")
    await expect(
      length.locator('[data-range="openai_max_context"]').getByText("Limited", { exact: true })
    ).toBeVisible()
    await expectLayout(page, info, `model-settings-copied-${width}`, { scope: "[role=dialog]" })

    // Nothing is saved yet.
    expect((await saved(key)).overrides.settings?.samplers?.temperature).toBe(1.2)
    expect((await saved(key)).overrides.sampling).toBeUndefined()

    // A reload mid-review keeps the copied values, unsaved.
    await page.reload()
    // The dialog was open: the reload opens it again, with the copied values.
    dialog = page.getByRole("dialog", { name: `Edit ${key}`, exact: true })
    await expect(dialog.getByRole("textbox", { name: "Temperature", exact: true })).toHaveValue("0.4")
    await expect(dialog.getByRole("textbox", { name: "Reply length", exact: true })).toHaveValue("8000")
    await expect(
      dialog.locator('[data-range="openai_max_context"]').getByText("Limited", { exact: true })
    ).toBeVisible()
    await dialog.getByText("Advanced", { exact: true }).click()
    await expect(dialog.getByRole("textbox", { name: "Parameter value 1", exact: true })).toHaveValue("2")
    expect((await saved(key)).overrides.settings?.samplers?.temperature).toBe(1.2)

    // Save stores them; the name and limits are this model's own.
    await dialog.getByRole("button", { name: "Save model settings", exact: true }).click()
    await expect(dialog).toBeHidden()
    const stored = await saved(key)
    expect(stored.overrides).toMatchObject({ name: "The target", maxOutput: 8000, reasoning: false })
    expect(stored.overrides.context).toBeUndefined()
    expect(stored.overrides.sampling).toEqual({ top_n_sigma: 2 })
    expect(stored.overrides.settings?.stop).toEqual(["END"])
    expect(stored.overrides.settings?.samplers).toEqual({ openai_max_tokens: 8000, temperature: 0.4 })
  })

// A connection's model list as a table (modellist1): the filter and the tab in the URL, tab
// counts, ticks kept across filter and tab changes, bulk Hide and Show over the selected rows
// shown only, with Undo, the header tick's mixed state, and the layout at 1440 and 390 px. The
// provider is a fake one listing 1,500 synthetic models.
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
import { type FakeProvider, startProvider } from "./support/provider.ts"
import { asUser, type Client } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
let provider: FakeProvider

/** Six families of 250: 500 "gemini", 500 "claude", 250 each of the rest. */
const FAMILIES = [
  ["gemini-flash", "Synth Gemini Flash"],
  ["gemini-pro", "Synth Gemini Pro"],
  ["claude-sonnet", "Synth Claude Sonnet"],
  ["claude-haiku", "Synth Claude Haiku"],
  ["llama", "Synth Llama"],
  ["qwen", "Synth Qwen"]
] as const
const MODELS = FAMILIES.flatMap(([id, name]) =>
  Array.from({ length: 250 }, (_, i) => ({
    id: `synthetic/${id}-${String(i).padStart(3, "0")}`,
    name: `${name} ${i}`,
    context_length: 32768 * (1 + (i % 4)),
    ...(i % 2 === 0 ? { pricing: { prompt: "0.000001", completion: "0.000004" } } : {})
  }))
)

test.beforeAll(async () => {
  provider = await startProvider({ models: MODELS })
})
test.afterAll(async () => {
  await provider.stop()
})

const admin = <A>(use: (client: Client) => Effect.Effect<A, unknown>) =>
  asUser(server(), ADMIN.handle, ADMIN.password, use)

/** A connection with the 1,500 models fetched, `hideFamily`'s hidden. */
const connectionWithModels = (hideFamily?: string) =>
  admin((api) =>
    Effect.gen(function* () {
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: `Many models ${Math.random().toString(36).slice(2, 8)}`,
          baseUrl: provider.baseUrl,
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        }
      })
      yield* api.RefreshModels({ connectionId: connection.id })
      if (hideFamily) {
        const models = yield* api.ListModels({ connectionId: connection.id, includeHidden: true })
        yield* api.SetModelsHidden({
          modelIds: models.filter((m) => m.key.startsWith(`synthetic/${hideFamily}-`)).map((m) => m.id),
          hidden: true
        })
      }
      return connection.id
    })
  )

const hiddenKeys = (connectionId: string) =>
  admin((api) =>
    api
      .ListModels({ connectionId: connectionId as never, includeHidden: true })
      .pipe(Effect.map((models) => models.filter((m) => m.hidden).map((m) => m.key)))
  )

const open = async (page: Page, connectionId: string, search = "") => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/settings/connections/${connectionId}${search}`)
  await expect(page.getByRole("table", { name: "Models" })).toBeVisible()
}

const filter = (page: Page) => page.getByRole("searchbox", { name: "Filter models", exact: true })
const tab = (page: Page, name: string) => page.getByRole("tab", { name: new RegExp(`^${name} `) })
const headerTick = (page: Page) => page.getByRole("checkbox", { name: "Select all shown", exact: true })
const count = (page: Page) => page.locator("[data-selection-count]")
const rows = (page: Page) => page.getByRole("table", { name: "Models" }).locator("[data-model-row]")

test("the filter and the tabs count and narrow the list, case-insensitive, by name or id", async ({ page }) => {
  const id = await connectionWithModels("gemini-pro")
  await open(page, id)
  await expect(tab(page, "All")).toHaveText("All 1,500")
  await expect(tab(page, "Visible")).toHaveText("Visible 1,250")
  await expect(tab(page, "Hidden")).toHaveText("Hidden 250")
  await expect(tab(page, "All")).toHaveAttribute("aria-selected", "true")
  // Only the rows in view are mounted.
  expect(await rows(page).count()).toBeLessThan(80)

  await filter(page).fill("GEMINI")
  await expect(tab(page, "All")).toHaveText("All 500")
  await expect(tab(page, "Visible")).toHaveText("Visible 250")
  await expect(tab(page, "Hidden")).toHaveText("Hidden 250")
  // A substring of the display name only ("Flash" is in the id as "flash" too).
  await filter(page).fill("synth gemini flash 1")
  await expect(tab(page, "All")).toHaveText("All 111")
  // A substring of the id only.
  await filter(page).fill("haiku-04")
  await expect(tab(page, "All")).toHaveText("All 10")
  await expect(rows(page)).toHaveCount(10)
  await expect(rows(page).first()).toContainText("synthetic/claude-haiku-040")

  await filter(page).fill("gemini")
  await tab(page, "Hidden").click()
  await expect(rows(page).first()).toContainText("Synth Gemini Pro")
  await expect(rows(page).first()).toContainText("hidden")
  await tab(page, "Visible").click()
  await expect(rows(page).first()).toContainText("Synth Gemini Flash")

  // Nothing matches: the filter stays, with a way out.
  await filter(page).fill("no-such-model")
  await expect(page.getByText("No visible models match “no-such-model”.")).toBeVisible()
  await page.getByRole("button", { name: "Clear the filter" }).click()
  await expect(filter(page)).toHaveValue("")
  await expect(tab(page, "Visible")).toHaveText("Visible 1,250")
})

test("ticks survive filter changes; Hide applies to the selected rows shown, with Undo", async ({ page }) => {
  const id = await connectionWithModels()
  await open(page, id)
  // The owner's example: gemini, select all; claude, select all; clear the filter; hide.
  await filter(page).fill("gemini")
  await expect(tab(page, "All")).toHaveText("All 500")
  await headerTick(page).click()
  await expect(count(page)).toHaveText("500 selected")
  await filter(page).fill("claude")
  await expect(tab(page, "All")).toHaveText("All 500")
  await expect(count(page)).toHaveText("500 selected (500 not shown)")
  await expect(headerTick(page)).not.toBeChecked()
  await headerTick(page).click()
  await expect(count(page)).toHaveText("1,000 selected (500 not shown)")
  await expect(page.getByRole("button", { name: "Hide 500" })).toBeEnabled()
  await filter(page).fill("")
  await expect(count(page)).toHaveText("1,000 selected")
  // Some of the shown rows ticked: the header tick is mixed.
  await expect(headerTick(page)).toBeChecked({ indeterminate: true })
  await page.getByRole("button", { name: "Hide 1,000" }).click()
  await expect(page.getByText("1,000 models hidden")).toBeVisible()
  await expect(tab(page, "Hidden")).toHaveText("Hidden 1,000")
  await expect(count(page)).toHaveText("None selected")
  const hidden = await hiddenKeys(id)
  expect(hidden).toHaveLength(1000)
  expect(hidden.every((key) => /gemini|claude/.test(key))).toBe(true)

  await page.getByRole("button", { name: "Undo", exact: true }).click()
  await expect(tab(page, "Hidden")).toHaveText("Hidden 0")
  expect(await hiddenKeys(id)).toHaveLength(0)
})

test("Hide and Show require at most 10,000 selected models in view", async ({ page }) => {
  test.setTimeout(120_000)
  const large = await startProvider({
    models: [
      ...Array.from({ length: 10_000 }, (_, i) => ({ id: `bulk-model-${i}`, context_length: 32_768 })),
      { id: "other-model", context_length: 32_768 }
    ]
  })
  try {
    const connectionId = await admin((api) =>
      Effect.gen(function* () {
        const connection = yield* api.CreateConnection({
          kind: "openai-chat",
          settings: {
            name: "Bulk request limit",
            baseUrl: large.baseUrl,
            compat: {},
            cacheTtlS: null,
            maxConcurrent: null,
            presetOverrideRefId: null
          }
        })
        yield* api.RefreshModels({ connectionId: connection.id })
        return connection.id
      })
    )
    await open(page, connectionId)
    await expect(tab(page, "Visible")).toHaveText("Visible 10,001")
    await headerTick(page).click()
    const limit = "Select at most 10,000 models shown here."
    const hide = (n: string) => page.getByRole("button", { name: `Hide ${n}`, exact: true })
    await expect(hide("10,001")).toBeDisabled()
    await expect(hide("10,001")).toHaveAccessibleDescription(limit)
    await filter(page).fill("bulk-model-")
    await expect(hide("10,000")).toBeEnabled()
    await hide("10,000").click()
    await expect(tab(page, "Visible")).toHaveText("Visible 0")
    await filter(page).fill("")
    // Hide the last selected model too, then try the same selection in the other direction.
    await hide("1").click()
    await expect(tab(page, "Hidden")).toHaveText("Hidden 10,001")
    await headerTick(page).click()
    const show = (n: string) => page.getByRole("button", { name: `Show ${n}`, exact: true })
    await expect(show("10,001")).toBeDisabled()
    await expect(show("10,001")).toHaveAccessibleDescription(limit)
    await filter(page).fill("bulk-model-")
    await expect(show("10,000")).toBeEnabled()
  } finally {
    await large.stop()
  }
})

test("selected rows filtered out or on another tab are never acted on", async ({ page }) => {
  const id = await connectionWithModels("llama")
  await open(page, id)
  await filter(page).fill("gemini")
  await headerTick(page).click()
  await filter(page).fill("claude")
  await headerTick(page).click()
  // Now only one family shows: its 250 are acted on, the other 750 stay ticked.
  await filter(page).fill("gemini-flash")
  await expect(count(page)).toHaveText("1,000 selected (750 not shown)")
  await expect(headerTick(page)).toBeChecked()
  await page.getByRole("button", { name: "Hide 250" }).click()
  await expect(page.getByText("250 models hidden")).toBeVisible()
  await expect(count(page)).toHaveText("750 selected (750 not shown)")
  const hidden = await hiddenKeys(id)
  expect(hidden.filter((key) => key.includes("gemini-flash"))).toHaveLength(250)
  expect(hidden.filter((key) => key.includes("gemini-pro") || key.includes("claude"))).toHaveLength(0)

  // On Hidden, Show counts only hidden rows shown there; tick a few llama rows and show them.
  await filter(page).fill("llama-00")
  await tab(page, "Hidden").click()
  await expect(rows(page)).toHaveCount(10)
  await page.getByRole("checkbox", { name: "Select synthetic/llama-000", exact: true }).click()
  await page.getByRole("checkbox", { name: "Select synthetic/llama-001", exact: true }).click()
  await expect(headerTick(page)).toBeChecked({ indeterminate: true })
  await expect(page.getByRole("button", { name: "Hide 0" })).toBeDisabled()
  await page.getByRole("button", { name: "Show 2" }).click()
  await expect(page.getByText("2 models shown")).toBeVisible()
  await expect(rows(page)).toHaveCount(8)
  expect((await hiddenKeys(id)).filter((key) => key.startsWith("synthetic/llama-"))).toHaveLength(248)

  // Invert ticks the shown rows that weren't; Clear selection empties it, shown or not.
  await page.getByRole("button", { name: "Invert selection" }).click()
  await expect(headerTick(page)).toBeChecked()
  await expect(count(page)).toHaveText("758 selected (750 not shown)")
  await page.getByRole("button", { name: "Clear selection" }).click()
  await expect(count(page)).toHaveText("None selected")
})

test("the filter and the tab come back after a reload", async ({ page }) => {
  const id = await connectionWithModels("claude-haiku")
  await open(page, id)
  await filter(page).pressSequentially("haiku-1")
  await tab(page, "Hidden").click()
  await expect(tab(page, "Hidden")).toHaveAttribute("aria-selected", "true")
  await expect(page).toHaveURL(/q=haiku-1/)
  await expect(page).toHaveURL(/models=hidden/)
  await page.reload()
  await expect(filter(page)).toHaveValue("haiku-1")
  await expect(tab(page, "Hidden")).toHaveAttribute("aria-selected", "true")
  await expect(tab(page, "Hidden")).toHaveText("Hidden 100")
  await expect(rows(page).first()).toContainText("synthetic/claude-haiku-1")
})

for (const [width, height] of [
  [1440, 900],
  [390, 844]
] as const)
  for (const theme of ["light", "dark"] as const)
    test(`the model table's layout: ${width} ${theme}`, async ({ page }, info) => {
      const id = await connectionWithModels("qwen")
      await page.setViewportSize({ width, height })
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      await open(page, id)
      const table = page.getByRole("table", { name: "Models" })
      await table.scrollIntoViewIfNeeded()
      const bar = page.getByRole("toolbar", { name: "Selected models" })
      const before = { bar: await bar.boundingBox(), table: await table.boundingBox() }
      await page.getByRole("checkbox", { name: "Select synthetic/claude-haiku-000", exact: true }).click()
      await expect(count(page)).toHaveText("1 selected")
      // Ticking moves nothing: the bar keeps its place and height, and so does the table.
      expect(await bar.boundingBox()).toEqual(before.bar)
      expect(await table.boundingBox()).toEqual(before.table)
      // The tick, the name and both actions are on screen on every row.
      const row = rows(page).first()
      for (const part of [
        row.getByRole("checkbox"),
        row.getByText("Synth Claude Haiku 0", { exact: true }),
        row.getByRole("button", { name: "Edit synthetic/claude-haiku-000" }),
        row.getByRole("button", { name: "Hide synthetic/claude-haiku-000" })
      ]) {
        const box = (await part.boundingBox())!
        expect(box.x).toBeGreaterThanOrEqual(0)
        expect(box.x + box.width).toBeLessThanOrEqual(width)
      }
      await expect(row).toContainText("Context 32.8k")
      // The row's hide explains itself on hover.
      await row.getByRole("button", { name: "Hide synthetic/claude-haiku-000" }).hover()
      await expect(page.getByText("Leaves it out of the lists where you choose a model.")).toBeVisible()
      await page.mouse.move(0, 0)
      await expectLayout(page, info, `model-table-${width}-${theme}`, { scope: "main" })
      await table.screenshot({ path: info.outputPath(`model-table-${width}-${theme}.png`) })
      await filter(page).fill("qwen")
      await tab(page, "Hidden").click()
      await expect(tab(page, "Hidden")).toHaveText("Hidden 250")
      await expectLayout(page, info, `model-table-hidden-${width}-${theme}`, { scope: "main" })
      // Edit opens the model's settings.
      await page.getByRole("button", { name: "Edit synthetic/qwen-000", exact: true }).click()
      await expect(page.getByRole("dialog")).toBeVisible()
      await expect(page).toHaveURL(/model=/)
    })

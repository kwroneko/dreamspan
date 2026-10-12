// The editors under load (ARCHITECTURE.md §14): a card with a 50 KB description and a
// preset with 100 prompts, typed into, toggled and reordered in the built client against
// the real server. Input must stay quick, and no frame long.
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { loadavg, tmpdir } from "node:os"
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { textField } from "@rp/shared/editing.ts"
import { Effect } from "effect"
import { budgets } from "./budgets.ts"
import { type PerfServer, startServer, withClient } from "./support.ts"

let server: PerfServer
let dataDir: string
test.beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "rp-perf-editor-"))
  server = await startServer(dataDir)
})
test.afterAll(async () => {
  await server?.stop()
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
})

const record = (scenario: string, values: Record<string, number>) => {
  const line = JSON.stringify({ scenario, ...values, loadAverage: loadavg()[0]!.toFixed(1) })
  appendFileSync(join(test.info().project.outputDir, "perf-results.jsonl"), `${line}\n`)
  console.log(line)
}

/** Input events (Event Timing, until the next paint) and long animation frames, from page load. */
const instrument = () => {
  const w = window as unknown as { __m: { loaf: Array<number>; inputs: Array<number> } }
  w.__m = { loaf: [], inputs: [] }
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) w.__m.loaf.push(e.duration)
  }).observe({ type: "long-animation-frame", buffered: true })
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) w.__m.inputs.push(e.duration)
  }).observe({ type: "event", durationThreshold: 16 } as PerformanceObserverInit)
}

const measured = (page: Page) =>
  page.evaluate(() => {
    const m = (window as unknown as { __m: { loaf: Array<number>; inputs: Array<number> } }).__m
    const result = { loaf: [...m.loaf], inputs: [...m.inputs] }
    m.loaf.length = 0
    m.inputs.length = 0
    return result
  })

const p95 = (values: ReadonlyArray<number>) =>
  values.length === 0 ? 0 : [...values].sort((a, b) => a - b)[Math.floor(0.95 * values.length)]!

const ready = (page: Page) => expect(page.getByRole("status").filter({ hasText: "Everything is saved." })).toBeVisible()

const check = (scenario: string, openMs: number, m: { loaf: Array<number>; inputs: Array<number> }) => {
  const values = {
    openMs: Math.round(openMs),
    inputP95Ms: Math.round(p95(m.inputs)),
    inputEvents: m.inputs.length,
    longFramesOver100: m.loaf.filter((d) => d > 100).length,
    worstFrameMs: Math.round(Math.max(0, ...m.loaf))
  }
  record(scenario, values)
  expect(openMs).toBeLessThanOrEqual(budgets.editorOpenMs)
  expect(values.inputP95Ms).toBeLessThanOrEqual(budgets.inputP95Ms)
  expect(values.longFramesOver100).toBeLessThanOrEqual(budgets.longFramesOver100)
}

test("a card with a 50 KB description: typing in it, and in another field", async ({ page }) => {
  const description = "The sea keeps its own counsel, and the keeper keeps the lamp. ".repeat(820)
  const refId = await withClient(server, (api) =>
    Effect.gen(function* () {
      const card = yield* api.CreateCard({ label: "Long", name: "Long" })
      const draft = yield* api.SaveEditorDraft({
        draftId: null,
        expectedSession: null,
        refId: card.id,
        field: textField(["description"]),
        content: description,
        expectedRowVersion: null,
        baseRevisionId: card.headRevisionId
      })
      yield* api.CommitEditorDrafts({
        refId: card.id,
        expectedRowVersion: card.rowVersion,
        fields: [{ field: draft.key.field, draftId: draft.id, expectedRowVersion: draft.rowVersion }],
        message: null
      })
      return card.id
    })
  )
  expect(description.length).toBeGreaterThan(50_000)
  await page.addInitScript(instrument)
  const started = Date.now()
  await page.goto(`${server.url}/library/${refId}`)
  await ready(page)
  const openMs = Date.now() - started
  await measured(page)

  const field = page.getByRole("textbox", { name: /^Description/ })
  await field.focus()
  await page.keyboard.press("End")
  await page.keyboard.type(" Another line, typed key by key.", { delay: 40 })
  await page.getByRole("textbox", { name: /^Scenario/ }).focus()
  await page.keyboard.type("A storm.", { delay: 40 })
  await expect(page.getByRole("status").filter({ hasText: "kept as drafts" })).toBeVisible()
  check("editor-long-card", openMs, await measured(page))
})

test("a preset with 100 prompts: toggling, reordering and typing", async ({ page }) => {
  const file = JSON.parse(
    readFileSync(new URL("../../server/test/fixtures/presets/default.json", import.meta.url), "utf8")
  ) as { prompts: Array<Record<string, unknown>>; prompt_order: Array<{ order: Array<unknown> }> }
  for (let i = 0; i < 88; i++) {
    file.prompts.push({
      identifier: `rule-${i}`,
      name: `Rule ${i}`,
      role: "system",
      content: `Rule ${i}: keep the scene moving. `.repeat(20),
      system_prompt: false
    })
    file.prompt_order.at(-1)!.order.push({ identifier: `rule-${i}`, enabled: true })
  }
  const response = await fetch(`${server.url}/library/import?name=hundred.json`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: JSON.stringify(file)
  })
  const refId = ((await response.json()) as { library: { ref: { id: string } } }).library.ref.id

  await page.addInitScript(instrument)
  const started = Date.now()
  await page.goto(`${server.url}/library/${refId}`)
  await ready(page)
  const openMs = Date.now() - started
  const order = page.getByRole("list", { name: "Prompt order" })
  await expect(order.getByRole("listitem")).toHaveCount(100)
  await measured(page)

  for (let i = 0; i < 10; i++) await page.getByRole("switch", { name: `Send Rule ${i * 7}`, exact: true }).click()
  await page.getByRole("button", { name: "Move Rule 50", exact: true }).focus()
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowUp")
  await page.getByRole("button", { name: "Edit Rule 3", exact: true }).click()
  await page.getByRole("textbox", { name: /^Prompt/ }).focus()
  await page.keyboard.press("End")
  await page.keyboard.type(" And keep it short.", { delay: 40 })
  await expect(page.getByRole("status").filter({ hasText: "kept as drafts" })).toBeVisible()
  check("editor-hundred-prompts", openMs, await measured(page))
})

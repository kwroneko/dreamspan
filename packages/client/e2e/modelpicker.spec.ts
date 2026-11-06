import { test, expect } from "@playwright/test"
import { writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { modelCatalog } from "./support/modelCatalog.ts"
import { serverPerFile } from "./support/server.ts"
import { withCookie } from "./support/rpc.ts"
import { modelChip } from "./support/strip.ts"
import { expectLayout } from "./support/layoutAudit.ts"

const server = serverPerFile(
  process.env.MODELPICKER_DIST ? { CLIENT_DIST: process.env.MODELPICKER_DIST, DB_WORKERS: "source" } : {}
)
let catalog: Awaited<ReturnType<typeof modelCatalog>>
let seeded: Awaited<ReturnType<typeof seed>>
const seed = () => withCookie(server(), "", catalog.seed)
test.beforeAll(async () => {
  catalog = await modelCatalog({ decisions: !process.env.MODELPICKER_BASELINE })
  seeded = await seed()
})
test.afterAll(async () => {
  await catalog?.stop()
})

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`3050 models ${width} ${theme}`, async ({ page }, info) => {
      if (!process.env.MODELPICKER_BASELINE)
        await withCookie(server(), "", (api) =>
          api.SetDisplayPrefs({
            prefs: {
              modelSort: "name",
              modelRecent: { [`${seeded.lists[1]!.connection.id} ${seeded.lists[1]!.models[0]!.id}`]: Date.now() },
              modelPins: {
                [`${seeded.lists[0]!.connection.id} ${seeded.lists[0]!.models.find((model) => model.key.includes("2998"))!.id}`]: false
              }
            }
          })
        )
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.goto(`${server().url}/chats/${seeded.chat.id}`)
      const trigger = modelChip(page)
      await expect(trigger).toBeVisible()
      await expect(trigger).toBeEnabled()
      await page.waitForTimeout(1000)
      const cdp = await page.context().newCDPSession(page)
      await cdp.send("Performance.enable", { timeDomain: "threadTicks" })
      const metrics = async () =>
        Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]))
      const button = (await trigger.elementHandle())!
      const before = await metrics()
      await button.click()
      const list = page.getByRole("radiogroup", { name: "Model", exact: true })
      await expect(list).toBeVisible()
      await page.waitForTimeout(250)
      const after = await metrics()
      const scroll = await list.evaluate((el) => ({
        height: el.scrollHeight,
        viewport: el.clientHeight,
        rows: el.querySelectorAll('[role="radio"]').length
      }))
      const input = page.getByRole("searchbox", { name: "Find a model", exact: true })
      const field = (await input.elementHandle())!
      const typing: number[] = []
      for (const text of ["q", "w", "e", "n", "qwen/story-2998-v3.1"]) {
        const start = await metrics()
        if (text.length === 1) await field.press(text)
        else await field.fill(text)
        await page.waitForTimeout(100)
        typing.push(((await metrics()).TaskDuration! - start.TaskDuration!) * 1000)
      }
      const pasteMs = typing.pop()!
      const result = {
        width,
        theme,
        openMs: (after.TaskDuration! - before.TaskDuration!) * 1000,
        typing,
        pasteMs,
        scroll
      }
      const work = process.env.MODELPICKER_WORK ?? info.outputDir
      mkdirSync(work, { recursive: true })
      writeFileSync(
        join(work, `${process.env.MODELPICKER_BASELINE ? "before" : "after"}-${width}-${theme}.json`),
        JSON.stringify(result, null, 2)
      )
      if (process.env.MODELPICKER_BASELINE) {
        await page.screenshot({ path: join(work, `picker-before-${width}-${theme}.png`) })
        return
      }
      await expect(list.getByRole("radio", { name: /Router catalog.*2998/ })).toBeVisible()
      await input.fill("Storyteller 2998")
      await expect(list.getByRole("radio", { name: /Router catalog.*2998/ })).toBeVisible()
      await input.fill("qwen story2998 v31")
      const row = list.getByRole("radio", { name: /Router catalog.*2998/ })
      await expect(row).toBeVisible()
      await list.getByRole("button", { name: /^Pin / }).click()
      await expect(list.getByRole("button", { name: /^Unpin / })).toBeVisible()
      await row.click()
      await trigger.click()
      await expect(input).toHaveValue("")
      await expect(list.getByText("Pinned", { exact: true })).toBeVisible()
      await expect(list.getByRole("radio").first()).toHaveAccessibleName(/2998/)
      await expect(list.getByText("Recent", { exact: true })).toBeVisible()
      await expect(list.getByRole("radio", { name: /Local ten.*0000/ })).toHaveAccessibleDescription(/^used /)
      await page.getByRole("group", { name: "Sort models" }).getByRole("button", { name: "Used" }).click()
      await page.getByRole("combobox", { name: "Connection", exact: true }).selectOption(seeded.lists[1]!.connection.id)
      await expect(list.getByRole("radio")).toHaveCount(10)
      await page.getByRole("combobox", { name: "Connection", exact: true }).selectOption("")
      expect(await list.getByRole("radio").count()).toBeLessThan(25)
      await expectLayout(page, info, `picker-${width}-${theme}`, { scope: "[data-model-picker]" })
      await page.screenshot({ path: join(work, `picker-${width}-${theme}.png`) })
      if (process.env.MODELPICKER_PERF === "1") {
        expect.soft(result.openMs).toBeLessThan(100)
        expect.soft(Math.max(...typing)).toBeLessThan(50)
      }
      await list.getByRole("radio").first().focus()
      await page.keyboard.press("End")
      await expect(list.getByRole("radio").last()).toBeFocused()
      await page.keyboard.press("Home")
      await expect(list.getByRole("radio").first()).toBeFocused()
      for (const provider of catalog.providers) {
        expect(provider.listings).toBe(1)
        expect(provider.completions).toHaveLength(0)
      }
    })
    test(`account model fields ${width} ${theme}`, async ({ page }, info) => {
      if (!process.env.MODELPICKER_BASELINE) {
        const studio = seeded.lists[2]!
        const model = studio.models.find((model) => model.key.includes("0038"))!
        await withCookie(server(), "", (api) =>
          api.SetDisplayPrefs({ prefs: { modelPins: { [`${studio.connection.id} ${model.id}`]: true } } })
        )
      }
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.goto(`${server().url}/settings/chats`)
      if (process.env.MODELPICKER_BASELINE) {
        test.setTimeout(120_000)
        await expect(page.getByRole("combobox", { name: "Default model", exact: true })).toContainText("Router catalog")
        const findings = []
        const cdp = await page.context().newCDPSession(page)
        await cdp.send("Performance.enable", { timeDomain: "threadTicks" })
        for (const name of ["Default model", "Refusal judge", "Fallback summarizer"]) {
          const trigger = page.getByRole("combobox", { name, exact: true })
          await expect(trigger).toBeEnabled()
          const handle = (await trigger.elementHandle())!
          const before = await cdp.send("Performance.getMetrics")
          await handle.click()
          const list = page.getByRole("listbox")
          await expect(list).toBeVisible()
          const after = await cdp.send("Performance.getMetrics")
          const task = (result: typeof before) => result.metrics.find((metric) => metric.name === "TaskDuration")!.value
          findings.push({
            name,
            openMs: (task(after) - task(before)) * 1000,
            ...(await list.evaluate((el) => ({
              rows: el.querySelectorAll('[role="option"]').length,
              scroll: el.scrollHeight,
              viewport: el.clientHeight
            })))
          })
          await page.keyboard.press("Escape")
        }
        writeFileSync(
          join(process.env.MODELPICKER_WORK ?? info.outputDir, `fields-before-${width}-${theme}.json`),
          JSON.stringify(findings, null, 2)
        )
        return
      }
      for (const name of ["Default model", "Refusal judge", "Fallback summarizer"]) {
        await page.getByRole("button", { name, exact: true }).click()
        await expect(page.locator("[data-model-picker]").getByText("Pinned", { exact: true })).toBeVisible()
        await page
          .getByRole("combobox", { name: "Connection", exact: true })
          .selectOption(seeded.lists[2]!.connection.id)
        await page.getByRole("searchbox", { name: "Find a model", exact: true }).fill("story 0038")
        const list = page.getByRole("radiogroup", { name: "Model", exact: true })
        await expect(list.getByRole("radio")).toHaveCount(1)
        await expectLayout(page, info, `${name}-${width}-${theme}`, { scope: "[data-model-picker]" })
        await list.getByRole("radio").click()
      }
      const defaults = await withCookie(server(), "", (api) => api.GetGenerationDefaults())
      expect(defaults.model?.connection).toBe(seeded.lists[2]!.connection.id)
      expect(defaults.judge?.connection).toBe(seeded.lists[2]!.connection.id)
      expect(defaults.lcm?.fallback?.connection).toBe(seeded.lists[2]!.connection.id)
      for (const provider of catalog.providers) expect(provider.completions).toHaveLength(0)
    })
    test(`restricted decision picker ${width} ${theme}`, async ({ page }, info) => {
      test.skip(!!process.env.MODELPICKER_BASELINE)
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.goto(`${server().url}/settings/connections/${seeded.decision.id}`)
      await page.getByRole("button", { name: "Decision model", exact: true }).click()
      const list = page.getByRole("radiogroup", { name: "Model", exact: true })
      await expect(list.getByRole("radio")).toHaveCount(40)
      await expect(page.getByRole("combobox", { name: "Connection", exact: true }).locator("option")).toHaveCount(2)
      await page.getByRole("searchbox", { name: "Find a model", exact: true }).fill("qwen story0038")
      await expect(list.getByRole("radio")).toHaveCount(1)
      await expectLayout(page, info, `decision-${width}-${theme}`, { scope: "[data-model-picker]" })
      await list.getByRole("radio").click()
      for (const provider of catalog.providers) expect(provider.completions).toHaveLength(0)
    })
  }

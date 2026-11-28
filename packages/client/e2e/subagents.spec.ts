// Subagents in the browser (spec/SUBAGENTS.md SA1): a workshop reply's `agent` call starts a
// research subagent, whose collapsed row shows under the call's step while it works; it opens to
// its task and steps; Inspect opens its own run; Stop ends it alone, and the reply carries on with
// what it had. Layout audit on the row and the inspector at 1440 and 390. Synthetic data and a
// scripted loopback provider only.
import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
import { asUser, type Client } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import {
  BACKGROUND_ANSWER,
  BACKGROUND_WAITING,
  PARENT_ANSWER,
  startSubagentProvider,
  SUBAGENT_NAME,
  SUBAGENT_PROGRESS,
  SUBAGENT_REPORT,
  SUBAGENT_TASK
} from "./support/subagentProvider.ts"

const server = serverPerFile(withAdmin)
const shots = process.env.SCREENSHOT_DIR
let provider: Awaited<ReturnType<typeof startSubagentProvider>>
const admin = <A>(use: (client: Client) => Effect.Effect<A, unknown>) =>
  asUser(server(), ADMIN.handle, ADMIN.password, use)
const cardListing = [{ capability: "library.cards", mode: "allow" }] as const

test.beforeAll(async () => {
  provider = await startSubagentProvider()
  await admin((api) =>
    Effect.gen(function* () {
      yield* api.SetDisplayPrefs({ prefs: { steps: "expanded" } })
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          providerSettings: { toolLoading: "every" },
          name: "Synthetic subagents",
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
test.beforeEach(() => provider.reset())
test.afterAll(async () => {
  await provider.stop()
})

for (const width of [1440, 390])
  test(`a research subagent's row, Inspect and Stop at ${width}`, async ({ page }, info) => {
    test.setTimeout(180_000)
    const workshop = await admin((api) => api.CreateWorkshop({ title: `Subagents ${width}`, grants: cardListing }))
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const shot = async (name: string) => {
      if (shots) {
        mkdirSync(shots, { recursive: true })
        await page.waitForTimeout(200)
        await page.screenshot({ path: resolve(shots, `subagents-${name}-${width}.png`), animations: "disabled" })
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    }

    await page.goto(`${server().url}/chats/${workshop.id}`)
    await expect(page.getByTestId("composer")).toBeVisible()
    const held = provider.heldCount()
    await page.getByLabel("Message", { exact: true }).fill("Find my lighthouse keeper.")
    await page.getByRole("button", { name: /^Send( as .+)?$/ }).click()

    // The row shows under the agent call's step while the subagent works.
    const reply = page.getByRole("article").last()
    const row = reply.locator("[data-subagent]")
    await expect(row).toBeVisible({ timeout: 30_000 })
    await expect(row).toHaveAttribute("data-subagent", "research-1")
    await expect(row).toContainText("Subagent")
    await expect(row).toContainText("Look things up")
    await expect(row).toContainText(SUBAGENT_NAME)
    await expect(row).toContainText("Same model · workshop-small")
    await expect.poll(() => provider.heldCount(), { timeout: 30_000 }).toBe(held + 1)
    await expect(row).toHaveAttribute("data-subagent-status", "running")
    await expect(row.getByRole("button", { name: "Stop", exact: true })).toHaveAccessibleDescription(
      "Stops this subagent. The assistant gets what it has so far and carries on."
    )

    // Expands to its task and its own steps.
    await row.getByRole("button", { name: /Subagent/ }).click()
    await expect(row).toContainText(SUBAGENT_TASK)
    await expect(row.locator('[data-step="tool"]')).toHaveCount(1)
    await expect(row.locator('[data-step="tool"]').first()).toContainText(/library/i)
    await shot("running")
    await expectLayout(page, info, `subagents-row-${width}`, { scope: "article:last-of-type" })

    // Stop: it ends stopped, alone; the reply carries on with what it had and finishes.
    await row.getByRole("button", { name: "Stop", exact: true }).click()
    await expect(page.getByRole("article").filter({ hasText: PARENT_ANSWER })).toHaveCount(1, { timeout: 30_000 })
    expect(provider.lastResults().at(-1)).toContain("Stopped by the user")
    const done = page.getByRole("article").filter({ hasText: PARENT_ANSWER })
    const badge = done.locator("[data-steps-badge]")
    const stopped = done.locator("[data-subagent]")
    // A finished reply's steps fold (after staying open a moment, if they had opened); its header
    // badge opens them once the fold has settled.
    await expect(badge).toHaveAttribute("aria-pressed", "false")
    await expect(async () => {
      if ((await badge.getAttribute("aria-pressed")) !== "true") await badge.click()
      await expect(stopped).toBeVisible({ timeout: 1_000 })
    }).toPass({ timeout: 15_000 })
    await expect(stopped).toHaveAttribute("data-subagent-status", "stopped")
    await expect(stopped).toContainText("Stopped")
    await expect(stopped.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0)
    await shot("stopped")
    await expectLayout(page, info, `subagents-stopped-${width}`, { scope: "article:last-of-type" })

    // Inspect opens its own run: instructions, task, tools, steps and usage.
    await stopped.getByRole("link", { name: "Inspect", exact: true }).click()
    const run = page.locator("[data-subagent-run]")
    await expect(run).toBeVisible({ timeout: 30_000 })
    await expect(run).toContainText("Subagent instructions")
    await expect(run).toContainText("You are a subagent")
    await expect(run).toContainText(SUBAGENT_TASK)
    const tools = run.getByRole("region", { name: "Tools", exact: true }).first()
    await tools.locator("summary").click()
    await expect(tools.getByRole("region", { name: "list_library", exact: true })).toBeVisible()
    await expect(run.getByRole("heading", { name: "Usage" })).toBeVisible()
    await shot("inspect")
    await expectLayout(page, info, `subagents-inspect-${width}`)
  })

// SA4 (spec/SUBAGENTS.md §6.1, §8): a subagent's question shows while its row is folded, and a
// reply stopped while its subagent works carries the subagent on when resumed.
for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`a subagent asks while folded and carries on with Resume at ${width} ${theme}`, async ({ page }, info) => {
      test.setTimeout(180_000)
      const workshop = await admin((api) =>
        Effect.gen(function* () {
          // Reading a chat asks first, so the subagent's call waits for an answer.
          const story = yield* api.CreateChat({ title: `Harbour ${width} ${theme}` })
          provider.readChat(story.id)
          return yield* api.CreateWorkshop({ title: `Subagents resume ${width} ${theme}` })
        })
      )
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ reducedMotion: "reduce", colorScheme: theme })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/chats/${workshop.id}`)
      await expect(page.getByTestId("composer")).toBeVisible()
      const held = provider.heldCount()
      await page.getByLabel("Message", { exact: true }).fill("Find my lighthouse keeper again.")
      await page.getByRole("button", { name: /^Send( as .+)?$/ }).click()

      // Folded, the row still shows what the subagent asks, and it's answered there.
      const reply = page.getByRole("article").last()
      const row = reply.locator("[data-subagent]")
      await expect(row).toHaveAttribute("data-subagent-status", "waiting", { timeout: 30_000 })
      const asking = row.locator("[data-subagent-asking]")
      await expect(asking).toContainText("research-1 is waiting for you")
      await expect(asking.locator("[data-approval]")).toBeVisible()
      await expectLayout(page, info, `subagents-asking-${width}-${theme}`, { scope: "article:last-of-type" })
      await asking.getByRole("button", { name: "Allow", exact: true }).click()
      await expect.poll(() => provider.heldCount(), { timeout: 30_000 }).toBe(held + 1)

      // Stopping the reply stops the subagent; Resume carries it on where it stopped.
      await reply
        .locator("button:not([data-subagent] *)", { hasText: /^Stop$/ })
        .first()
        .click()
      await expect(reply.getByText("stopped", { exact: true })).toBeVisible({ timeout: 30_000 })
      provider.report()
      await reply.getByRole("button", { name: "Resume", exact: true }).first().click()
      const done = page.getByRole("article").filter({ hasText: PARENT_ANSWER })
      await expect(done).toHaveCount(1, { timeout: 30_000 })
      expect(provider.lastResults().at(-1)).toContain(SUBAGENT_REPORT)
      const badge = done.locator("[data-steps-badge]")
      const resumed = done.locator("[data-subagent]")
      await expect(async () => {
        if ((await badge.getAttribute("aria-pressed")) !== "true") await badge.click()
        await expect(resumed).toBeVisible({ timeout: 1_000 })
      }).toPass({ timeout: 15_000 })
      await expect(resumed).toHaveAttribute("data-subagent-status", "done")
      await expect(resumed).toContainText("Resumed where it stopped")
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await expectLayout(page, info, `subagents-resumed-${width}-${theme}`, { scope: "article:last-of-type" })
    })

// SA5 (spec/SUBAGENTS.md §3.2, §4): the workshop reply keeps its progress text, wait indicator
// and subagent trace together, then adds the final answer when the report arrives.
for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`a background subagent's wait, progress and report at ${width} ${theme}`, async ({ page }, info) => {
      test.setTimeout(180_000)
      provider.inBackground()
      const workshop = await admin((api) =>
        api.CreateWorkshop({ title: `Subagents background ${width} ${theme}`, grants: cardListing })
      )
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ reducedMotion: "reduce", colorScheme: theme })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/chats/${workshop.id}`)
      await expect(page.getByTestId("composer")).toBeVisible()
      await page.getByLabel("Message", { exact: true }).fill("Look for the keeper while we talk.")
      await page.getByRole("button", { name: /^Send( as .+)?$/ }).click()

      // The reply already shows its progress text while its subagent works.
      const first = page.getByRole("article").filter({ hasText: BACKGROUND_WAITING })
      await expect(first).toHaveCount(1, { timeout: 30_000 })
      const waiting = page.locator("[data-waiting-subagents]")
      await expect(waiting.first()).toHaveText("Waiting for 1 subagent", { timeout: 30_000 })
      const badge = first.locator("[data-steps-badge]")
      const row = first.locator("[data-subagent]")
      await expect(async () => {
        if ((await badge.getAttribute("aria-pressed")) !== "true") await badge.click()
        await expect(row).toBeVisible({ timeout: 1_000 })
      }).toPass({ timeout: 15_000 })
      await expect(row.locator("[data-subagent-background]")).toHaveText("In the background")
      await expect(row.locator("[data-subagent-progress]")).toHaveText(SUBAGENT_PROGRESS, { timeout: 30_000 })
      await expect(row).toHaveAttribute("data-subagent-status", "running")
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await expectLayout(page, info, `subagents-background-${width}-${theme}`, { scope: "main" })

      provider.release()
      await expect(first.locator("[data-workshop-text]")).toHaveText([BACKGROUND_WAITING, BACKGROUND_ANSWER], {
        timeout: 30_000
      })
      await expect(waiting).toHaveCount(0)
      // Completion can fold the finished trace. Open it to check the recorded status.
      const trace = first.locator("[data-workshop-trace]").first()
      const toggle = trace.getByRole("button", { name: /^1 step/ })
      await expect(async () => {
        if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click()
        await expect(row).toHaveAttribute("data-subagent-status", "done", { timeout: 1000 })
      }).toPass({ timeout: 15_000 })
      expect(JSON.stringify(provider.bodies.at(-1)?.messages ?? [])).toContain("finished:")
      await expectLayout(page, info, `subagents-background-done-${width}-${theme}`, { scope: "main" })
    })

// SA7 (spec/SUBAGENTS.md §2.3): a fork's row says it started from this conversation, and the row's
// hover says what its type does (SA9).
for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`a fork's row says it started from this conversation at ${width} ${theme}`, async ({ page }, info) => {
      test.setTimeout(180_000)
      provider.forked()
      const workshop = await admin((api) =>
        api.CreateWorkshop({ title: `Subagents fork ${width} ${theme}`, grants: cardListing })
      )
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ reducedMotion: "reduce", colorScheme: theme })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/chats/${workshop.id}`)
      await expect(page.getByTestId("composer")).toBeVisible()
      await page.getByLabel("Message", { exact: true }).fill("Find my lighthouse keeper with what we said.")
      await page.getByRole("button", { name: /^Send( as .+)?$/ }).click()
      const done = page.getByRole("article").filter({ hasText: PARENT_ANSWER })
      await expect(done).toHaveCount(1, { timeout: 60_000 })
      expect(provider.lastResults().at(-1)).toContain(SUBAGENT_REPORT)
      const badge = done.locator("[data-steps-badge]")
      const row = done.locator("[data-subagent]")
      await expect(async () => {
        if ((await badge.getAttribute("aria-pressed")) !== "true") await badge.click()
        await expect(row).toBeVisible({ timeout: 1_000 })
      }).toPass({ timeout: 15_000 })
      await expect(row).toHaveAttribute("data-subagent-status", "done")
      await expect(row).toContainText("Started from this conversation")
      await row.getByRole("button", { name: /Subagent/ }).hover()
      await expect(page.locator('[data-layout-overlay="Tooltip floats above the page"]')).toContainText(
        "Reads and searches without changing anything, then reports. Shows its task and steps."
      )
      await page.mouse.move(0, 0)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await expectLayout(page, info, `subagents-fork-${width}-${theme}`, { scope: "article:last-of-type" })
    })

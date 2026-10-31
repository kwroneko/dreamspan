import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { MORE, THOUGHT, startContinueProvider } from "./support/continueProvider.ts"
import { messageMenu, showActions } from "./support/message.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
let provider: Awaited<ReturnType<typeof startContinueProvider>>
test.beforeAll(async () => {
  provider = await startContinueProvider()
})
test.afterAll(async () => {
  await provider.stop()
})

const shoot = async (page: Page, state: string) => {
  if (process.env.SCREENSHOT_DIR) {
    await page.waitForTimeout(250)
    await page.screenshot({ path: join(process.env.SCREENSHOT_DIR, `${state}-${page.viewportSize()!.width}.png`) })
  }
}

const setup = (kind = "openai-chat", prefill: "assistant" | "tool_schema" = "assistant", beta = false) =>
  asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      yield* api.SetDisplayPrefs({ prefs: { reasoning: "expanded" } })
      const connection = yield* api.CreateConnection({
        kind,
        ...(kind === "deepseek" ? { apiKey: "sk-synthetic-only" } : {}),
        settings: {
          name: "Synthetic native prefill",
          baseUrl: beta ? provider.baseUrl.replace("/v1", "/beta") : provider.baseUrl,
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        }
      })
      const model = yield* api.AddUserModel({
        connectionId: connection.id,
        key: "native-prefill",
        overrides: { prefill }
      })
      const plain = yield* api.AddUserModel({
        connectionId: connection.id,
        key: "no-prefill",
        overrides: { prefill: "none", context: 1 }
      })
      yield* api.SetGenerationDefaults({
        defaults: { model: { connection: connection.id, model: model.id }, preset: null }
      })
      const chat = yield* api.CreateChat({ title: "Continue and reasoning" })
      const sent = yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: null,
        branch: false,
        content: "The road flooded."
      })
      if (sent._tag !== "Posted") return yield* Effect.die("unexpected queue")
      return { chat, connection, plain, parent: sent.entry.slotId }
    })
  )

for (const width of [1440, 390]) {
  test(`Continue preserves the stopped version, streams reasoning and shows the prefill at ${width}px`, async ({
    page
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const { chat } = await setup()
    provider.holdNextReply()
    await page.goto(`${server().url}/chats/${chat.id}`)
    await page
      .getByRole("button", { name: /^(Reply$|Generate(?! another))/ })
      .last()
      .click()
    const reply = page.getByRole("article").last()
    const reasoning = reply.getByRole("button", { name: /Reasoning/ })
    await expect(reasoning).toHaveAttribute("aria-expanded", "true")
    await expect(reply.getByRole("region", { name: "Reasoning" })).toContainText("Mira keeps")
    await expect(reply.locator(".markdown").last()).toContainText("The ledger says otherwise")
    await shoot(page, "01-reasoning-streaming")
    await showActions(reply)
    await reply.getByRole("button", { name: "Stop", exact: true }).click()
    await expect(reply.getByText("stopped", { exact: true })).toBeVisible()
    await expect(reasoning).toHaveAttribute("aria-expanded", "false")
    await shoot(page, "02-stopped")
    const original = await reply.locator(".markdown").last().innerText()
    const source = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
      api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 10 })
    )
    const originalVersion = source.entries.at(-1)!.version
    await showActions(reply)
    await reply.getByRole("button", { name: /^Continue:/ }).click()
    await expect(reply.getByText("generating", { exact: true })).toBeVisible()
    await expect(reply.locator(".markdown").last()).toContainText(original)
    await expect(reasoning).toHaveAttribute("aria-expanded", "true")
    await shoot(page, "03-continuing")
    await expect(reply.locator(".markdown").last()).toContainText("Before the watch changes")
    await expect(reply.getByText("generating", { exact: true })).toHaveCount(0)
    await expect(reasoning).toHaveAttribute("aria-expanded", "false")
    await shoot(page, "04-complete-collapsed")
    await showActions(reply)
    await reply.getByRole("button", { name: /choose a version/ }).click()
    await expect(page.getByRole("dialog", { name: "Versions of message #2", exact: true })).toContainText("stopped")
    await expect(page.getByRole("dialog", { name: "Versions of message #2", exact: true })).not.toContainText(
      "generating"
    )
    await expect(page.getByRole("dialog", { name: "Versions of message #2", exact: true })).toContainText(
      "The ledger says"
    )
    await shoot(page, "05-picker-complete")
    await page.keyboard.press("Escape")
    // Cached completion must remain correct after selecting the original too.
    await reply.getByRole("button", { name: "Previous version", exact: true }).click()
    await reply.getByRole("button", { name: /choose a version/ }).click()
    await expect(page.getByRole("dialog", { name: "Versions of message #2", exact: true })).not.toContainText(
      "generating"
    )
    await page.keyboard.press("Escape")
    await reply.getByRole("button", { name: "Next version", exact: true }).click()
    await expect(reply.getByRole("button", { name: /Version 2 of 2/ })).toBeVisible()
    const versions = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
      api.ListVersions({ slotId: originalVersion.slotId })
    )
    expect(versions).toHaveLength(2)
    expect(versions[0]!.content).toBe(originalVersion.content)
    expect(versions[1]!.content).toBe(originalVersion.content + MORE)
    expect(provider.requests.at(-1)!.messages.at(-1)).toEqual({
      role: "assistant",
      content: originalVersion.content.trimEnd()
    })
    expect(JSON.stringify(provider.requests.at(-1))).not.toContain("reasoning_content")
    await reasoning.click()
    await expect(reply.getByRole("region", { name: "Reasoning" })).toContainText(THOUGHT)
    await shoot(page, "06-reasoning-expanded")
    await page.reload()
    await expect(reasoning).toHaveAttribute("aria-expanded", "false")
    await reasoning.click()
    await expect(reply.getByRole("region", { name: "Reasoning" })).toContainText("Finish the thought.")
    await shoot(page, "07-reasoning-reloaded")
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    await messageMenu(reply, "Context it was generated from")
    const prefill = page.getByRole("link", { name: /as it was, continued from its end/ })
    await prefill.scrollIntoViewIfNeeded()
    await expect(prefill).toBeVisible()
    await prefill
      .locator("xpath=ancestor::details")
      .locator("summary")
      .click({ position: { x: 15, y: 10 } })
    await shoot(page, "08-inspector-prefill")
    await expect(page.getByRole("region", { name: "Messages" })).toContainText("The ledger says")
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
  })

  test(`unavailable Continue explains why and reasoning preferences survive reload at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const { chat, connection, plain } = await setup()
    await page.goto(`${server().url}/chats/${chat.id}`)
    await page
      .getByRole("button", { name: /^(Reply$|Generate(?! another))/ })
      .last()
      .click()
    const reply = page.getByRole("article").last()
    const reasoning = reply.getByRole("button", { name: /Reasoning/ })
    await expect(reasoning).toHaveAttribute("aria-expanded", "true")
    await reasoning.click()
    await expect(reasoning).toHaveAttribute("aria-expanded", "false")
    await expect
      .poll(() => asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.GetDisplayPrefs({})))
      .toMatchObject({ reasoning: "collapsed" })
    await expect(reply.getByText("generating", { exact: true })).toHaveCount(0, { timeout: 20000 })
    await showActions(reply)
    await reply.getByRole("button", { name: "Generate another version" }).click()
    await expect(reply.getByText("generating", { exact: true })).toBeVisible()
    await expect(reasoning).toHaveAttribute("aria-expanded", "false")
    await page.reload()
    await expect(reasoning).toHaveAttribute("aria-expanded", "false")
    await expect(reply.getByText("generating", { exact: true })).toHaveCount(0, { timeout: 20000 })
    await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
      api.ChangeCast({
        chatId: chat.id,
        slotId: null,
        change: { _tag: "Model", connection: connection.id, model: plain.id }
      })
    )
    await showActions(reply)
    // A model not set up for a prefill: Continue says why and offers to enable it or try it once.
    const setUp = reply.getByRole("button", { name: "Continue: set up first" })
    await expect(setUp).toBeEnabled()
    await setUp.click()
    const popover = page.getByRole("dialog", { name: "Continue this reply" })
    await expect(popover).toContainText("no-prefill")
    await expect(popover.getByRole("button", { name: "Enable", exact: true })).toBeVisible()
    await expect(popover.getByRole("button", { name: "Try it once" })).toBeVisible()
    await shoot(page, "09-unavailable-budget")
    await page.keyboard.press("Escape")
    await expect(popover).toHaveCount(0)
    const versions = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
      api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 10 })
    )
    expect(versions.entries.at(-1)!.versionCount).toBe(2)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    await reasoning.click()
    await expect(reply.getByRole("region", { name: "Reasoning" })).toContainText(THOUGHT)
  })
  for (const adapter of ["deepseek", "schema"] as const) {
    test(`${adapter} Continue sends its protocol and exposes it in inspection at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const { chat } = await setup(
        adapter === "deepseek" ? "deepseek" : "openai-chat",
        adapter === "schema" ? "tool_schema" : "assistant",
        adapter === "deepseek"
      )
      provider.holdNextReply()
      await page.goto(`${server().url}/chats/${chat.id}`)
      await page
        .getByRole("button", { name: /^(Reply$|Generate(?! another))/ })
        .last()
        .click()
      const reply = page.getByRole("article").last()
      await expect(reply.locator(".markdown").last()).toContainText("The ledger says otherwise")
      await showActions(reply)
      await reply.getByRole("button", { name: "Stop", exact: true }).click()
      await expect(reply.getByText("stopped", { exact: true })).toBeVisible()
      const original = await reply.locator(".markdown").last().innerText()
      await showActions(reply)
      await reply.getByRole("button", { name: /^Continue:/ }).click()
      await expect(reply.locator(".markdown").last()).toContainText(original)
      await expect(reply.locator(".markdown").last()).toContainText("Before the watch changes", { timeout: 30000 })
      await expect(reply.getByText("generating", { exact: true })).toHaveCount(0)
      await shoot(page, `${adapter}-complete`)
      const sent = provider.requests.at(-1)!
      if (adapter === "deepseek") expect(sent.messages.at(-1)?.prefix).toBe(true)
      else expect(sent.tools).toHaveLength(1)
      await messageMenu(reply, "Context it was generated from")
      const label = adapter === "deepseek" ? "DeepSeek prefix: true" : "Forced tool schema prefill"
      await expect(page.getByText(label, { exact: true })).toBeVisible()
      if (adapter === "schema") {
        await page
          .getByText(label, { exact: true })
          .locator("xpath=ancestor::details")
          .locator("summary")
          .click({ position: { x: 15, y: 10 } })
        await expect(page.getByLabel("Prefill schema")).toContainText("pattern")
      }
      await shoot(page, `${adapter}-inspector`)
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    })
  }
}

for (const width of [1440, 390]) {
  test(`unknown prefill in the model editor does not claim a provider reported no at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const { connection } = await setup()
    await page.goto(`${server().url}/settings/connections/${connection.id}`)
    await page.getByRole("button", { name: "Edit native-prefill", exact: true }).click()
    const prefill = page.getByRole("combobox", { name: "Prefill", exact: true })
    await prefill.click()
    await expect(page.getByRole("option", { name: "Unknown: no provider information", exact: true })).toBeVisible()
    await expect(page.getByRole("option", { name: "Through a tool schema", exact: true })).toBeVisible()
    await shoot(page, "10-model-capabilities")
  })
}

for (const width of [1440, 390]) {
  test(`an edited reply can be continued into a new generated version at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const { chat } = await setup()
    await page.goto(`${server().url}/chats/${chat.id}`)
    await page
      .getByRole("button", { name: /^(Reply$|Generate(?! another))/ })
      .last()
      .click()
    const reply = page.getByRole("article").last()
    await expect(reply.locator(".markdown").last()).toContainText("The ledger says otherwise")
    await expect(reply.getByText("generating", { exact: true })).toHaveCount(0)
    await showActions(reply)
    await reply.getByRole("button", { name: "Edit", exact: true }).click()
    await reply.getByLabel("Message text").fill("The ledger is wrong,")
    await reply.getByRole("button", { name: "Save", exact: true }).click()
    await expect(reply.locator(".markdown").last()).toHaveText("The ledger is wrong,")
    await showActions(reply)
    await shoot(page, "07-edited-continue")
    await reply.getByRole("button", { name: /^Continue:/ }).click()
    await expect(reply.locator(".markdown").last()).toContainText("The ledger is wrong," + MORE.trimEnd())
    await expect(reply.getByText("generating", { exact: true })).toHaveCount(0)
    expect(provider.requests.at(-1)!.messages.at(-1)).toEqual({ role: "assistant", content: "The ledger is wrong," })
    const versions = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
      api
        .ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 10 })
        .pipe(Effect.flatMap((path) => api.ListVersions({ slotId: path.entries.at(-1)!.slotId })))
    )
    expect(versions.map((v) => v.writer)).toEqual(["model", "human", "model"])
    // Its header shows the time and tokens of both requests behind its text; a click opens
    // the details the tooltip also gives.
    const metrics = reply.getByRole("button", { name: /^Generation: \d+\.\d s · / })
    await expect(metrics).toBeVisible()
    await metrics.click()
    const panel = page.getByRole("dialog", { name: "Generation" })
    await expect(panel).toContainText("Time to first token")
    await expect(panel).toContainText("2 (includes original generation, retries and continuations)")
    expect(
      await panel.locator("dl").evaluate((element) => {
        const rect = element.getBoundingClientRect()
        const popup = element.closest('[role="dialog"]')!.getBoundingClientRect()
        return (
          rect.top >= popup.top &&
          rect.bottom <= popup.bottom &&
          (element.scrollHeight <= element.clientHeight ||
            ["auto", "scroll"].includes(getComputedStyle(element).overflowY))
        )
      })
    ).toBe(true)
    const lastFigures = panel.locator("dd").last()
    await lastFigures.scrollIntoViewIfNeeded()
    expect(
      await lastFigures.evaluate((element) => {
        const row = element.getBoundingClientRect()
        const popup = element.closest('[role="dialog"]')!.getBoundingClientRect()
        return row.top >= popup.top && row.bottom <= popup.bottom
      })
    ).toBe(true)
    expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    await shoot(page, "08-metrics")
    await page.keyboard.press("Escape")
    // The inspector's usage gives each request's times.
    await messageMenu(reply, "Context it was generated from")
    await expect(page.getByText("First token", { exact: true }).locator("visible=true")).toBeVisible()
    await expect(page.getByText("Tokens/s", { exact: true }).locator("visible=true")).toBeVisible()
    await page.getByText("Tokens/s", { exact: true }).locator("visible=true").scrollIntoViewIfNeeded()
    await shoot(page, "09-inspector-timings")
  })
}

for (const width of [1440, 390]) {
  test(`reasoning headers copy the raw reasoning and collapse every block at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.addInitScript(() => {
      const copied: Array<string> = []
      Object.assign(window, { copied })
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText: async (text: string) => void copied.push(text) }
      })
    })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const { chat } = await setup()
    await page.goto(`${server().url}/chats/${chat.id}`)
    const generate = async () => {
      await page
        .getByRole("button", { name: /^(Reply$|Generate(?! another))/ })
        .last()
        .click()
      const reply = page.getByRole("article").last()
      await expect(reply.locator(".markdown").last()).toContainText("The ledger says otherwise")
      await expect(reply.getByText("generating", { exact: true })).toHaveCount(0, { timeout: 20000 })
      return page.locator(`article[data-slot="${await reply.getAttribute("data-slot")}"]`)
    }
    const first = await generate()
    const path = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
      api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 10 })
    )
    await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
      api.SendMessage({
        chatId: chat.id,
        parentSlotId: path.entries.at(-1)!.slotId,
        branch: false,
        content: "And the bridge?"
      })
    )
    await expect(page.getByRole("article")).toHaveCount(3)
    const second = await generate()
    expect(await first.getAttribute("data-slot")).not.toBe(await second.getAttribute("data-slot"))
    for (const reply of [first, second]) {
      const toggle = reply.getByRole("button", { name: /^Reasoning/ })
      if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click()
      await expect(toggle).toHaveAttribute("aria-expanded", "true")
    }
    await shoot(page, "10-reasoning-actions")
    await second.getByRole("button", { name: "Copy reasoning", exact: true }).click()
    expect(await page.evaluate(() => (window as unknown as { copied: Array<string> }).copied)).toEqual([THOUGHT])
    await expect(page.getByText("Reasoning copied")).toBeVisible()
    await second.getByRole("button", { name: "Collapse all", exact: true }).click()
    for (const reply of [first, second])
      await expect(reply.getByRole("button", { name: /^Reasoning/ })).toHaveAttribute("aria-expanded", "false")
    await expect(page.getByRole("region", { name: "Reasoning" })).toHaveCount(0)
    await shoot(page, "11-reasoning-collapsed-all")
    // Collapse all is a view action: the streaming preference stays as it was.
    expect(await asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.GetDisplayPrefs({}))).toMatchObject({
      reasoning: "expanded"
    })
  })
}

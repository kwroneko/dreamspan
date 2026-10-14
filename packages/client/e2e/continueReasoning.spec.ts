import { expect, test } from "@playwright/test"
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

const setup = () =>
  asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      yield* api.SetDisplayPrefs({ prefs: { reasoning: "expanded" } })
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: "Synthetic native prefill",
          baseUrl: provider.baseUrl,
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        }
      })
      const model = yield* api.AddUserModel({
        connectionId: connection.id,
        key: "native-prefill",
        overrides: { prefill: "assistant" }
      })
      const plain = yield* api.AddUserModel({ connectionId: connection.id, key: "no-prefill", overrides: {} })
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
    await showActions(reply)
    await reply.getByRole("button", { name: "Stop", exact: true }).click()
    await expect(reply.getByText("stopped", { exact: true })).toBeVisible()
    await expect(reasoning).toHaveAttribute("aria-expanded", "false")
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
    await expect(reply.locator(".markdown").last()).toContainText("Before the watch changes")
    await expect(reply.getByText("generating", { exact: true })).toHaveCount(0)
    await expect(reasoning).toHaveAttribute("aria-expanded", "false")
    await showActions(reply)
    await reply.getByRole("button", { name: /choose a version/ }).click()
    await expect(page.getByRole("menu")).toContainText("stopped")
    await expect(page.getByRole("menu")).toContainText("The ledger says")
    await page.keyboard.press("Escape")
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
    await page.reload()
    await expect(reasoning).toHaveAttribute("aria-expanded", "false")
    await reasoning.click()
    await expect(reply.getByRole("region", { name: "Reasoning" })).toContainText("Finish the thought.")
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    await messageMenu(reply, "Context it was generated from")
    const prefill = page.getByRole("link", { name: /as it was, continued from its end/ })
    await prefill.scrollIntoViewIfNeeded()
    await expect(prefill).toBeVisible()
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
      .toEqual({ reasoning: "collapsed" })
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
    const unavailable = reply.getByRole("button", { name: /Continue isn't available with no-prefill/ })
    await expect(unavailable).toBeEnabled()
    await unavailable.click()
    await expect(page.getByRole("alert")).toContainText("a prefill")
    const versions = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
      api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 10 })
    )
    expect(versions.entries.at(-1)!.versionCount).toBe(2)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    await reasoning.click()
    await expect(reply.getByRole("region", { name: "Reasoning" })).toContainText(THOUGHT)
  })
}

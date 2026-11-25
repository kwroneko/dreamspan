// The next-swipe arrow past the last swipe starts another version even while the shown one is still
// being written (DESIGN §3.1): pressed twice, both versions generate and no error shows under the
// reply. A tool-written reply in a story chat and a workshop's. Synthetic data, scripted providers.
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { startAgentProvider } from "./support/agentProvider.ts"
import { showActions } from "./support/message.ts"
import { asUser, type Client } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { startWorkshopProvider } from "./support/workshopProvider.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: (client: Client) => Effect.Effect<A, unknown>) =>
  asUser(server(), ADMIN.handle, ADMIN.password, use)
const connect = (baseUrl: string, key: string) =>
  admin((api) =>
    Effect.gen(function* () {
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: "Synthetic",
          baseUrl,
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        }
      })
      const model = yield* api.AddUserModel({ connectionId: connection.id, key, overrides: {} })
      yield* api.SetGenerationDefaults({
        defaults: { model: { connection: connection.id, model: model.id }, preset: null }
      })
    })
  )

test.describe("a second next-swipe press while the first swipe is written", () => {
  test("in a tool-written story reply", async ({ page }) => {
    test.setTimeout(120_000)
    const provider = await startAgentProvider()
    try {
      await connect(provider.baseUrl, "agent-small")
      const chat = await admin((api) =>
        Effect.gen(function* () {
          const chat = yield* api.CreateChat({ title: "Swipe twice" })
          yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "AgentEnabled", on: true } })
          yield* api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "Is the bridge up?" })
          return chat
        })
      )
      await page.setViewportSize({ width: 1440, height: 900 })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/chats/${chat.id}`)
      await page
        .getByRole("button", { name: /^(Reply$|Generate(?! another))/ })
        .last()
        .click()
      const reply = page.getByRole("article").last()
      await expect(reply.getByText("generating", { exact: true })).toBeVisible()
      for (const held of [2, 3]) {
        await showActions(reply)
        await reply.getByRole("button", { name: /^(Generate another|Next) swipe/ }).click()
        await expect(reply.getByText(`${held}/${held}`, { exact: true })).toBeVisible()
        await expect(page.getByRole("alert").filter({ hasText: "still being written" })).toHaveCount(0)
      }
    } finally {
      await provider.stop()
    }
  })

  test("in a workshop reply", async ({ page }) => {
    test.setTimeout(120_000)
    const provider = await startWorkshopProvider({
      perTask: true,
      calls: [{ name: "list_library", arguments: { kind: "card" } }]
    })
    try {
      await connect(provider.baseUrl, "workshop-small")
      const workshop = await admin((api) => api.CreateWorkshop({ title: "Swipe twice" }))
      await page.setViewportSize({ width: 1440, height: 900 })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/chats/${workshop.id}`)
      await page.getByLabel("Message", { exact: true }).fill("What is in the library?")
      await page.getByRole("button", { name: /^Send( as .+)?$/ }).click()
      const reply = page.getByRole("article").last()
      await expect(reply.locator("[data-approval]")).toBeVisible()
      for (const held of [2, 3]) {
        await showActions(reply)
        await reply.getByRole("button", { name: /^(Generate another|Next) swipe/ }).click()
        await expect(reply.getByText(`${held}/${held}`, { exact: true })).toBeVisible()
        await expect(page.getByRole("alert").filter({ hasText: "still being written" })).toHaveCount(0)
      }
    } finally {
      await provider.stop()
    }
  })
})

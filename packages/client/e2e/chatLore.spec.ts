// Lorebook attachment through the real browser and workers to a synthetic provider.
import { expect, type Page, test } from "@playwright/test"
import { type FakeProvider, startProvider } from "./support/provider.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { openPanel } from "./support/panel.ts"

const server = serverPerFile(withAdmin)
let provider: FakeProvider
let chatId = ""

const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)

test.beforeAll(async () => {
  provider = await startProvider()
  const connection = await admin((api) =>
    api.CreateConnection({
      kind: "openai-chat",
      settings: {
        name: "Local model server",
        baseUrl: provider.baseUrl,
        compat: {},
        cacheTtlS: null,
        maxConcurrent: null,
        presetOverrideRefId: null
      },
      apiKey: "sk-notes-test-key-0042"
    })
  )
  await admin((api) => api.RefreshModels({ connectionId: connection.id }))
  const models = await admin((api) => api.ListModels({ connectionId: connection.id, includeHidden: false }))
  const model = models.find((m) => m.key === "fake-small")!
  await admin((api) =>
    api.SetGenerationDefaults({ defaults: { model: { connection: connection.id, model: model.id }, preset: null } })
  )
  const mira = await admin((api) => api.CreateCard({ label: "Mira", name: "Mira" }))
  const started = await admin((api) =>
    api.StartChat({
      cards: [mira.entityId],
      persona: null,
      greeting: null,
      first: { _tag: "Send", content: "The river is rising.", speakerEntityId: null }
    })
  )
  chatId = started.chat.id
})
test.afterAll(async () => {
  await provider.stop()
})

/** Sends a message; the reply that follows is generated through the fake provider. */
const send = async (page: Page, text: string) => {
  const before = provider.completions.length
  await page.getByLabel("Message", { exact: true }).fill(text)
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect.poll(() => provider.completions.length).toBe(before + 1)
  await expect(page.getByText("The bridge holds.").last()).toBeVisible()
  return JSON.stringify(provider.completions.at(-1)!.messages)
}

test("attach a lorebook, send a keyword, and detach it from the provider request", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/import`)
  await page.getByLabel("Choose files, or drop them here").setInputFiles({
    name: "Lantern lore.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        entries: {
          0: {
            uid: 0,
            key: ["lantern"],
            content: "The watch lights seven lanterns.",
            order: 100,
            position: 0,
            disable: false
          }
        }
      })
    )
  })
  await expect.poll(async () => (await admin((api) => api.ListLibrary({ kind: "lorebook" }))).length).toBe(1)
  await page.goto(`${server().url}/chats/${chatId}`)
  // What the chat sends with: the account's current model, in the composer.
  await expect(page.getByRole("combobox", { name: "Model", exact: true })).toHaveText("Local model server · fake-small")
  // Only the lorebooks that apply are listed; the library's are a search away.
  const tab = await openPanel(page, "Lorebooks")
  const inChat = tab.getByRole("list", { name: "Added to this chat" })
  await expect(tab.getByRole("region", { name: "Added to this chat" }).getByText("None yet.")).toBeVisible()
  await tab.getByRole("button", { name: "Add lorebook" }).click()
  await tab.getByRole("searchbox").fill("lantern")
  await tab
    .getByRole("list", { name: "Lorebooks to add" })
    .getByRole("button", { name: /Lantern lore/ })
    .click()
  await expect(inChat.getByRole("switch", { name: "Lantern lore" })).toBeChecked()
  // The chat stays usable beside the panel.
  expect(await send(page, "Where is the lantern?")).toContain("The watch lights seven lanterns.")
  await inChat.getByRole("switch", { name: "Lantern lore" }).click()
  await expect(inChat.getByRole("switch", { name: "Lantern lore" })).not.toBeChecked()
  expect(await send(page, "And the lantern now?")).not.toContain("The watch lights seven lanterns.")
})

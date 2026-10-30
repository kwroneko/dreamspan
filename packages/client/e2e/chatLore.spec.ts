// Lorebook attachment through the real browser and workers to a synthetic provider.
import { mkdirSync } from "node:fs"
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
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
  await expect(inChat.getByRole("switch", { name: /^Lantern lore(?: |$)/ })).toBeChecked()
  // The chat stays usable beside the panel.
  expect(await send(page, "Where is the lantern?")).toContain("The watch lights seven lanterns.")
  await inChat.getByRole("switch", { name: /^Lantern lore(?: |$)/ }).click()
  await expect(inChat.getByRole("switch", { name: /^Lantern lore(?: |$)/ })).not.toBeChecked()
  expect(await send(page, "And the lantern now?")).not.toContain("The watch lights seven lanterns.")

  // A book that's both added here and global is listed once, under Global, with the switch for this chat.
  await inChat.getByRole("switch", { name: /^Lantern lore(?: |$)/ }).click()
  await expect(inChat.getByRole("switch", { name: /^Lantern lore(?: |$)/ })).toBeChecked()
  await tab.getByRole("button", { name: "Use Lantern lore in every chat" }).click()
  const globals = tab.getByRole("list", { name: "Global lorebooks" })
  await expect(globals.getByRole("switch", { name: /^Lantern lore(?: |$)/ })).toBeChecked()
  await expect(tab.getByRole("switch", { name: /^Lantern lore(?: |$)/ })).toHaveCount(1)
  await expect(globals.getByRole("switch", { name: /^Added to this chat: Lantern lore/ })).toBeChecked()
  expect(await send(page, "The lantern, again?")).toContain("The watch lights seven lanterns.")
  // Global use never changes the separate attachment.
  await globals.getByRole("switch", { name: /^Lantern lore(?: |$)/ }).click()
  await expect(globals.getByRole("switch", { name: /^Lantern lore(?: |$)/ })).not.toBeChecked()
  await expect(tab.getByRole("switch", { name: /^Lantern lore(?: |$)/ })).toHaveCount(1)
  const book = (await admin((api) => api.ListLibrary({ kind: "lorebook" })))[0]!
  const cast = () =>
    admin((api) =>
      Effect.gen(function* () {
        const chat = yield* api.GetChat({ chatId: chatId as never })
        return yield* api.GetCast({ chatId: chat.id, slotId: chat.activeLeafSlotId, forkId: chat.currentForkId })
      })
    )
  expect((await cast()).lorebooks).toContain(book.id)
  expect(await send(page, "The lantern, global off but attached?")).toContain("The watch lights seven lanterns.")
  await globals.getByRole("switch", { name: /^Added to this chat: Lantern lore/ }).click()
  expect(await send(page, "The lantern, both off?")).not.toContain("The watch lights seven lanterns.")
  await globals.getByRole("switch", { name: /^Lantern lore(?: |$)/ }).click()
  await expect(globals.getByRole("switch", { name: /^Lantern lore(?: |$)/ })).toBeChecked()
  expect(await send(page, "The lantern, on?")).toContain("The watch lights seven lanterns.")
  expect((await cast()).lorebooks).not.toContain(book.id)
  await globals.getByRole("switch", { name: /^Added to this chat: Lantern lore/ }).click()
  expect((await cast()).lorebooks).toContain(book.id)
  await globals.getByRole("switch", { name: /^Lantern lore(?: |$)/ }).click()
  expect((await cast()).lorebooks).toContain(book.id)
  await globals.getByRole("switch", { name: /^Lantern lore(?: |$)/ }).click()
  expect((await cast()).lorebooks).toContain(book.id)
  if (process.env.SCREENSHOT_DIR) {
    mkdirSync(process.env.SCREENSHOT_DIR, { recursive: true })
    for (const width of [1440, 390])
      for (const theme of ["light", "dark"] as const) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
        await page.emulateMedia({ colorScheme: theme })
        await page.evaluate((theme) => document.documentElement.setAttribute("data-theme", theme), theme)
        await globals.scrollIntoViewIfNeeded()
        await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/lorebooks-${width}-${theme}.png` })
      }
  }
})

// A chat's notes (DESIGN §4.1), through real generation: a note made in the chat, turned on
// at the latest message, reaches the request the provider receives, and stops reaching it
// once turned off; a card's note is edited as the card's. The provider is a fake on
// loopback, and the cards are made up.
import { expect, type Page, test } from "@playwright/test"
import type { RefId } from "@rp/shared/library.ts"
import { type FakeProvider, startProvider } from "./support/provider.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

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
  await admin((api) => api.CreateCardNote({ cardRefId: mira.id as RefId, title: "Outfit" }))
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

test("a note made in the chat goes into the request once on, and out once off", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chatId}`)
  await expect(page.getByText("The river is rising.")).toBeVisible()

  await page.getByRole("button", { name: "Notes" }).click()
  const dialog = page.getByRole("dialog", { name: "Notes" })
  await dialog.getByRole("button", { name: "New note" }).click()
  const editor = dialog.getByRole("region", { name: "Note Note" })
  await editor.getByLabel("Content").fill("Lanterns burn along the levee.")
  await editor.getByRole("button", { name: "Save the note" }).click()
  await page.getByRole("dialog", { name: "Save a revision" }).getByRole("button", { name: "Save revision" }).click()
  await expect(editor.getByText("unsaved changes")).toHaveCount(0)
  // Made here, it's on from here.
  const own = dialog.getByRole("region", { name: "This chat's notes" })
  await expect(own.getByRole("switch", { name: "Note" })).toBeChecked()
  // Mira's note is hers: editing it here says so.
  const hers = dialog.getByRole("region", { name: "Mira's notes" })
  await hers.getByRole("button", { name: "Edit Outfit" }).click()
  await expect(hers.getByText("saving it changes it in the library, in every chat with Mira")).toBeVisible()
  await expect(hers.getByRole("button", { name: "Delete the note" })).toHaveCount(0)
  await dialog.getByRole("button", { name: "Done" }).click()

  expect(await send(page, "Is the levee holding?")).toContain("Lanterns burn along the levee.")

  await page.getByRole("button", { name: "Notes" }).click()
  await own.getByRole("switch", { name: "Note" }).click()
  await expect(own.getByRole("switch", { name: "Note" })).not.toBeChecked()
  await dialog.getByRole("button", { name: "Done" }).click()
  expect(await send(page, "And now?")).not.toContain("Lanterns burn")
})

test("the notes fit a phone, under the Content-Security-Policy", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const page = await context.newPage()
  const violations: Array<string> = []
  page.on("console", (message) => {
    if (message.text().includes("Content Security Policy")) violations.push(message.text())
  })
  await apiLogin(context.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chatId}`)
  await page.getByRole("button", { name: "Notes" }).click()
  const hers = page.getByRole("dialog", { name: "Notes" }).getByRole("region", { name: "Mira's notes" })
  await hers.getByRole("button", { name: "Edit Outfit" }).click()
  await expect(hers.getByLabel("Content")).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
  expect(violations).toEqual([])
  await context.close()
})

// The side panel and Settings → Chats keep what's typed and show what's in effect: an unsaved
// instruction and a summary's edit survive leaving, a failed save and a tab switch; the
// composer's model follows changes made elsewhere, hidden or not; one setting's change leaves
// the others;
// the own lorebook is named; the panel's remembered tab is each user's own.
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { asUser } from "./support/rpc.ts"
import { level1 } from "./support/summaries.ts"
import type { SummaryId } from "@rp/shared/lcm.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "60" })
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
test.use({ viewport: { width: 1440, height: 900 } })
test.beforeEach(async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
})

let connections = 0
const models = async () => {
  const settings = {
    name: `Connection ${++connections}`,
    baseUrl: "http://127.0.0.1:5999/v1",
    compat: {},
    cacheTtlS: null,
    maxConcurrent: null,
    presetOverrideRefId: null
  }
  return admin((api) =>
    Effect.gen(function* () {
      const connection = yield* api.CreateConnection({ kind: "openai-chat", settings })
      const a = yield* api.AddUserModel({ connectionId: connection.id, key: "model-a", overrides: {} })
      const b = yield* api.AddUserModel({ connectionId: connection.id, key: "model-b", overrides: {} })
      return { connection, settings, a, b }
    })
  )
}
const emptyChat = (title: string) => admin((api) => api.CreateChat({ title }))
const summarized = async (title: string) => {
  const chat = await emptyChat(title)
  const sent = await admin((api) =>
    api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "A story happened." })
  )
  if (sent._tag !== "Posted") throw new Error("unexpected queue")
  return { chat, summary: await level1(server().dataDir, chat.id, [sent.entry], "The original summary.") }
}

test("an unsaved summarization instruction survives leaving Settings → Chats and a reload", async ({ page }) => {
  await page.goto(`${server().url}/settings/chats`)
  const field = page.getByLabel("Summarization instruction", { exact: true })
  await expect(field).toBeEnabled()
  await field.fill("A long unsaved instruction draft must remain reachable.")
  await expect(page.getByText("Not saved yet: kept in this browser until you save it.")).toBeVisible()
  await page.getByRole("link", { name: "Connections", exact: true }).click()
  await page.getByRole("link", { name: "Chats", exact: true }).click()
  await expect(field).toBeEnabled()
  await expect(field).toHaveValue("A long unsaved instruction draft must remain reachable.")
  await page.reload()
  await expect(field).toHaveValue("A long unsaved instruction draft must remain reachable.")
  await expect(page.getByText("Typed earlier and not saved yet: kept in this browser until you save it.")).toBeVisible()
  // Saved, the browser's copy goes: the field shows the saved text, with nothing pending.
  await page.getByRole("button", { name: "Save summarization instruction" }).click()
  await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible()
  expect((await admin((api) => api.GetGenerationDefaults())).lcm?.tail).toBe(
    "A long unsaved instruction draft must remain reachable."
  )
  await page.reload()
  await expect(field).toHaveValue("A long unsaved instruction draft must remain reachable.")
  await expect(page.getByText(/kept in this browser/)).toHaveCount(0)
})

test("switching tabs saves text typed while a summary draft save was in flight", async ({ page }) => {
  const { chat, summary } = await summarized("Summary draft in flight")
  let release: (() => void) | null = null
  await page.routeWebSocket("**/rpc", (socket) => {
    const upstream = socket.connectToServer()
    socket.onMessage((message) => {
      if (release === null && String(message).includes('"tag":"SaveSummaryDraft"'))
        release = () => upstream.send(message)
      else upstream.send(message)
    })
    upstream.onMessage((message) => socket.send(message))
  })
  await page.goto(`${server().url}/chats/${chat.id}?panel=summaries`)
  const row = page.locator(`[data-summary="${summary.id}"]`)
  await row.getByRole("button", { name: /^Edit / }).click()
  const box = row.getByRole("textbox")
  await expect(box).toBeEnabled()
  await box.fill("First edit held in flight.")
  await expect.poll(() => release !== null).toBe(true)
  await box.fill("The latest text typed before switching tabs.")
  await page.getByRole("tab", { name: "Notes", exact: true }).click()
  release!()
  await expect
    .poll(
      async () =>
        (await admin((api) => api.GetSummaryDraft({ summaryId: summary.id as typeof SummaryId.Type })))?.content
    )
    .toBe("The latest text typed before switching tabs.")
  await page.getByRole("tab", { name: "Summaries", exact: true }).click()
  await expect(box).toHaveValue("The latest text typed before switching tabs.")
})

test("summary text survives a failed save and switching to another tab", async ({ page }) => {
  const { chat, summary } = await summarized("Offline summary")
  await page.goto(`${server().url}/chats/${chat.id}?panel=summaries`)
  const row = page.locator(`[data-summary="${summary.id}"]`)
  await row.getByRole("button", { name: /^Edit / }).click()
  const box = row.getByRole("textbox")
  await expect(box).toBeEnabled()
  await server().pause()
  await box.fill("Offline text must survive switching tabs.")
  await page.getByRole("tab", { name: "Notes", exact: true }).click()
  // The edit is still there behind the other tab.
  await page.getByRole("tab", { name: "Summaries", exact: true }).click()
  await expect(box).toHaveValue("Offline text must survive switching tabs.")
  await page.getByRole("tab", { name: "Notes", exact: true }).click()
  await server().restart()
  // A reload too: the copy in this browser goes to the server when the edit opens again.
  await page.goto(`${server().url}/chats/${chat.id}?panel=summaries`)
  await row.getByRole("button", { name: /^Edit / }).click()
  await expect(box).toBeEnabled()
  await expect(box).toHaveValue("Offline text must survive switching tabs.")
  await expect
    .poll(
      async () =>
        (await admin((api) => api.GetSummaryDraft({ summaryId: summary.id as typeof SummaryId.Type })))?.content
    )
    .toBe("Offline text must survive switching tabs.")
})

test("the composer's model follows a default changed in another tab", async ({ page }) => {
  const { connection, a, b } = await models()
  const chat = await emptyChat("Model defaults")
  await admin((api) =>
    api.SetGenerationDefaults({ defaults: { model: { connection: connection.id, model: a.id }, preset: null } })
  )
  await page.goto(`${server().url}/chats/${chat.id}`)
  const model = page.getByRole("combobox", { name: "Model", exact: true })
  await expect(model).toHaveText(`${connection.name} · model-a`)
  await admin((api) =>
    api.SetGenerationDefaults({ defaults: { model: { connection: connection.id, model: b.id }, preset: null } })
  )
  await expect(model).toHaveText(`${connection.name} · model-b`)
})

test("a hidden model in use is named, not described as gone", async ({ page }) => {
  const { connection, a } = await models()
  const chat = await emptyChat("Hidden model")
  await admin((api) =>
    api.SetGenerationDefaults({ defaults: { model: { connection: connection.id, model: a.id }, preset: null } })
  )
  await admin((api) => api.SetModelHidden({ modelId: a.id, hidden: true }))
  await page.goto(`${server().url}/chats/${chat.id}`)
  await expect(page.getByRole("combobox", { name: "Model", exact: true })).toHaveText(
    `${connection.name} · model-a (hidden)`
  )
  await page.goto(`${server().url}/settings/chats`)
  await expect(page.getByRole("combobox", { name: "Default model" })).toHaveText(
    `${connection.name} · model-a (hidden)`
  )
})

test("changing the refusal judge leaves a default model changed in another tab", async ({ page }) => {
  const { connection, a, b } = await models()
  await admin((api) =>
    api.SetGenerationDefaults({ defaults: { model: { connection: connection.id, model: a.id }, preset: null } })
  )
  await page.goto(`${server().url}/settings/chats`)
  await expect(page.getByLabel("Default model", { exact: true })).toContainText("model-a")
  await admin((api) =>
    api.SetGenerationDefaults({ defaults: { model: { connection: connection.id, model: b.id }, preset: null } })
  )
  await page.getByLabel("Refusal judge", { exact: true }).click()
  await page.getByRole("option", { name: `${connection.name} · model-a`, exact: true }).click()
  await expect.poll(async () => (await admin((api) => api.GetGenerationDefaults())).judge?.model).toBe(a.id)
  expect((await admin((api) => api.GetGenerationDefaults())).model?.model).toBe(b.id)
  // The page shows the default as it now is.
  await expect(page.getByLabel("Default model", { exact: true })).toContainText("model-b")
})

test("a card's own lorebook is listed by its name and entry count", async ({ page }) => {
  const response = await page.request.post(`${server().url}/library/import?name=Aria.json`, {
    headers: { origin: server().url, "content-type": "application/octet-stream" },
    data: Buffer.from(
      JSON.stringify({
        spec: "chara_card_v2",
        spec_version: "2.0",
        data: {
          name: "Aria Vance",
          description: "Synthetic captain.",
          first_mes: "Hello.",
          character_book: {
            name: "Harbor secrets",
            entries: [{ keys: ["harbor"], content: "Synthetic harbor lore.", enabled: true, id: 0 }]
          }
        }
      })
    )
  })
  expect(response.status()).toBe(200)
  const card = (await admin((api) => api.ListCards())).find((c) => c.name === "Aria Vance")!
  const started = await admin((api) =>
    api.StartChat({
      cards: [card.entityId],
      persona: null,
      greeting: null,
      first: { _tag: "Send", content: "hello", speakerEntityId: null }
    })
  )
  await page.goto(`${server().url}/chats/${started.chat.id}?panel=lorebooks`)
  const books = page.getByRole("list", { name: "Lorebooks in this chat" })
  await expect(books.getByRole("switch", { name: "Harbor secrets" })).toBeChecked()
  await expect(books).toContainText("Aria Vance's own lorebook · 1 entry")
})

test("the panel's remembered tab is the signed-in user's own", async ({ page }) => {
  const first = await emptyChat("Admin panel preference")
  await page.goto(`${server().url}/chats/${first.id}?panel=notes`)
  await expect(page.getByRole("tabpanel", { name: "Notes" })).toBeVisible()
  // A click records it, as a user opening the tab does.
  await page.getByRole("tab", { name: "Cast", exact: true }).click()
  await page.getByRole("tab", { name: "Notes", exact: true }).click()
  await admin((api) =>
    api.CreateUser({ handle: "panel-other", displayName: "Other", role: "user", password: "other-password-123" })
  )
  const second = await asUser(server(), "panel-other", "other-password-123", (api) =>
    api.CreateChat({ title: "Other user chat" })
  )
  await apiLogin(page.request, server(), "panel-other", "other-password-123")
  await page.goto(`${server().url}/chats/${second.id}`)
  await expect(page.getByRole("heading", { level: 1, name: "Other user chat" })).toBeVisible()
  await expect(page.getByRole("tabpanel", { name: "Notes" })).toHaveCount(0)
  // The first user's choice is still theirs.
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${first.id}`)
  await expect(page.getByRole("tabpanel", { name: "Notes" })).toBeVisible()
})

test("an instruction typed back to its old text while Save is in flight survives a reload", async ({ page }) => {
  await admin((api) => api.ChangeGenerationDefaults({ change: { tail: "Original persisted instruction" } }))
  // Holds the page's Save until the edit after it is typed.
  let release: (() => void) | null = null
  await page.routeWebSocket("**/rpc", (socket) => {
    const upstream = socket.connectToServer()
    socket.onMessage((message) => {
      if (release === null && String(message).includes('"tag":"ChangeGenerationDefaults"'))
        release = () => upstream.send(message)
      else upstream.send(message)
    })
    upstream.onMessage((message) => socket.send(message))
  })
  await page.goto(`${server().url}/settings/chats`)
  const field = page.getByLabel("Summarization instruction", { exact: true })
  await expect(field).toHaveValue("Original persisted instruction")
  await field.fill("First edit sent to Save")
  await page.getByRole("button", { name: "Save summarization instruction" }).click()
  await expect.poll(() => release !== null).toBe(true)
  await field.fill("Original persisted instruction")
  release!()
  await expect
    .poll(async () => (await admin((api) => api.GetGenerationDefaults())).lcm?.tail)
    .toBe("First edit sent to Save")
  await page.reload()
  await expect(field).toHaveValue("Original persisted instruction")
})

import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
import { type FakeProvider, startProvider } from "./support/provider.ts"
import { loginCookie, withCookie } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
let cookie: string
let provider: FakeProvider
const admin = <A>(use: Parameters<typeof withCookie<A>>[2]) => withCookie(server(), cookie, use)

test.beforeAll(async () => {
  cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
})
test.beforeEach(async () => {
  provider = await startProvider({
    holdAfterText: true,
    reply: "<thinking>Private reasoning.</thinking>I open the gate."
  })
  await admin((api) =>
    Effect.gen(function* () {
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: "Draft model",
          baseUrl: provider.baseUrl,
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        }
      })
      const model = yield* api.AddUserModel({ connectionId: connection.id, key: "fake-small", overrides: {} })
      yield* api.SetGenerationDefaults({
        defaults: { model: { connection: connection.id, model: model.id }, preset: null }
      })
    })
  )
})
test.afterEach(async () => {
  await provider.stop()
})

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`Write for me appends, stops, undoes and inspects at ${width} ${theme}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
      const chat = await admin((api) => api.CreateChat({ title: "Gate draft" }))
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/chats/${chat.id}`)
      const composer = page.getByTestId("composer")
      const before = "  My exact opening. \n"
      await expect(composer).toBeEditable()
      const guidance = page.getByRole("switch", { name: "Guidance", exact: true })
      await expect(guidance).toBeEnabled()
      await guidance.click()
      await expect(guidance).toBeChecked()
      await composer.fill(before)
      const control = page.getByRole("button", { name: "Write for me", exact: true })
      await expect(control).toBeEnabled()
      await control.click()
      await expect(composer).toHaveValue(`${before}\nI open the gate.`)
      await expect(guidance).not.toBeChecked()
      await expect(page.getByLabel("Message", { exact: true })).toHaveValue(`${before}\nI open the gate.`)
      await expect(page.getByRole("button", { name: "Stop writing", exact: true })).toBeVisible()
      await expect(composer).toBeEditable()
      await expectLayout(page, info, "streaming composer", { scope: '[data-testid="composer-box"]' })
      const dir = process.env.SCREENSHOT_DIR
      if (dir) await page.screenshot({ path: join(dir, `write-for-me-${width}-${theme}-stream.png`), fullPage: true })
      await page.getByRole("button", { name: "Stop writing", exact: true }).click()
      await expect(composer).toBeEditable()
      await expect(composer).toHaveValue(`${before}\nI open the gate.`)
      expect(provider.completions).toHaveLength(1)
      expect(JSON.stringify(provider.completions[0])).toContain("Write User's next message")
      expect(JSON.stringify(provider.completions[0])).not.toContain("My exact opening")
      await expect(page.getByRole("article")).toHaveCount(0)
      await page.getByRole("button", { name: "Undo draft", exact: true }).click()
      await expect(composer).toHaveValue(before)
      await expectLayout(page, info, "finished composer", { scope: '[data-testid="composer-box"]' })
      await page.getByRole("link", { name: "View request", exact: true }).click()
      await expect(page.getByRole("heading", { name: "The request that drafted your message" })).toBeVisible()
      await expect(page.getByRole("heading", { name: "Usage", exact: true })).toBeVisible()
      await expect(page.getByText("impersonate,", { exact: false })).toBeVisible()
      await expectLayout(page, info, "draft request inspector")
      if (dir) await page.screenshot({ path: join(dir, `write-for-me-${width}-${theme}-request.png`), fullPage: true })
      await page.reload()
      await expect(page.getByRole("heading", { name: "The request that drafted your message" })).toBeVisible()
      await page.getByRole("link", { name: "Back to the composer", exact: false }).click()
      await expect(composer).toHaveValue(before)
      await expect(page.getByRole("link", { name: "View request", exact: true })).toBeVisible()
      // Sending while another draft streams stops it before committing this draft's text.
      await admin((api) =>
        Effect.gen(function* () {
          const draft = yield* api.OpenComposer({ chatId: chat.id, forkId: chat.currentForkId })
          yield* api.SetComposerChoice({ chatId: chat.id, draftId: draft.id, noReplies: true })
        })
      )
      await page.getByRole("button", { name: "Write for me", exact: true }).click()
      await expect(composer).toHaveValue(`${before}\nI open the gate.`)
      await expect(page.getByRole("button", { name: "Stop writing", exact: true })).toBeVisible()
      await page.getByRole("button", { name: "Send", exact: true }).click()
      await expect(page.getByRole("article", { name: "Your message" })).toContainText("I open the gate.")
      await expect(composer).toHaveValue("")
      expect(provider.completions).toHaveLength(2)
    })
  }

test("leaving a chat stops the draft and never appends to another chat", async ({ page }) => {
  const chats = await admin((api) =>
    Effect.all([api.CreateChat({ title: "First draft" }), api.CreateChat({ title: "Second draft" })])
  )
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chats[0]!.id}`)
  await expect(page.getByRole("button", { name: "Write for me", exact: true })).toBeEnabled()
  await page.getByRole("button", { name: "Write for me", exact: true }).click()
  await expect(page.getByTestId("composer")).toHaveValue("I open the gate.")
  await page.goto(`${server().url}/chats/${chats[1]!.id}`)
  await expect(page.getByTestId("composer")).toHaveValue("")
  provider.release()
  await page.goto(`${server().url}/chats/${chats[0]!.id}`)
  await expect(page.getByTestId("composer")).toHaveValue("I open the gate.")
  expect(provider.completions).toHaveLength(1)
})

test("typing during a draft keeps the edit and caret and stops further output", async ({ page }) => {
  const chat = await admin((api) => api.CreateChat({ title: "Editable draft" }))
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chat.id}`)
  const composer = page.getByTestId("composer")
  await expect(composer).toBeEditable()
  await composer.fill("My opening.")
  await page.getByRole("button", { name: "Write for me", exact: true }).click()
  await expect(composer).toHaveValue("My opening.\n\nI open the gate.")
  await expect(composer).toBeEditable()
  await composer.focus()
  await composer.press("Home")
  await composer.pressSequentially("Now ")
  const edited = "My opening.\n\nNow I open the gate."
  await expect(composer).toHaveValue(edited)
  await expect(page.getByRole("button", { name: "Write for me", exact: true })).toBeVisible()
  expect(await composer.evaluate((node: HTMLTextAreaElement) => node.selectionStart)).toBe(17)
  provider.release()
  await expect(composer).toHaveValue(edited)
  expect(provider.completions).toHaveLength(1)
  await page.reload()
  await expect(composer).toHaveValue(edited)
  expect(provider.completions).toHaveLength(1)
})

test("a disconnected stream is never replayed on reconnect or draft restoration", async ({ page }) => {
  let disconnect = () => {}
  await page.routeWebSocket(/\/rpc$/, (socket) => {
    const upstream = socket.connectToServer()
    disconnect = () => {
      socket.close()
      upstream.close()
    }
  })
  const chat = await admin((api) => api.CreateChat({ title: "Disconnected draft" }))
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chat.id}`)
  const composer = page.getByTestId("composer")
  await page.getByRole("button", { name: "Write for me", exact: true }).click()
  await expect(composer).toHaveValue("I open the gate.")
  disconnect()
  await expect(page.getByRole("button", { name: "Write for me", exact: true })).toBeVisible()
  provider.release()
  await page.reload()
  await expect(composer).toHaveValue("I open the gate.")
  await expect(page.getByRole("button", { name: "Write for me", exact: true })).toBeEnabled()
  expect(provider.completions).toHaveLength(1)
})

test("two tabs explicitly draft independently and closing one preserves the other's text", async ({
  page,
  context
}) => {
  const chat = await admin((api) => api.CreateChat({ title: "Two draft tabs" }))
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chat.id}`)
  const other = await context.newPage()
  await other.goto(`${server().url}/chats/${chat.id}`)
  await expect(page.getByRole("button", { name: "Write for me", exact: true })).toBeEnabled()
  await expect(other.getByRole("button", { name: "Write for me", exact: true })).toBeEnabled()
  expect(provider.completions).toHaveLength(0)
  await page.getByRole("button", { name: "Write for me", exact: true }).click()
  await expect(page.getByTestId("composer")).toHaveValue("I open the gate.")
  await other.getByRole("button", { name: "Write for me", exact: true }).click()
  await expect(other.getByTestId("composer")).toHaveValue("I open the gate.")
  expect(provider.completions).toHaveLength(2)
  await other.close()
  await page.getByRole("button", { name: "Stop writing", exact: true }).click()
  provider.release()
  await expect(page.getByTestId("composer")).toHaveValue("I open the gate.")
  await expect(page.getByRole("article")).toHaveCount(0)
  expect(provider.completions).toHaveLength(2)
})

test("drafting during a streaming reply starts only the explicitly requested draft", async ({ page }) => {
  const chat = await admin((api) => api.CreateChat({ title: "Reply and draft" }))
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chat.id}`)
  const generate = page.getByRole("button", { name: "Generate", exact: true })
  await expect(generate).toBeEnabled()
  await generate.click()
  await expect(page.getByRole("article")).toHaveCount(1)
  const write = page.getByRole("button", { name: "Write for me", exact: true })
  await expect(write).toBeEnabled()
  await write.click()
  await expect(page.getByTestId("composer")).toHaveValue("I open the gate.")
  await page.getByRole("button", { name: "Stop writing", exact: true }).click()
  provider.release()
  await expect(page.getByRole("article")).toHaveCount(1)
  expect(provider.completions).toHaveLength(2)
})

test("a branch switch stops the stream and preserves each branch's composer", async ({ page }) => {
  const chat = await admin((api) => api.CreateChat({ title: "Branch drafts" }))
  const peer = await admin((api) => api.CreateFork({ chatId: chat.id, fromForkId: chat.currentForkId, atSlotId: null }))
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chat.id}?fork=${chat.currentForkId}`)
  const composer = page.getByTestId("composer")
  await expect(composer).toBeEditable()
  await composer.fill("Original branch.")
  await page.getByRole("button", { name: "Write for me", exact: true }).click()
  await expect(composer).toHaveValue("Original branch.\n\nI open the gate.")
  await page.goto(`${server().url}/chats/${chat.id}?fork=${peer.fork.id}`)
  await expect(composer).toHaveValue("")
  await composer.fill("Peer branch.")
  provider.release()
  await expect(composer).toHaveValue("Peer branch.")
  await page.goto(`${server().url}/chats/${chat.id}?fork=${chat.currentForkId}`)
  await expect(composer).toHaveValue("Original branch.\n\nI open the gate.")
  expect(provider.completions).toHaveLength(1)
})

test("switching branch during the guidance change cannot submit on the destination branch", async ({ page }, info) => {
  let armed = false
  let release: (() => void) | null = null
  await page.routeWebSocket(/\/rpc$/, (socket) => {
    const upstream = socket.connectToServer()
    socket.onMessage((data) => {
      if (armed && release === null && typeof data === "string") {
        const request = JSON.parse(data) as { tag?: string; payload?: { guidance?: boolean } }
        if (request.tag === "SetComposerChoice" && request.payload?.guidance === false) {
          release = () => upstream.send(data)
          return
        }
      }
      upstream.send(data)
    })
  })
  const chat = await admin((api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title: "Guidance branch race" })
      const root = yield* api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "Root." })
      if (root._tag !== "Posted") throw new Error("unexpected queue")
      yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: root.entry.slotId,
        branch: false,
        content: "Destination-only secret."
      })
      yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: root.entry.slotId,
        branch: true,
        content: "Origin branch."
      })
      return chat
    })
  )
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chat.id}`)
  const guidance = page.getByRole("switch", { name: "Guidance", exact: true })
  await expect(guidance).toBeEnabled()
  await guidance.click()
  await expect(guidance).toBeChecked()
  armed = true
  await page.getByRole("button", { name: "Write for me", exact: true }).click()
  await expect.poll(() => release !== null).toBe(true)
  await page.getByRole("button", { name: "Previous branch" }).click()
  await expect(page.getByRole("article").filter({ hasText: "Destination-only secret." })).toBeVisible()
  release!()
  await expect(guidance).toBeEnabled()
  await page.waitForTimeout(500)
  await info.attach("captured-provider-requests", {
    body: JSON.stringify(provider.completionBytes),
    contentType: "application/json"
  })
  expect(provider.completionBytes).toHaveLength(0)
  await expect(page.getByTestId("composer")).toHaveValue("")
})

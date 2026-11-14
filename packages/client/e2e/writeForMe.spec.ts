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
      await expect(composer).not.toBeEditable()
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

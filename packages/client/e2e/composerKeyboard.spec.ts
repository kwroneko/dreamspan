// Synthetic replies only: keyboard controls must preserve drafts and share visible actions.
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { startContinueProvider } from "./support/continueProvider.ts"
import { type Client, loginCookie, withCookie } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
let provider: Awaited<ReturnType<typeof startContinueProvider>>
test.beforeAll(async () => {
  provider = await startContinueProvider()
})
test.afterAll(async () => {
  await provider.stop()
})
let cookie: Promise<string> | null = null
const admin = <A>(use: (api: Client) => Effect.Effect<A, unknown>) => {
  cookie ??= loginCookie(server(), ADMIN.handle, ADMIN.password)
  return cookie.then((value) => withCookie(server(), value, use))
}

const setup = (human = false) =>
  admin((api) =>
    Effect.gen(function* () {
      yield* api.SetDisplayPrefs({ prefs: { guidance: false } })
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: "Keyboard fixture",
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
      yield* api.SetGenerationDefaults({
        defaults: { model: { connection: connection.id, model: model.id }, preset: null }
      })
      const chat = yield* api.CreateChat({ title: "Keyboard fixture" })
      const sent = human
        ? yield* api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "Human fixture" })
        : null
      yield* api.Generate({
        chatId: chat.id,
        parentSlotId: sent?._tag === "Posted" ? sent.entry.slotId : null,
        branch: false
      })
      return chat
    })
  )

test("Alt+Enter continues without sending or consuming composer text, including guidance", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const chat = await setup()
  await page.goto(`${server().url}/chats/${chat.id}`)
  const reply = page.getByRole("article").last()
  await expect(reply.locator(".markdown").last()).toContainText("The ledger")
  await expect(reply.getByText("generating", { exact: true })).toHaveCount(0, { timeout: 30_000 })
  for (const guidance of [false, true]) {
    if (guidance) await page.getByRole("switch", { name: "Guidance", exact: true }).click()
    const box = page.getByTestId("composer")
    await box.fill("UNSENT SYNTHETIC DRAFT")
    const requests = provider.requests.length
    await box.press("Alt+Enter")
    await expect.poll(() => provider.requests.length).toBe(requests + 1)
    expect(JSON.stringify(provider.requests.at(-1))).not.toContain("UNSENT SYNTHETIC DRAFT")
    expect(provider.requests.at(-1)!.messages.at(-1)!.role).toBe("assistant")
    await expect(box).toHaveValue("UNSENT SYNTHETIC DRAFT")
    await expect(page.getByRole("article")).toHaveCount(1)
    await expect(reply.getByText("generating", { exact: true })).toHaveCount(0, { timeout: 30_000 })
  }
})

test("editing, saving and version arrows share visible actions and ignore typing, IME and dialogs", async ({
  page
}) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const chat = await setup(true)
  await page.goto(`${server().url}/chats/${chat.id}`)
  const box = page.getByTestId("composer")
  const reply = page.getByRole("article").last()
  await expect(reply.locator(".markdown").last()).toContainText("The ledger")
  await expect(reply.getByText("generating", { exact: true })).toHaveCount(0, { timeout: 30_000 })
  await box.fill("typing")
  await box.press("ArrowUp")
  await box.press("Control+ArrowUp")
  await box.press("ArrowRight")
  await expect(page.getByRole("textbox", { name: "Message text", exact: true })).toHaveCount(0)
  await box.fill("")
  await box.dispatchEvent("keydown", { key: "ArrowUp", isComposing: true })
  await expect(page.getByRole("textbox", { name: "Message text", exact: true })).toHaveCount(0)
  await box.press("ArrowUp")
  const editor = page.getByRole("textbox", { name: "Message text", exact: true })
  await expect(editor).toBeVisible()
  await expect(reply.getByRole("button", { name: "Save", exact: true })).toBeVisible()
  await editor.fill("Edited synthetic reply")
  await editor.press("Control+Enter")
  await expect(editor).toHaveCount(0)
  await expect(reply.locator(".markdown").last()).toContainText("Edited synthetic reply")
  await box.press("Control+ArrowUp")
  await expect(
    page.getByRole("article").first().getByRole("textbox", { name: "Message text", exact: true })
  ).toBeVisible()
  await page.getByRole("button", { name: "Cancel", exact: true }).click()
  await box.focus()
  await box.blur()
  await page.keyboard.press("ArrowLeft")
  await expect(reply.locator(".markdown").last()).toContainText("The ledger")
  await page.keyboard.press("ArrowRight")
  await expect(reply.locator(".markdown").last()).toContainText("Edited synthetic reply")
  const requests = provider.requests.length
  await page.keyboard.press("ArrowRight")
  await expect.poll(() => provider.requests.length).toBe(requests + 1)
  await expect(reply.getByText("generating", { exact: true })).toHaveCount(0, { timeout: 30_000 })
  await reply.getByRole("button", { name: /choose a version/ }).click()
  const dialog = page.getByRole("dialog", { name: /Versions of message/ })
  await expect(dialog).toBeVisible()
  await page.keyboard.press("Alt+Enter")
  await expect.poll(() => provider.requests.length).toBe(requests + 1)
  await page.keyboard.press("Escape")
})

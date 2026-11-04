// A delayed account read must not expose the default send behavior in guidance editing.
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { startContinueProvider } from "./support/continueProvider.ts"
import { loginCookie, withCookie } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)

test("guidance editing waits for Enter sends, then obeys Never", async ({ page }) => {
  const provider = await startContinueProvider()
  try {
    const cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
    const { chat, slotId } = await withCookie(server(), cookie, (api) =>
      Effect.gen(function* () {
        const connection = yield* api.CreateConnection({
          kind: "openai-chat",
          settings: {
            name: "Preference readiness",
            baseUrl: provider.baseUrl,
            compat: {},
            cacheTtlS: null,
            maxConcurrent: null,
            presetOverrideRefId: null
          }
        })
        const model = yield* api.AddUserModel({ connectionId: connection.id, key: "native-prefill", overrides: {} })
        yield* api.SetGenerationDefaults({
          defaults: { model: { connection: connection.id, model: model.id }, preset: null }
        })
        yield* api.SetDisplayPrefs({ prefs: { enterSends: "never" } })
        const chat = yield* api.CreateChat({ title: "Preference readiness" })
        const reply = yield* api.Generate({
          chatId: chat.id,
          parentSlotId: null,
          branch: false,
          direction: "Keep the synthetic lantern lit."
        })
        if (reply._tag !== "Posted") throw new Error("Expected a posted fixture reply")
        return { chat, slotId: reply.entry.slotId }
      })
    )
    await expect
      .poll(() =>
        withCookie(server(), cookie, (api) => api.ListVersions({ slotId })).then((all) =>
          all.every((version) => version.status !== "generating")
        )
      )
      .toBe(true)
    const held: Array<() => void> = []
    let hold = true
    await page.routeWebSocket(/\/rpc$/, (socket) => {
      const upstream = socket.connectToServer()
      socket.onMessage((data) => {
        if (hold && typeof data === "string" && JSON.parse(data).tag === "GetDisplayPrefs")
          held.push(() => upstream.send(data))
        else upstream.send(data)
      })
    })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/chats/${chat.id}`)
    await page.getByRole("button", { name: "New version with this guidance", exact: true }).click()
    const box = page.getByTestId("composer")
    const submit = page.getByRole("button", { name: "New version", exact: true })
    await expect.poll(() => held.length).toBeGreaterThan(0)
    await expect(submit).toBeDisabled()
    const requests = provider.requests.length
    await box.press("Control+Enter")
    expect(provider.requests).toHaveLength(requests)
    hold = false
    for (const release of held) release()
    await expect(submit).toBeEnabled()
    await box.fill("A revised direction")
    await box.press("Enter")
    await expect(box).toHaveValue("A revised direction\n")
    expect(provider.requests).toHaveLength(requests)
    await box.press("Control+Enter")
    await expect.poll(() => provider.requests.length).toBe(requests + 1)
    await expect(box).toHaveValue("A revised direction\n")
  } finally {
    await provider.stop()
  }
})

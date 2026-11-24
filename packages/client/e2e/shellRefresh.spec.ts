import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)

test("an expired session in a shell stream returns to login", async ({ page }) => {
  await admin((api) =>
    Effect.forEach(
      Array.from({ length: 101 }, (_, n) => n),
      (n) => api.CreateChat({ title: `Expiry fixture ${n}` }),
      {
        concurrency: 4
      }
    )
  )
  await page.setViewportSize({ width: 1440, height: 900 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(server().url)
  const more = page.getByRole("complementary").first().getByRole("button", { name: "Show 1 more of 1", exact: true })
  await expect(more).toBeVisible()
  // Revoke the session independently, as an expiry or another tab's logout would.
  const response = await page.request.post(`${server().url}/auth/logout`, { headers: { origin: server().url } })
  expect(response.status()).toBe(204)
  await more.click()
  await expect(page).toHaveURL(/\/login/)
})

test("the home sidebar receives edits from another client without refetching the library", async ({ page }) => {
  const started = await admin((api) =>
    Effect.gen(function* () {
      const card = yield* api.CreateCard({ label: "Mira", name: "Mira" })
      return yield* api.StartChat({
        cards: [card.entityId],
        persona: null,
        greeting: null,
        first: { _tag: "Send", content: "Before the edit", speakerEntityId: null }
      })
    })
  )
  await page.setViewportSize({ width: 1440, height: 900 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const requests: Array<string> = []
  page.on("websocket", (socket) => socket.on("framesent", (frame) => requests.push(String(frame.payload))))
  await page.goto(server().url)
  const sidebar = page.getByRole("complementary").first()
  await expect(sidebar.getByText("Before the edit", { exact: true })).toBeVisible()
  const reads = () =>
    requests.filter((frame) => /"(?:GetShellCards|GetShellForks|WatchShellCards|WatchShellForks)"/.test(frame)).length
  const before = reads()
  await admin((api) =>
    Effect.gen(function* () {
      const path = yield* api.ReadPath({
        chatId: started.chat.id,
        forkId: started.chat.currentForkId,
        leafSlotId: null,
        range: { _tag: "Bottom" },
        limit: 1
      })
      const entry = path.entries[0]!
      yield* api.EditVersion({
        slotId: entry.slotId,
        forkId: path.forkId,
        sourceVersionId: entry.version.id,
        expectedRowVersion: entry.rowVersion,
        content: "After the edit"
      })
    })
  )
  await expect(sidebar.getByText("After the edit", { exact: true })).toBeVisible()
  expect(reads()).toBe(before)
  await server().restart()
  await admin((api) => api.RenameChat({ chatId: started.chat.id, name: "Reconnected story" }))
  await expect(sidebar.getByText("Reconnected story", { exact: true })).toBeVisible()
  await expect.poll(reads).toBeGreaterThan(before)
})

test("shell streams resubscribe after transient snapshot errors", async ({ page }) => {
  const chat = await admin((api) =>
    Effect.gen(function* () {
      const card = yield* api.CreateCard({ label: "Retry fixture", name: "Retry fixture" })
      const { chat } = yield* api.StartChat({
        cards: [card.entityId],
        persona: null,
        greeting: null,
        first: { _tag: "Send", content: "Before the transient error", speakerEntityId: null }
      })
      return chat
    })
  )
  const calls = new Map<string, number>()
  await page.routeWebSocket("**/rpc", (socket) => {
    const upstream = socket.connectToServer()
    socket.onMessage((message) => {
      const request = JSON.parse(String(message)) as { tag?: string; id?: string }
      if (request.tag === "WatchShellCards" || request.tag === "WatchShellForks") {
        const attempt = (calls.get(request.tag) ?? 0) + 1
        calls.set(request.tag, attempt)
        if (attempt === 1) {
          socket.send(
            JSON.stringify({
              _tag: "Exit",
              requestId: request.id,
              exit: {
                _tag: "Failure",
                cause: [{ _tag: "Fail", error: { _tag: "ServerError", message: "Synthetic snapshot failure" } }]
              }
            })
          )
          return
        }
      }
      upstream.send(message)
    })
    upstream.onMessage((message) => socket.send(message))
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(server().url)
  await expect.poll(() => calls.get("WatchShellCards")).toBeGreaterThanOrEqual(2)
  await expect.poll(() => calls.get("WatchShellForks")).toBeGreaterThanOrEqual(2)
  const sidebar = page.getByRole("complementary").first()
  await expect(sidebar.getByText("Before the transient error", { exact: true })).toBeVisible()
  await admin((api) => api.RenameChat({ chatId: chat.id, name: "After the transient error" }))
  await expect(sidebar.getByText("After the transient error", { exact: true })).toBeVisible()
})

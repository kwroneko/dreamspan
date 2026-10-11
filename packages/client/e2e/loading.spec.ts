// A page that needs several queries asks for them all at once, not one after another.
import { expect, test } from "@playwright/test"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)

for (const path of ["/settings/keys", "/settings/connections", "/settings/connections/new"]) {
  test(`${path} requests its data together`, async ({ page }) => {
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const events: Array<string> = []
    const tags = new Map<string, string>()
    page.on("websocket", (socket) => {
      socket.on("framesent", ({ payload }) => {
        const message = JSON.parse(String(payload)) as { _tag: string; id?: string; tag?: string }
        if (message._tag !== "Request") return
        tags.set(message.id!, message.tag!)
        events.push(`request ${message.tag}`)
      })
      socket.on("framereceived", ({ payload }) => {
        const message = JSON.parse(String(payload)) as { _tag: string; requestId?: string }
        if (message._tag === "Exit") events.push(`reply ${tags.get(message.requestId!)}`)
      })
    })
    await page.goto(`${server().url}${path}`)
    await expect(page.getByRole("heading", { level: 2 }).first()).toBeVisible()
    await expect(page.getByRole("status").filter({ hasText: "Loading" })).toHaveCount(0)

    const data = ["ListProviderKinds", "ListConnections", "ListCredentials"]
    const firstReply = events.findIndex((event) => data.some((tag) => event === `reply ${tag}`))
    const requestedBefore = events.slice(0, firstReply).filter((event) => event.startsWith("request "))
    expect(requestedBefore).toEqual(expect.arrayContaining(data.map((tag) => `request ${tag}`)))
  })
}

import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { showActions } from "./support/message.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)

for (const mode of ["selected", "unselected", "racing"] as const) {
  test(`${mode}: a cached human version can be saved after another tab amends it`, async ({ page }) => {
    const { chat, entry } = await admin((api) =>
      Effect.gen(function* () {
        const chat = yield* api.CreateChat({ title: "Concurrent human amendment" })
        const posted = yield* api.SendMessage({
          chatId: chat.id,
          parentSlotId: null,
          branch: false,
          content: "Human first version"
        })
        if (posted._tag !== "Posted") throw new Error("expected a posted message")
        const entry = yield* api.WriteVersion({
          slotId: posted.entry.slotId,
          content: "Human second version",
          expectedRowVersion: posted.entry.rowVersion
        })
        return { chat, entry }
      })
    )
    const amendments: Array<{ expectedRowVersion: number }> = []
    let receivedAmendment = false
    await page.routeWebSocket(/\/rpc$/, (socket) => {
      const upstream = socket.connectToServer()
      socket.onMessage(async (data) => {
        if (typeof data === "string") {
          const frame = JSON.parse(data)
          if (frame.tag === "AmendVersion") {
            amendments.push(frame.payload)
            if (mode === "racing" && amendments.length === 1) {
              await admin((api) =>
                api.AmendVersion({
                  versionId: entry.version.id,
                  content: "Another amendment after the source refresh",
                  expectedRowVersion: entry.version.rowVersion + 1
                })
              )
            }
          }
        }
        upstream.send(data)
      })
      upstream.onMessage((data) => {
        if (typeof data === "string" && data.includes("Other tab amended this human version")) receivedAmendment = true
        socket.send(data)
      })
    })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/chats/${chat.id}`)
    const row = page.locator(`article[data-slot="${entry.slotId}"]`)
    await expect(row.getByRole("group", { name: "Versions", exact: true })).toContainText("2/2")
    await showActions(row)
    await row.getByRole("button", { name: "Edit", exact: true }).click()
    const box = row.getByLabel("Message text", { exact: true })
    const text = "Local draft after concurrent amendment"
    await box.fill(text)
    await expect.poll(async () => (await admin((api) => api.MessageDrafts({ chatId: chat.id })))[0]?.content).toBe(text)
    if (mode === "unselected") {
      const versions = await admin((api) => api.ListVersions({ slotId: entry.slotId }))
      await admin((api) =>
        api.SelectVersion({ slotId: entry.slotId, versionId: versions[0]!.id, expectedVersionId: entry.version.id })
      )
      await expect(row.getByRole("note")).toContainText("Another version is selected")
    }
    await admin((api) =>
      api.AmendVersion({
        versionId: entry.version.id,
        content: "Other tab amended this human version",
        expectedRowVersion: entry.version.rowVersion
      })
    )
    await expect.poll(() => receivedAmendment).toBe(true)
    await row.getByRole("button", { name: "Save", exact: true }).click()
    await expect.poll(() => amendments.length).toBe(1)
    // Repeat the verifier's retry when the initial Save hits its stale cache.
    if (mode === "racing" || amendments[0]!.expectedRowVersion === entry.version.rowVersion) {
      await expect(row.getByRole("alert")).toBeVisible()
      await row.getByRole("button", { name: "Save", exact: true }).click()
      await expect.poll(() => amendments.length).toBe(2)
    }
    console.log(JSON.stringify({ amendments, receivedAmendment }))
    expect(amendments.map((a) => a.expectedRowVersion)).toEqual(
      mode === "racing" ? [entry.version.rowVersion + 1, entry.version.rowVersion + 2] : [entry.version.rowVersion + 1]
    )
    await expect(box).toHaveCount(0)
    await expect(row.locator(".markdown")).toHaveText(mode === "unselected" ? "Human first version" : text)
    const versions = await admin((api) => api.ListVersions({ slotId: entry.slotId }))
    expect(versions).toHaveLength(2)
    expect(versions.find((v) => v.id === entry.version.id)?.rowVersion).toBe(
      entry.version.rowVersion + (mode === "racing" ? 3 : 2)
    )
    expect(versions.find((v) => v.id === entry.version.id)?.content).toBe(text)
  })
}

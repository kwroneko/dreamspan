import { expectTextBox } from "./support/textbox.ts"
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { card, header, jsonl, message } from "../../server/test/support/stFolder.ts"
import { showActions } from "./support/message.ts"
import { asUser, loginCookie } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)

for (const width of [1440, 390]) {
  for (const state of ["saved", "in-flight"] as const) {
    test(`${width}: ST re-import keeps a ${state} message edit visible and attached to its source`, async ({
      page
    }) => {
      const cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
      const tag = `Editing ${width} ${state}`
      const upload = async (messages: ReadonlyArray<unknown>) => {
        const run = await admin((api) => api.StartStImport({ unsupported: [] }))
        for (const [path, body] of new Map([
          ["characters/Alice.png", card("Alice", "Synthetic greeting")],
          [`chats/Alice/${tag}.jsonl`, jsonl([header({}), ...messages])]
        ])) {
          const response = await fetch(
            `${server().url}/st-import/file?${new URLSearchParams({ import: run.importId, path })}`,
            {
              method: "POST",
              headers: { cookie, "content-type": "application/octet-stream" },
              body: new Uint8Array(body)
            }
          )
          expect(response.status).toBe(200)
        }
      }
      const original = Array.from({ length: 10 }, (_, i) =>
        message({
          name: i % 2 ? "Sam" : "Alice",
          user: !!(i % 2),
          mes: `Turn ${i}`,
          minute: i,
          ...(!(i % 2) ? { swipes: [`Turn ${i}`] } : {})
        })
      )
      await upload(original)
      const { chat, target } = await admin((api) =>
        Effect.gen(function* () {
          const chat = (yield* api.ListChats({ limit: 100, before: null })).find((c) => c.title === tag)!
          const path = yield* api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 100 })
          return { chat, target: path.entries[4]! }
        })
      )
      let release: (() => void) | null = null
      let hold = state === "in-flight"
      if (hold)
        await page.routeWebSocket(/\/rpc$/, (socket) => {
          const upstream = socket.connectToServer()
          socket.onMessage((data) => {
            if (hold && typeof data === "string" && JSON.parse(data).tag === "SaveMessageDraft")
              release = () => upstream.send(data)
            else upstream.send(data)
          })
        })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.goto(`${server().url}/chats/${chat.id}?slot=${target.slotId}`)
      const row = page.locator(`article[data-slot="${target.slotId}"]`)
      await showActions(row)
      await row.getByRole("button", { name: "Edit", exact: true }).click()
      const pending = "An irreplaceable in-progress edit while ST is reimported"
      const box = row.getByLabel("Message text", { exact: true })
      await box.fill(pending)
      if (state === "saved")
        await expect
          .poll(async () => (await admin((api) => api.MessageDrafts({ chatId: chat.id })))[0]?.content)
          .toBe(pending)
      else {
        await expect.poll(() => release !== null).toBe(true)
        expect(await admin((api) => api.MessageDrafts({ chatId: chat.id }))).toEqual([])
      }
      const edited = {
        ...original[4]!,
        mes: "ST overwrote the selected text",
        swipes: ["ST overwrote the selected text"],
        extra: { ...original[4]!.extra, bias: null }
      }
      original[4] = edited
      await upload(original)
      await expect
        .poll(
          async () =>
            (
              await admin((api) =>
                api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 100 })
              )
            ).entries[4]!.version.content
        )
        .toBe("ST overwrote the selected text")
      await expectTextBox(box, pending)
      await expect(
        row.getByText("Another swipe is selected. Your edit still belongs to the swipe you opened.")
      ).toBeVisible()
      if (state === "in-flight") {
        hold = false
        release!()
        await expect
          .poll(async () => (await admin((api) => api.MessageDrafts({ chatId: chat.id })))[0]?.content)
          .toBe(pending)
      }
      await page.reload()
      await expectTextBox(box, pending)
      // A restored edit must also remain visible during a second re-import, even
      // while the new version list cannot be fetched. Hold that RPC explicitly.
      const releaseVersions: Array<() => void> = []
      let holdVersions = true
      await page.routeWebSocket(/\/rpc$/, (socket) => {
        const upstream = socket.connectToServer()
        socket.onMessage((data) => {
          if (holdVersions && typeof data === "string" && JSON.parse(data).tag === "ListVersions")
            releaseVersions.push(() => upstream.send(data))
          else upstream.send(data)
        })
      })
      // The route applies to the next socket; reopening also restores the draft.
      await page.reload()
      // Let the initial version read establish the restored editor's association.
      await expect.poll(() => releaseVersions.length).toBeGreaterThan(0)
      holdVersions = false
      for (const release of releaseVersions.splice(0)) release()
      await expectTextBox(box, pending)
      holdVersions = true
      const editedAgain = { ...original[4]!, mes: "ST edited again", swipes: ["ST edited again"] }
      original[4] = editedAgain
      await upload(original)
      await expect.poll(() => releaseVersions.length).toBeGreaterThan(0)
      await expectTextBox(box, pending)
      await expect(
        row.getByText("Another swipe is selected. Your edit still belongs to the swipe you opened.")
      ).toBeVisible()
      holdVersions = false
      for (const release of releaseVersions.splice(0)) release()
      if (state === "saved") {
        await row.getByRole("button", { name: "Save", exact: true }).click()
        await expect(box).toHaveCount(0)
        await expect(row.locator(".markdown")).toHaveText(pending)
        const versions = await admin((api) => api.ListVersions({ slotId: target.slotId }))
        expect(versions.find((v) => v.content === pending)?.sourceVersionId).toBe(target.version.id)
        expect(versions.map((v) => v.content)).toContain("ST overwrote the selected text")
      } else {
        await row.getByRole("button", { name: "Cancel", exact: true }).click()
        await expect(box).toHaveCount(0)
        await expect(row.locator(".markdown")).toHaveText("ST edited again")
        // Since smallfixes3, Cancel keeps the cancelled text one step back in the edit's history
        // rather than sending it to the bin.
        const states = await admin((api) =>
          api.MessageDraftHistory({ target: { _tag: "Edit", versionId: target.version.id }, limit: 100 })
        )
        expect(states.map((s) => s.length)).toContain(pending.length)
      }
    })
  }
}

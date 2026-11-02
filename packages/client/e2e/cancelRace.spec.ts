// Text typed while a message's or a summary's edit is being cancelled wasn't cancelled: the
// edit stays open with it, and its browser copy stays until the server has it (DESIGN §6.2),
// even when the saves after the cancel fail.
import { expect, test, type Page } from "@playwright/test"
import type { SlotId } from "@rp/shared/chat.ts"
import type { SendResult } from "@rp/shared/chatApi.ts"
import { Effect } from "effect"
import type { Copy } from "../src/features/editor/backup.ts"
import { messageMenu } from "./support/message.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { expectTextBox } from "./support/textbox.ts"
import { condensed, level1 } from "./support/summaries.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "60", FAKE_GENERATOR_TOKENS: "80" })
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)

const copies = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<Array<Copy>>((resolve) => {
        const open = indexedDB.open("rp-editor-copies", 1)
        open.onsuccess = () => {
          const db = open.result
          const all = db.transaction("copies").objectStore("copies").getAll()
          all.onsuccess = () => {
            resolve(all.result as Array<Copy>)
            db.close()
          }
        }
      })
  )

const chatWithMessage = () =>
  admin((api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title: "Cancel race" })
      const sent = yield* api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "A turn." })
      if (sent._tag !== "Posted") throw new Error("queued")
      return { chat, slotId: sent.entry.slotId as SlotId }
    })
  )

const chatWithSummary = async () => {
  const { chat, entries } = await admin((api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title: "Cancel race summary" })
      let parent: SlotId | null = null
      for (let i = 0; i < 12; i++) {
        const sent: SendResult = yield* api.SendMessage({
          chatId: chat.id,
          parentSlotId: parent,
          branch: false,
          content: `Message ${i}.`
        })
        if (sent._tag !== "Posted") throw new Error("queued")
        parent = sent.entry.slotId
      }
      const path = yield* api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 100 })
      return { chat, entries: path.entries }
    })
  )
  const first = await level1(server().dataDir, chat.id, entries.slice(0, 4), "Summary one.")
  const second = await level1(server().dataDir, chat.id, entries.slice(4, 8), "Summary two.")
  const top = await condensed(server().dataDir, chat.id, [first, second], "The condensed summary.")
  return { chat, top }
}

for (const kind of ["message", "summary"] as const) {
  test(`${kind}: text typed while the edit is being cancelled keeps it open, through failed saves`, async ({
    page
  }) => {
    const discard = kind === "summary" ? "DiscardSummaryDraft" : "DiscardMessageDraft"
    const saveTag = kind === "summary" ? "SaveSummaryDraft" : "SaveMessageDraft"
    let release: (() => void) | undefined
    let failSaves = false
    let refused = 0
    await page.routeWebSocket(/\/rpc$/, (socket) => {
      const upstream = socket.connectToServer()
      socket.onMessage((data) => {
        const request = typeof data === "string" ? (JSON.parse(data) as { tag?: string; id?: string }) : null
        if (request?.tag === discard) {
          release = () => upstream.send(data)
          return
        }
        if (request?.tag === saveTag && failSaves) {
          refused++
          socket.send(
            JSON.stringify({
              _tag: "Exit",
              requestId: request.id,
              exit: { _tag: "Failure", cause: [{ _tag: "Fail", error: { _tag: "ServerError", message: "Refused" } }] }
            })
          )
          return
        }
        upstream.send(data)
      })
      upstream.onMessage((data) => socket.send(data))
    })
    await page.setViewportSize({ width: 1280, height: 800 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    let box
    let cancel
    if (kind === "summary") {
      const { chat, top } = await chatWithSummary()
      await page.goto(`${server().url}/chats/${chat.id}`)
      await page.getByTestId("lcm-boundary").click()
      const panel = page.getByRole("tabpanel", { name: "Summaries" })
      await panel
        .locator(`[data-summary="${top.id}"]`)
        .getByRole("button", { name: /Edit the summary of messages 1–8/ })
        .click()
      box = panel.getByRole("textbox", { name: /Text of the summary of messages 1–8/ })
      cancel = panel.getByRole("button", { name: "Discard the summary edit", exact: true })
    } else {
      const { chat, slotId } = await chatWithMessage()
      await page.goto(`${server().url}/chats/${chat.id}`)
      const message = page.locator(`article[data-slot="${slotId}"]`)
      await messageMenu(message, "Write your own version")
      box = message.getByLabel("Your version", { exact: true })
      cancel = message.getByRole("button", { name: "Cancel", exact: true })
    }
    await expect(box).toBeEnabled()
    await box.fill(`The ${kind} text cancelled.`)
    // Kept by the server before Cancel, so Cancel keeps it: one step back in a summary edit's
    // history, or in the recovered texts for a written version.
    await page.waitForTimeout(1200)
    await cancel.click()
    await expect.poll(() => release !== undefined).toBe(true)
    failSaves = true
    const later = `The ${kind} text typed after Cancel.`
    await box.fill(later)
    await expect.poll(async () => (await copies(page)).map((copy) => copy.content)).toContain(later)
    release!()
    await expect.poll(() => refused).toBeGreaterThan(0)
    await expectTextBox(box, later)
    await expect.poll(async () => (await copies(page)).map((copy) => copy.content)).toContain(later)
  })
}

import { test, expect } from "@playwright/test"
import { Effect } from "effect"
import { asUser } from "./support/rpc.ts"
import { messageMenu } from "./support/message.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { expectTextBox } from "./support/textbox.ts"
const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "60", FAKE_GENERATOR_TOKENS: "600" })
test("hide and unhide during a streamed reply preserve its text and the composer draft", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const chat = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title: "Streaming visibility review" })
      const sent = yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: null,
        branch: false,
        content: "Tell a story."
      })
      if (sent._tag !== "Posted") return yield* Effect.die("unexpected queue")
      yield* api.Generate({ chatId: chat.id, parentSlotId: sent.entry.slotId, branch: false })
      return chat
    })
  )
  await page.goto(`${server().url}/chats/${chat.id}`)
  const reply = page.getByRole("article", { name: "Reply", exact: true }).last()
  await expect(reply.getByText("generating", { exact: true })).toBeVisible()
  await page.getByLabel("Message", { exact: true }).fill("The next turn, still being drafted.")
  await messageMenu(reply, "Hide from the model")
  await expect(reply).toHaveAttribute("data-hidden", "true")
  await expect(reply.getByText("generating", { exact: true })).toBeVisible()
  await messageMenu(reply, "Show to the model again")
  await expect(reply).not.toHaveAttribute("data-hidden")
  await expect(reply.getByText("generating", { exact: true })).toHaveCount(0, { timeout: 20000 })
  const completed = await reply.locator(".markdown").innerText()
  expect(completed.length).toBeGreaterThan(0)
  await expect(page.locator("article[data-slot]")).toHaveCount(2)
  await page.reload()
  await expect.poll(() => reply.locator(".markdown").innerText()).toBe(completed)
  await expectTextBox(page.getByLabel("Message", { exact: true }), "The next turn, still being drafted.")
})

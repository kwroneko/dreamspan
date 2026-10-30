// A touch swipe on a message steps through its versions; a drag in its editor, on a control,
// while it's being edited, after a cancelled pointer or one that selected text doesn't (parity 2).
import { expect, type Locator, test } from "@playwright/test"
import { Effect } from "effect"
import { showActions } from "./support/message.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)

const drag = async (target: Locator, from: number, to: number, cancel = false) => {
  await target.dispatchEvent("pointerdown", { pointerType: "touch", clientX: from, clientY: 400, pointerId: 1 })
  if (cancel) await target.dispatchEvent("pointercancel", { pointerType: "touch", pointerId: 1 })
  await target.dispatchEvent("pointerup", { pointerType: "touch", clientX: to, clientY: 400, pointerId: 1 })
}

test("touch swipes step versions, but never from the editor, a control or a cancelled pointer", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const { chat, slotId } = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title: "Synthetic gestures" })
      const sent = yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: null,
        branch: false,
        content: "First take."
      })
      if (sent._tag !== "Posted") return yield* Effect.die("unexpected queue")
      yield* api.WriteVersion({
        slotId: sent.entry.slotId,
        content: "Second take.",
        expectedRowVersion: sent.entry.rowVersion
      })
      return { chat, slotId: sent.entry.slotId }
    })
  )
  const selected = () =>
    asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
      api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 10 })
    ).then((path) => path.entries.find((e) => e.slotId === slotId)!.version.content)
  await page.goto(`${server().url}/chats/${chat.id}`)
  const message = page.locator(`article[data-slot="${slotId}"]`)
  await expect(message.locator(".markdown").last()).toHaveText("Second take.")

  // A cancelled pointer (the page scrolled) is no swipe.
  await drag(message.locator(".markdown").last(), 120, 260, true)
  await page.waitForTimeout(300)
  expect(await selected()).toBe("Second take.")

  // A swipe on the text steps back.
  await drag(message.locator(".markdown").last(), 120, 260)
  await expect(message.locator(".markdown").last()).toHaveText("First take.")
  expect(await selected()).toBe("First take.")

  // A drag on a control is no swipe. (A real swipe's click follows its pointerup; the
  // synthetic one has none, so the first tap only clears the swipe.)
  await expect(async () => {
    await showActions(message)
    await expect(message.getByRole("button", { name: "Edit", exact: true })).toBeVisible({ timeout: 1000 })
  }).toPass()
  await drag(message.getByRole("button", { name: "Edit", exact: true }), 260, 120)
  await page.waitForTimeout(300)
  expect(await selected()).toBe("First take.")

  // Nor is one in the editor, nor anywhere on the message while it's being edited.
  await message.getByRole("button", { name: "Edit", exact: true }).click()
  const editor = message.getByLabel("Message text")
  await expect(editor).toBeVisible()
  await drag(editor, 120, 260)
  await drag(message.locator(".cm-content"), 120, 260)
  await drag(message, 120, 260)
  await page.waitForTimeout(300)
  expect(await selected()).toBe("First take.")
  await expect(editor).toBeVisible()
  await expect(editor).toContainText("First take.")
  await message.getByRole("button", { name: "Cancel", exact: true }).click()

  // A drag that selected text is no swipe either.
  await page.evaluate((slot) => {
    const text = document.querySelector(`article[data-slot="${slot}"] .markdown`)!
    window.getSelection()!.selectAllChildren(text)
  }, slotId)
  await drag(message.locator(".markdown").last(), 260, 120)
  await page.waitForTimeout(300)
  expect(await selected()).toBe("First take.")
})

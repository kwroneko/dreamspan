import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { showActions } from "./support/message.ts"
import { asPage } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile({
  ...withAdmin,
  FAKE_GENERATOR_TPS: "100",
  FAKE_GENERATOR_TOKENS: "3000",
  FAKE_GENERATOR_BURST_MS: "700",
  FAKE_GENERATOR_SEED: "17"
})
const prompt = (page: Page) => page.getByRole("article", { name: "Your message" }).filter({ hasText: "Go on." })
const menu = (page: Page) => page.getByRole("menu", { name: "More actions" })

const cases = [
  { name: "Escape resumes following", width: 1440, close: "escape" },
  { name: "deleting the menu's message resumes following", width: 1440, close: "delete" },
  { name: "deleting the menu's message resumes following", width: 390, close: "delete" },
  { name: "deleting the menu's message respects scrolling away", width: 1440, close: "scroll then delete" }
] as const

for (const { name, width, close } of cases) {
  test(`${name} during a stream at ${width}px`, async ({ page, context }) => {
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const { chatId, slotId } = await asPage(page, server(), (api) =>
      Effect.gen(function* () {
        const chat = yield* api.CreateChat({ title: "Streaming message menu" })
        let parentSlotId = null
        if (close === "scroll then delete") {
          const history = yield* api.SendMessage({
            chatId: chat.id,
            parentSlotId: null,
            branch: false,
            content: "The lights went out along the quay.\n\n".repeat(25)
          })
          if (history._tag !== "Posted") return yield* Effect.die("unexpected queue")
          parentSlotId = history.entry.slotId
        }
        const sent = yield* api.SendMessage({
          chatId: chat.id,
          parentSlotId,
          branch: false,
          content: "Go on."
        })
        if (sent._tag !== "Posted") return yield* Effect.die("unexpected queue")
        return { chatId: chat.id, slotId: sent.entry.slotId }
      })
    )
    const url = `${server().url}/chats/${chatId}`
    const peer = close === "escape" ? null : await context.newPage()
    if (peer) {
      await peer.goto(url)
      await expect(prompt(peer)).toBeVisible()
    }
    await page.setViewportSize({ width, height: 850 })
    await page.goto(url)
    await expect(prompt(page)).toBeVisible()

    const list = page.getByTestId("messages")
    const offset = () => list.evaluate((node) => node.scrollTop)
    const height = () => list.evaluate((node) => node.scrollHeight)
    const fromEnd = () => list.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight)
    await expect.poll(fromEnd).toBeLessThanOrEqual(1)
    const start = await offset()
    await asPage(page, server(), (api) => api.Generate({ chatId, parentSlotId: slotId, branch: false }))
    const generating = page.getByRole("article", { name: "Reply" }).getByText("generating", { exact: true })
    await expect(generating).toBeVisible()
    if (close === "scroll then delete") {
      // Move the prompt up enough to scroll back while its trigger stays in view.
      await expect.poll(offset).toBeGreaterThan(start + 160)
    }
    await showActions(prompt(page))
    await expect.poll(fromEnd).toBeLessThanOrEqual(1)
    await prompt(page).getByRole("button", { name: "More actions" }).click()
    await expect(menu(page)).toBeVisible()
    await expect.poll(fromEnd).toBeGreaterThan(220)
    await expect(menu(page)).toBeVisible()

    if (close === "scroll then delete") {
      const beforeScroll = await offset()
      const box = (await list.boundingBox())!
      await page.mouse.move(box.x + 12, box.y + box.height / 2)
      await page.mouse.wheel(0, -100)
      await expect.poll(offset).toBeLessThan(beforeScroll - 70)
      await expect(menu(page)).toBeVisible()
    }

    if (peer) {
      await showActions(prompt(peer))
      await prompt(peer).getByRole("button", { name: "Delete message", exact: true }).click()
      await expect(prompt(page)).toHaveCount(0)
    } else {
      await page.keyboard.press("Escape")
    }
    await expect(menu(page)).toHaveCount(0)
    if (close !== "scroll then delete") await expect.poll(fromEnd).toBeLessThanOrEqual(1)

    // Check the next growth too, while the reply is still streaming.
    const closedHeight = await height()
    await expect.poll(height).toBeGreaterThan(closedHeight + 60)
    await expect(generating).toBeVisible()
    if (close === "scroll then delete") await expect.poll(fromEnd).toBeGreaterThan(120)
    else await expect.poll(fromEnd).toBeLessThanOrEqual(1)
  })
}

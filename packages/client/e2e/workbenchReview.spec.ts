import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import type { SlotId } from "@dreamspan/shared/chat.ts"
import type { SendResult } from "@dreamspan/shared/chatApi.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { openPanel, panelTab } from "./support/panel.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "20", FAKE_GENERATOR_TOKENS: "200" })

test("two views keep their composer labels, drafts and panels independent while messages stay in sync", async ({
  page
}) => {
  test.setTimeout(150_000)
  const chat = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const card = yield* api.CreateCard({ label: "Review traveler", name: "Traveler" })
      const chat = yield* api.CreateChat({ title: "Two views" })
      yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: card.entityId } })
      let parent: SlotId | null = null
      for (let i = 0; i < 60; i++) {
        const sent: SendResult = yield* api.SendMessage({
          chatId: chat.id,
          parentSlotId: parent,
          branch: false,
          content: `Review message ${i}. ${"A synthetic traveler follows the river toward the harbor. ".repeat(12)}`,
          reply: false
        })
        if (sent._tag === "Posted") parent = sent.entry.slotId
      }
      return chat
    })
  )
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto(`${server().url}/chats/${chat.id}`)
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeEditable({ timeout: 60_000 })
  await openPanel(page, "This chat")
  await page.getByRole("button", { name: "Split right", exact: true }).click()
  const frames = page.locator("[data-frame]")
  const left = frames.first()
  const right = frames.nth(1)
  const a = left.getByRole("textbox", { name: "Message", exact: true })
  const b = right.getByRole("textbox", { name: "Message", exact: true })
  await expect(b).toBeEditable()
  // Each screen-reader description belongs to its own composer, including guidance mode.
  const ids = await page
    .locator('[data-testid="composer"]')
    .evaluateAll((boxes) => boxes.map((box) => ({ id: box.id, hint: box.getAttribute("aria-describedby") })))
  expect(new Set(ids.map((box) => box.id)).size).toBe(2)
  expect(new Set(ids.map((box) => box.hint)).size).toBe(2)
  await panelTab(page, "Notes")
  await a.fill("Left view draft")
  await expect(page.getByRole("tabpanel", { name: "This chat", exact: true })).toBeVisible()
  await b.fill("Right view draft")
  await expect(page.getByRole("tabpanel", { name: "Notes", exact: true })).toBeVisible()
  await expect(a).toHaveValue("Left view draft")
  await expect(b).toHaveValue("Right view draft")
  await expect(page.locator("[data-tab] [data-unsaved-dot]")).toHaveCount(0)
  const rightTop = await right.getByTestId("messages").evaluate((element) => element.scrollTop)
  const leftTop = await left.getByTestId("messages").evaluate((element) => element.scrollTop)
  await left.getByTestId("messages").evaluate((element) => {
    element.scrollTop -= 300
  })
  await expect
    .poll(() => left.getByTestId("messages").evaluate((element) => element.scrollTop))
    .toBeLessThan(leftTop - 100)
  expect(await right.getByTestId("messages").evaluate((element) => element.scrollTop)).toBeCloseTo(rightTop, 0)
  await left.getByTestId("messages").evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  await right.getByRole("button", { name: "Send", exact: true }).click()
  await expect(left.getByRole("article").filter({ hasText: "Right view draft" })).toHaveCount(1)
  await expect(right.getByRole("article").filter({ hasText: "Right view draft" })).toHaveCount(1)
  // Both subscriptions display the same generated reply. Closing a view must preserve it.
  await expect
    .poll(async () => {
      const text = await left.locator("article[data-slot] .markdown").last().innerText()
      return text.length
    })
    .toBeGreaterThan(100)
  await expect(left.getByRole("button", { name: "Stop", exact: true })).toBeVisible()
  await right.getByRole("button", { name: "Stop", exact: true }).click()
  await expect(left.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0)
  await expect(right.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0)
  const text = await left.locator("article[data-slot] .markdown").last().innerText()
  await expect(right.locator("article[data-slot] .markdown").last()).toHaveText(text, { useInnerText: true })
  await right
    .locator("article[data-slot]")
    .last()
    .getByRole("button", { name: "Generate another version", exact: true })
    .click()
  await expect(
    left.locator("article[data-slot]").last().getByRole("group", { name: "Versions", exact: true })
  ).toContainText("2/2")
  await expect(right.getByRole("button", { name: "Stop", exact: true })).toBeVisible()
  await left.getByRole("button", { name: "Close Two views", exact: true }).click()
  await expect(frames).toHaveCount(1)
  await expect(right).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Stop", exact: true }).click()
  if (process.env.LAYOUT_AUDIT) await expectLayout(page, test.info(), "review-single-view")
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.locator("[data-frame]")).toHaveCount(1)
  await page
    .getByRole("dialog", { name: "Two views", exact: true })
    .getByRole("button", { name: "Close", exact: true })
    .click()
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeEditable()
})

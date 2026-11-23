// Long guidance under a reply (owner, 2026-11-23): it folds to three lines with Show more,
// unfolds with Show less, and short guidance has neither; the edit button stays beside it.
import { expect, type Locator, test } from "@playwright/test"
import type { EntityId, SlotId } from "@dreamspan/shared/chat.ts"
import { Effect } from "effect"
import { startProvider, type FakeProvider } from "./support/provider.ts"
import { type Client, loginCookie, withCookie } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { expectLayout } from "./support/layoutAudit.ts"

const server = serverPerFile(withAdmin)
let provider: FakeProvider
let cookie: string
const rpc = <A>(run: (api: Client) => Effect.Effect<A, unknown>) => withCookie(server(), cookie, run)
test.beforeAll(async () => {
  cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
  provider = await startProvider()
  await rpc((api) =>
    Effect.gen(function* () {
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: "Synthetic long guidance",
          baseUrl: provider.baseUrl,
          compat: {},
          cacheTtlS: 300,
          maxConcurrent: null,
          presetOverrideRefId: null
        },
        apiKey: "synthetic"
      })
      yield* api.RefreshModels({ connectionId: connection.id })
      const models = yield* api.ListModels({ connectionId: connection.id, includeHidden: false })
      yield* api.SetGenerationDefaults({
        defaults: { model: { connection: connection.id, model: models[0]!.id }, preset: null }
      })
    })
  )
})
test.afterAll(async () => {
  await provider?.stop()
})

const SHORT = "Aria looks out to sea."
const LONG = Array.from(
  { length: 12 },
  (_, i) => `Step ${i + 1}: Aria notices another small detail of the harbor and describes it slowly.`
).join(" ")

/** Sam's line, Aria's reply with short guidance, then Aria's next reply with long guidance. */
const harbor = () =>
  rpc((api) =>
    Effect.gen(function* () {
      const aria = (yield* api.CreateCard({ label: "Aria", name: "Aria" })).entityId as EntityId
      const sam = (yield* api.CreateCard({ label: "Sam", name: "Sam" })).entityId
      const chat = yield* api.CreateChat({ title: "Harbor, long guidance" })
      for (const id of [aria, sam])
        yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: id } })
      yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "PlayedByMe", entityIds: [sam] } })
      const sent = yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: null,
        branch: false,
        content: "Sam ties the boat to the dock.",
        speakerEntityId: sam
      })
      if (sent._tag !== "Posted") throw new Error("Expected a posted message")
      const short = yield* api.Generate({
        chatId: chat.id,
        parentSlotId: sent.entry.slotId,
        branch: false,
        speakerEntityId: aria,
        direction: SHORT
      })
      if (short._tag !== "Posted") throw new Error("Expected a posted reply")
      return { chatId: chat.id, aria, shortSlot: short.entry.slotId }
    })
  )

const settled = (slotId: SlotId) =>
  expect
    .poll(async () => {
      const all = await rpc((api) => api.ListVersions({ slotId }))
      return all.length > 0 && all.every((v) => v.status !== "generating")
    })
    .toBe(true)

const lineCount = (paragraph: Locator) =>
  paragraph.evaluate((p) => Math.round(p.clientHeight / parseFloat(getComputedStyle(p).lineHeight)))

for (const width of [1440, 390]) {
  for (const theme of ["light", "dark"] as const) {
    test(`long guidance folds to three lines with Show more, short has none (${width}px, ${theme})`, async ({
      page
    }, info) => {
      const { chatId, aria, shortSlot } = await harbor()
      await settled(shortSlot)
      const long = await rpc((api) =>
        api.Generate({ chatId, parentSlotId: shortSlot, branch: false, speakerEntityId: aria, direction: LONG })
      )
      if (long._tag !== "Posted") throw new Error("Expected a posted reply")
      await settled(long.entry.slotId)

      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/chats/${chatId}`)

      const shortRow = page.locator(`article[data-slot="${shortSlot}"]`).getByTestId("message-direction")
      const longRow = page.locator(`article[data-slot="${long.entry.slotId}"]`).getByTestId("message-direction")
      await expect(shortRow).toContainText(SHORT)
      await expect(longRow).toBeVisible()

      // Short guidance: one line, no toggle, the edit button.
      await expect(shortRow.getByRole("button", { name: /^Show (more|less)/ })).toHaveCount(0)
      await expect(shortRow.getByRole("button", { name: "Edit this guidance", exact: true })).toBeVisible()

      // Long guidance: three lines and Show more, the edit button beside it.
      const text = longRow.locator("p")
      const more = longRow.getByRole("button", { name: "Show more of this guidance", exact: true })
      const edit = longRow.getByRole("button", { name: "Edit this guidance", exact: true })
      await expect(more).toBeVisible()
      await expect(more).toHaveAttribute("aria-expanded", "false")
      await expect(edit).toBeVisible()
      expect(await lineCount(text)).toBe(3)
      await longRow.scrollIntoViewIfNeeded()
      await expectLayout(page, info, `long guidance folded ${width} ${theme}`, {
        scope: '[data-testid="message-direction"]'
      })

      // Show more: all of it, Show less, the edit button still there.
      await more.click()
      const less = longRow.getByRole("button", { name: "Show less of this guidance", exact: true })
      await expect(less).toBeVisible()
      await expect(less).toHaveAttribute("aria-expanded", "true")
      expect(await lineCount(text)).toBeGreaterThan(3)
      await expect(edit).toBeVisible()
      await longRow.scrollIntoViewIfNeeded()
      await expectLayout(page, info, `long guidance open ${width} ${theme}`, {
        scope: '[data-testid="message-direction"]'
      })

      // Show less folds it again.
      await less.click()
      await expect(more).toBeVisible()
      expect(await lineCount(text)).toBe(3)
    })
  }
}

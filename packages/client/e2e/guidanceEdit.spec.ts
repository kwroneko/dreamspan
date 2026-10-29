// Guidance on swipes (DESIGN §2.2, owner 2026-10-29): Edit on a reply's guidance puts it in
// the composer under a bar; each submit is a new version of that reply with the box's text,
// which stays; ✕ gives back the draft typed before, which a reload also shows.
import { mkdirSync } from "node:fs"
import { expect, type Page, test } from "@playwright/test"
import type { ChatId, EntityId, SlotId } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import { startProvider, type FakeProvider } from "./support/provider.ts"
import { type Client, loginCookie, withCookie } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

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
          name: "Synthetic guidance",
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

/** A chat with Sam (played) and Aria: Sam's line, then Aria's reply written with guidance. */
const harbor = () =>
  rpc((api) =>
    Effect.gen(function* () {
      const aria = (yield* api.CreateCard({ label: "Aria", name: "Aria" })).entityId
      const sam = (yield* api.CreateCard({ label: "Sam", name: "Sam" })).entityId
      const chat = yield* api.CreateChat({ title: "Harbor at dusk" })
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
      const reply = yield* api.Generate({
        chatId: chat.id,
        parentSlotId: sent.entry.slotId,
        branch: false,
        speakerEntityId: aria as EntityId,
        direction: "Aria looks out to sea."
      })
      if (reply._tag !== "Posted") throw new Error("Expected a posted reply")
      return { chatId: chat.id, slotId: reply.entry.slotId }
    })
  )

const versions = (slotId: SlotId) => rpc((api) => api.ListVersions({ slotId }))
const pathLength = (chatId: ChatId) =>
  rpc((api) => api.ReadPath({ chatId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 30 })).then(
    (path) => path.entries.length
  )
const box = (page: Page) => page.getByTestId("composer")
const toggle = (page: Page) => page.getByRole("switch", { name: "Guidance", exact: true })
const bar = (page: Page) => page.getByTestId("guidance-edit-bar")
const settled = async (slotId: SlotId, count: number) =>
  expect
    .poll(async () => {
      const all = await versions(slotId)
      return all.length === count && all.every((v) => v.status !== "generating")
    })
    .toBe(true)

for (const width of [1440, 390]) {
  for (const theme of ["light", "dark"] as const) {
    test(`edit → submit → edit → submit → ✕ gives back the draft (${width}px, ${theme})`, async ({ page }) => {
      await rpc((api) => api.SetDisplayPrefs({ prefs: { guidance: false } }))
      const { chatId, slotId } = await harbor()
      await settled(slotId, 1)
      await page.setViewportSize({ width, height: 844 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/chats/${chatId}`)
      await expect(toggle(page)).toBeEnabled()
      const turns = await pathLength(chatId)

      // A draft of the user's own next message, there before Edit.
      const draft = "Sam waves at the lighthouse keeper."
      await box(page).fill(draft)
      const reply = page.getByRole("article").filter({ hasText: "Direction: Aria looks out to sea." })
      await reply.getByRole("button", { name: "Edit guidance" }).click()

      // The bar names the reply; the box holds its guidance, as guidance, toggle on meanwhile.
      await expect(bar(page)).toContainText("Editing guidance for Aria's reply")
      await expect(box(page)).toHaveValue("Aria looks out to sea.")
      await expect(toggle(page)).toBeChecked()
      await expect(toggle(page)).toBeDisabled()
      await expect(page.getByRole("button", { name: "New version", exact: true })).toBeVisible()
      if (process.env.RP_SCREENS) {
        mkdirSync(process.env.RP_SCREENS, { recursive: true })
        await page.screenshot({ path: `${process.env.RP_SCREENS}/guidance-edit-bar-${width}-${theme}.png` })
      }

      // Enter: a new version of that reply with the box's text, which stays.
      await box(page).fill("Aria spots a ship on the horizon.")
      await box(page).press("Enter")
      await settled(slotId, 2)
      expect((await versions(slotId)).at(-1)!.direction).toBe("Aria spots a ship on the horizon.")
      await expect(box(page)).toHaveValue("Aria spots a ship on the horizon.")
      await expect(bar(page)).toBeVisible()

      // Edit again, and the visible button: another new version, never a new turn.
      await box(page).fill("Aria hums an old sailors' song.")
      await page.getByRole("button", { name: "New version", exact: true }).click()
      await settled(slotId, 3)
      expect((await versions(slotId)).map((v) => v.direction)).toEqual([
        "Aria looks out to sea.",
        "Aria spots a ship on the horizon.",
        "Aria hums an old sailors' song."
      ])
      await expect(page.getByRole("article").last()).toContainText("Direction: Aria hums an old sailors' song.")
      await expect(box(page)).toHaveValue("Aria hums an old sailors' song.")
      expect(await pathLength(chatId)).toBe(turns)

      // ✕: the draft comes back, the box returns to messages, and the toggle as it was.
      await bar(page).getByRole("button", { name: "Stop editing this guidance" }).click()
      await expect(bar(page)).toHaveCount(0)
      await expect(box(page)).toHaveValue(draft)
      await expect(toggle(page)).not.toBeChecked()
      await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible()

      // The stored draft was never overwritten by the guidance: a reload shows it.
      await page.reload()
      await expect(box(page)).toHaveValue(draft)
      await expect(bar(page)).toHaveCount(0)
      expect(await pathLength(chatId)).toBe(turns)
    })
  }
}

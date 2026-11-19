// This chat's "Who's in the scene" setting under Tools (DESIGN §3.5): whether a reply says who
// is there for it. It is offered only while Tools are on, keeps its choice over a reload, and
// belongs to the chat it was set in. At 1440 and 390, light and dark, with the layout audit.
// Nothing is generated here; every card is made up.
import { expect, test } from "@playwright/test"
import type { EntityId } from "@dreamspan/shared/chat.ts"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
import { openPanel } from "./support/panel.ts"
import { loginCookie, withCookie } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const shots = process.env["SENDPRESENCE_SHOTS"]
let cookie: string

const admin = <A>(use: Parameters<typeof withCookie<A>>[2]) => withCookie(server(), cookie, use)

test.beforeAll(async () => {
  cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
  for (const name of ["Mira", "Wren"]) {
    const response = await fetch(`${server().url}/library/import?name=${name}.json`, {
      method: "POST",
      headers: { origin: server().url, cookie, "content-type": "application/octet-stream" },
      body: JSON.stringify({
        spec: "chara_card_v2",
        spec_version: "2.0",
        data: { name, description: `${name} drinks at the harbour tavern.` }
      })
    })
    expect(response.status).toBe(200)
  }
})

test.beforeEach(async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
})

const groupChat = () =>
  admin((api) =>
    Effect.gen(function* () {
      const cards = yield* api.ListCards()
      const id = (name: string) => cards.find((card) => card.name === name)!.entityId as EntityId
      const ana =
        cards.find((card) => card.name === "Ana")?.entityId ??
        (yield* api.CreateCard({ label: "Ana", name: "Ana" })).entityId
      yield* api.SetPersona({ entityId: ana, persona: true })
      const started = yield* api.StartChat({
        cards: ["Mira", "Wren"].map(id),
        persona: ana,
        greeting: null,
        greeters: [],
        first: { _tag: "Send", content: "Evening, all.", speakerEntityId: null }
      })
      return started.chat.id
    })
  )

/** The chat's settings at its last message. */
const castOf = (chatId: string) =>
  admin((api) =>
    Effect.gen(function* () {
      const chat = yield* api.GetChat({ chatId: chatId as never })
      return yield* api.GetCast({ chatId: chat.id, slotId: chat.activeLeafSlotId })
    })
  )

const PANEL = '[role="tabpanel"][aria-label="This chat"]'

for (const width of [1440, 390])
  for (const colorScheme of ["light", "dark"] as const)
    test(`replies say who's in the scene, set for one chat, at ${width} ${colorScheme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
      await page.emulateMedia({ colorScheme })
      const chatId = await groupChat()
      const other = await groupChat()
      await page.goto(`${server().url}/chats/${chatId}`)
      let settings = await openPanel(page, "This chat")
      const scene = () => settings.getByRole("radiogroup", { name: "Who's in the scene" })
      // Only with Tools on: the reply says it through its send tool.
      await expect(scene()).toHaveCount(0)
      const tools = settings.getByRole("switch", { name: "Tools", exact: true })
      await tools.scrollIntoViewIfNeeded()
      await tools.click()
      await expect(scene().getByRole("radio", { name: /^Replies don't say/ })).toBeChecked()
      const must = scene().getByRole("radio", { name: /^Replies must say/ })
      await must.scrollIntoViewIfNeeded()
      await must.click()
      await expect(must).toBeChecked()
      await expect(settings.getByRole("alert")).toContainText("Choose Separate contexts")
      await page.mouse.move(0, 0)
      if (shots) await settings.screenshot({ path: `${shots}/setting-${width}-${colorScheme}.png` })
      await expectLayout(page, test.info(), `send-presence-${width}-${colorScheme}`, { scope: PANEL })

      await expect.poll(async () => (await castOf(chatId)).sendPresence).toBe("required")
      await page.reload()
      settings = await openPanel(page, "This chat")
      await expect(scene().getByRole("radio", { name: /^Replies must say/ })).toBeChecked()

      // The other chat is as it was.
      expect((await castOf(other)).sendPresence).toBeUndefined()

      const may = scene().getByRole("radio", { name: /^Replies may say/ })
      await may.scrollIntoViewIfNeeded()
      await may.click()
      await expect(may).toBeChecked()
      await expect.poll(async () => (await castOf(chatId)).sendPresence).toBe("optional")
    })

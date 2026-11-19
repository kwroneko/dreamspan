import { composerChoice, setGuidance } from "./support/composer.ts"
// QA regressions: mode changes beat slow preference writes, and a phone keeps
// most of its height for the conversation even with a group and multiline guidance.
import { mkdirSync } from "node:fs"
import { expect, type Page, test } from "@playwright/test"
import type { SendResult } from "@dreamspan/shared/chatApi.ts"
import type { EntityId, SlotId } from "@dreamspan/shared/chat.ts"
import { Effect } from "effect"
import { startProvider, type FakeProvider } from "./support/provider.ts"
import { type Client, loginCookie, withCookie } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { cacheChip, choices, modelChip, nextChip, nextReply, presetChip, presetName } from "./support/strip.ts"

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
          name: "Synthetic QA",
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

const group = () =>
  rpc((api) =>
    Effect.gen(function* () {
      const ids: Array<EntityId> = []
      for (const name of ["Aria Vance", "Lady Corvina", "Mireille", "Tobias Wren", "Rook", "Sam"]) {
        ids.push((yield* api.CreateCard({ label: name, name })).entityId)
      }
      const chat = yield* api.CreateChat({ title: "Masquerade at Corvina Hall" })
      for (const id of ids)
        yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: id } })
      yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "PlayedByMe", entityIds: [ids[5]!] } })
      let parent: SlotId | null = null
      for (let i = 0; i < 12; i++) {
        const sent: SendResult = yield* api.SendMessage({
          chatId: chat.id,
          parentSlotId: parent,
          branch: false,
          content: `The guests gather by the lanterns, turn ${i + 1}. ` + "Music drifts across the hall. ".repeat(8),
          speakerEntityId: ids[i % 5]!
        })
        if (sent._tag !== "Posted") throw new Error("Expected a posted message")
        parent = sent.entry.slotId
      }
      return chat.id
    })
  )
const toggle = (page: Page) => page.getByRole("switch", { name: "Guidance", exact: true })
const box = (page: Page) => page.getByTestId("composer")
const path = (chatId: Awaited<ReturnType<typeof group>>) =>
  rpc((api) => api.ReadPath({ chatId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 30 }))

for (const width of [1440, 390]) {
  test(`Guidance on/off acts locally before the composer RPC (${width}px)`, async ({ page }) => {
    const held: Array<() => void> = []
    await page.routeWebSocket(/\/rpc$/, (socket) => {
      const upstream = socket.connectToServer()
      socket.onMessage((data) => {
        if (typeof data === "string" && JSON.parse(data).tag === "SetComposerChoice")
          held.push(() => upstream.send(data))
        else upstream.send(data)
      })
    })
    const chatId = await group()
    await page.setViewportSize({ width, height: 844 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/chats/${chatId}`)
    await expect(toggle(page)).toBeEnabled()
    const direction = "DIRECTION ONLY: Aria should lower her voice."
    await box(page).fill(direction)
    await toggle(page).click()
    await box(page).press("Enter")
    await expect.poll(async () => (await path(chatId)).entries.at(-1)?.version.direction).toBe(direction)
    expect(
      (await path(chatId)).entries.filter(
        (entry) => entry.version.writer === "human" && entry.version.content === direction
      )
    ).toHaveLength(0)
    // Submitted guidance leaves the box (DESIGN §2.2, guidance on swipes).
    await expect(box(page)).toHaveValue("")
    await expect(toggle(page)).toBeChecked()
    // The server still has the old preference; the first write remains held.
    expect((await rpc((api) => composerChoice(api, chatId))).guidance).toBe(false)
    const story = "Sam sets the glass down."
    await box(page).fill(story)
    await toggle(page).click()
    await box(page).press("Enter")
    await expect
      .poll(async () =>
        (await path(chatId)).entries.some(
          (entry) =>
            entry.version.writer === "human" && entry.version.content === story && entry.version.direction === null
        )
      )
      .toBe(true)
    await expect(toggle(page)).not.toBeChecked()
    await expect.poll(() => held.length).toBe(1)
    held[0]!()
    await expect.poll(() => held.length).toBe(2)
    // An old acknowledgement must not put the composer back into Guidance.
    await expect(toggle(page)).not.toBeChecked()
    held[1]!()
    await expect.poll(async () => (await rpc((api) => composerChoice(api, chatId))).guidance).toBe(false)
    await page.reload()
    await expect(toggle(page)).not.toBeChecked()
  })
}

test("a preference read after acknowledgement accepts a newer composer choice", async ({ page }) => {
  let holdReads = false
  const held: Array<() => void> = []
  await page.routeWebSocket(/\/rpc$/, (socket) => {
    const upstream = socket.connectToServer()
    socket.onMessage((data) => {
      if (holdReads && typeof data === "string" && JSON.parse(data).tag === "GetComposerChoice")
        held.push(() => upstream.send(data))
      else upstream.send(data)
    })
  })
  const chatId = await group()
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chatId}`)
  await expect(toggle(page)).toBeEnabled()
  holdReads = true
  await toggle(page).click()
  await expect.poll(() => held.length).toBe(1)
  expect((await rpc((api) => composerChoice(api, chatId))).guidance).toBe(true)
  // Another browser changes the composer after this tab's save, before its readback.
  await rpc((api) => setGuidance(api, chatId, false))
  holdReads = false
  held[0]!()
  await expect(toggle(page)).not.toBeChecked()
})

test("a refused Guidance save rolls back visibly and a later choice can still save", async ({ page }) => {
  let refuse = true
  let release: (() => void) | undefined
  await page.routeWebSocket(/\/rpc$/, (socket) => {
    const upstream = socket.connectToServer()
    socket.onMessage((data) => {
      const request = typeof data === "string" ? (JSON.parse(data) as { tag?: string; id?: string }) : null
      if (request?.tag === "SetComposerChoice" && refuse) {
        release = () =>
          socket.send(
            JSON.stringify({
              _tag: "Exit",
              requestId: request.id,
              exit: {
                _tag: "Failure",
                cause: [{ _tag: "Fail", error: { _tag: "ServerError", message: "Synthetic preference refusal" } }]
              }
            })
          )
      } else upstream.send(data)
    })
  })
  const chatId = await group()
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chatId}`)
  await expect(toggle(page)).toBeEnabled()
  await toggle(page).click()
  await expect(toggle(page)).toBeChecked()
  await expect.poll(() => !!release).toBe(true)
  release!()
  await expect(toggle(page)).not.toBeChecked()
  await expect(page.getByRole("alert")).toContainText("Something failed on the server")
  refuse = false
  await toggle(page).click()
  await expect.poll(async () => (await rpc((api) => composerChoice(api, chatId))).guidance).toBe(true)
  await expect(page.getByRole("alert")).toHaveCount(0)
  await page.reload()
  await expect(toggle(page)).toBeChecked()
})

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`group reading space and controls (${width}px ${theme})`, async ({ page }, testInfo) => {
      // This measures daily use after the one-time preset explanation has been acknowledged.
      await rpc((api) => api.ImpersonationNotice({}))
      const chatId = await group()
      await rpc((api) => setGuidance(api, chatId, true))
      await page.setViewportSize({ width, height: 844 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/chats/${chatId}`)
      await expect(toggle(page)).toBeChecked()
      const direction = "Let Aria lower her voice.\nLet the music fade away.\nEnd on the invitation."
      await box(page).fill(direction)
      await page.getByRole("button", { name: "Generate Sam", exact: true }).click()
      await expect.poll(async () => (await path(chatId)).entries.at(-1)?.version.status).toBe("complete")
      await expect(cacheChip(page)).toHaveAccessibleName(/^Cache warm/)
      await expect(page.getByRole("button", { name: "Generate Sam", exact: true })).toBeEnabled()
      const height = await page.getByTestId("messages").evaluate((element) => element.clientHeight)
      await testInfo.attach("conversation-height", {
        body: JSON.stringify({ width, theme, height }),
        contentType: "application/json"
      })
      if (width === 390) {
        expect(height).toBeGreaterThanOrEqual(422) // At least half the 844px phone, the strip included.
        // The strip is one row of chips on a phone, scrolled sideways rather than wrapped.
        expect((await nextReply(page).boundingBox())!.height).toBeLessThan(40)
      }
      // Every chip is shown at every width; the cache chip's popover has the countdown switch.
      await cacheChip(page).click()
      await expect(page.getByRole("button", { name: "Hide countdown", exact: true })).toBeVisible()
      await page.keyboard.press("Escape")
      await expect(page.getByRole("button", { name: "Hide countdown", exact: true })).toHaveCount(0)
      await expect(modelChip(page)).toHaveAccessibleName(/^Model: Synthetic QA · .+\. Change the model$/)
      await expect(presetChip(page)).toHaveAccessibleName(presetName("Default (built-in)"))
      // Auto, No one, then the five characters who can reply.
      await nextChip(page).click()
      await expect(choices(page, "Who replies next").getByRole("radio")).toHaveCount(7)
      if (width === 390 && process.env.RP_SCREENS) {
        mkdirSync(process.env.RP_SCREENS, { recursive: true })
        await page.screenshot({ path: `${process.env.RP_SCREENS}/group-options-${width}-${theme}.png` })
      }
      await page.keyboard.press("Escape")
      await expect(choices(page, "Who replies next")).toHaveCount(0)
      // What the box is for, read with it (and shown on the guidance switch's tooltip).
      await expect(page.getByTestId("composer")).toHaveAccessibleDescription(/One-turn guidance for Sam's/)
      await expect(page.getByRole("button", { name: /^Speaking as Sam/ })).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      if (process.env.RP_SCREENS) {
        mkdirSync(process.env.RP_SCREENS, { recursive: true })
        await page.screenshot({ path: `${process.env.RP_SCREENS}/group-${width}-${theme}.png` })
      }
    })
  }

import { setGuidance } from "./support/composer.ts"
// Guidance on swipes (DESIGN §2.2, owner 2026-10-29): Edit on a reply's guidance puts it in
// the composer under a bar; each submit is a new version of that reply with the box's text,
// which stays; ✕ goes back to new turns. The box is always the composer draft (one box, one
// draft: owner 2026-11-21), so a reload brings back the text and the bar.
import { mkdirSync } from "node:fs"
import { expect, type Page, test } from "@playwright/test"
import type { ChatId, EntityId, SlotId } from "@dreamspan/shared/chat.ts"
import { Effect } from "effect"
import { startProvider, type FakeProvider } from "./support/provider.ts"
import { messageMenu, showActions } from "./support/message.ts"
import { type Client, loginCookie, withCookie } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { showAppNavigation } from "./support/appMenu.ts"

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
    test(`edit → submit → edit → submit → ✕, the text and the bar surviving reloads (${width}px, ${theme})`, async ({
      page
    }) => {
      const { chatId, slotId } = await harbor()
      await settled(slotId, 1)
      await page.setViewportSize({ width, height: 844 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/chats/${chatId}`)
      await expect(toggle(page)).toBeEnabled()
      const turns = await pathLength(chatId)

      // A draft of the user's own next message, there before Edit.
      const draft = "Sam waves at the lighthouse keeper."
      await box(page).fill(draft)
      const reply = page.getByRole("article").filter({ hasText: "Guidance: Aria looks out to sea." })
      const history = page.getByRole("button", { name: "Earlier text in this box", exact: true })
      const controls = page.getByTestId("composer-controls")
      const historyBox = () =>
        history.evaluate((button) => {
          const r = button.getBoundingClientRect(),
            p = button.closest('[data-testid="composer-controls"]')!.getBoundingClientRect()
          return [r.x - p.x, r.y - p.y, r.width, r.height]
        })
      await expect(controls).toBeVisible()
      const historyBefore = await historyBox()
      await reply.getByRole("button", { name: "New version with this guidance" }).click()

      await expect(history).toBeDisabled()
      expect(await historyBox()).toEqual(historyBefore)
      await history.hover()
      await expect(
        page
          .getByText("Finish editing this reply’s guidance to browse composer history.", { exact: true })
          .filter({ visible: true })
      ).toBeVisible()

      // The bar names the reply; the box holds its guidance, as guidance, toggle on meanwhile.
      await expect(bar(page)).toContainText("Guidance for a new version of Aria's reply")
      await expect(box(page)).toHaveValue("Aria looks out to sea.")
      await expect(toggle(page)).toBeChecked()
      await expect(toggle(page)).toBeDisabled()
      await expect(page.getByRole("button", { name: "New version", exact: true })).toBeVisible()
      await expect(page.getByRole("button", { name: "New version", exact: true })).toBeEnabled()
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
      await expect(page.getByRole("article").last()).toContainText("Guidance: Aria hums an old sailors' song.")
      await expect(box(page)).toHaveValue("Aria hums an old sailors' song.")
      expect(await pathLength(chatId)).toBe(turns)
      // The guidance typed is the composer draft's text, saved like any typing.
      await expect
        .poll(async () => (await rpc((api) => api.OpenComposer({ chatId, forkId: null }))).content)
        .toBe("Aria hums an old sailors' song.")
      // The draft typed before Edit is one step back in its history.
      const states = await rpc((api) =>
        Effect.gen(function* () {
          const composer = yield* api.OpenComposer({ chatId, forkId: null })
          return yield* api.ComposerHistory({ chatId, draftId: composer.id, limit: 50 })
        })
      )
      expect(states.some((state) => state.removed.includes("lighthouse keeper"))).toBe(true)

      // Reload while editing: the text and the bar come back.
      await box(page).fill("Aria counts the gulls.")
      await page.reload()
      await expect(bar(page)).toContainText("Guidance for a new version of Aria's reply")
      await expect(box(page)).toHaveValue("Aria counts the gulls.")
      await expect(toggle(page)).toBeChecked()

      // ✕: the box returns to messages with its text, and the toggle as it was.
      await bar(page).getByRole("button", { name: "Close: back to new messages" }).click()
      await expect(bar(page)).toHaveCount(0)
      await expect(box(page)).toHaveValue("Aria counts the gulls.")
      await expect(toggle(page)).not.toBeChecked()
      await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible()

      // Closed stays closed through a reload; the text stays too.
      await page.reload()
      await expect(box(page)).toHaveValue("Aria counts the gulls.")
      await expect(bar(page)).toHaveCount(0)
      expect(await pathLength(chatId)).toBe(turns)
    })
  }
}

for (const width of [1440, 390]) {
  test(`guidance typed and reloaded before any save comes back from this browser, with its bar (${width}px)`, async ({
    page
  }) => {
    // Saves dropped until the reload: the text is only in this browser's copy.
    let dropSaves = true
    await page.routeWebSocket(/\/rpc$/, (socket) => {
      const upstream = socket.connectToServer()
      socket.onMessage((data) => {
        if (dropSaves && typeof data === "string" && JSON.parse(data).tag === "SaveComposer") return
        upstream.send(data)
      })
    })
    const { chatId, slotId } = await harbor()
    await settled(slotId, 1)
    await page.setViewportSize({ width, height: 844 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/chats/${chatId}`)
    await expect(toggle(page)).toBeEnabled()
    await page.getByRole("button", { name: "New version with this guidance" }).click()
    await expect(box(page)).toHaveValue("Aria looks out to sea.")
    await box(page).fill("Aria sees a storm coming.")
    await page.waitForTimeout(100)
    expect((await rpc((api) => api.OpenComposer({ chatId, forkId: null }))).content).toBe("")
    await page.reload()
    dropSaves = false
    await expect(box(page)).toHaveValue("Aria sees a storm coming.")
    await expect(bar(page)).toContainText("Guidance for a new version of Aria's reply")
    // It reaches the server once saves go through, and New version uses it.
    await expect
      .poll(async () => (await rpc((api) => api.OpenComposer({ chatId, forkId: null }))).content)
      .toBe("Aria sees a storm coming.")
    await page.getByRole("button", { name: "New version", exact: true }).click()
    await settled(slotId, 2)
    expect((await versions(slotId)).at(-1)!.direction).toBe("Aria sees a storm coming.")
  })

  test(`New version stays available while unrelated speaker choices load (${width}px)`, async ({ page }) => {
    const held: Array<() => void> = []
    await page.routeWebSocket(/\/rpc$/, (socket) => {
      const upstream = socket.connectToServer()
      socket.onMessage((data) => {
        if (typeof data === "string" && JSON.parse(data).tag === "GetComposerChoice")
          held.push(() => upstream.send(data))
        else upstream.send(data)
      })
    })
    const { chatId, slotId } = await harbor()
    await settled(slotId, 1)
    await page.setViewportSize({ width, height: 844 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/chats/${chatId}`)
    await expect.poll(() => held.length).toBeGreaterThan(0)
    await page.getByRole("button", { name: "New version with this guidance" }).click()
    await box(page).fill("Aria listens to the waves.")
    await expect(page.getByRole("button", { name: "New version", exact: true })).toBeEnabled()
    await page.getByRole("button", { name: "New version", exact: true }).click()
    await settled(slotId, 2)
    expect((await versions(slotId)).at(-1)!.direction).toBe("Aria listens to the waves.")
    for (const release of held) release()
  })

  test(`live swipes, New version with guidance…, deletion and chat navigation keep the box's text (${width}px)`, async ({
    page
  }) => {
    const { chatId, slotId } = await harbor()
    await rpc((api) => setGuidance(api, chatId, true))
    await settled(slotId, 1)
    const second = await rpc((api) =>
      api.Generate({ chatId, parentSlotId: slotId, branch: false, direction: "A different reply's guidance." })
    )
    if (second._tag !== "Posted") throw new Error("Expected a posted reply")
    const secondId = second.entry.slotId
    await settled(secondId, 1)
    await page.setViewportSize({ width, height: 844 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/chats/${chatId}`)
    await expect(toggle(page)).toBeEnabled()
    await box(page).fill("The next turn's original guidance.")
    const reply = page.getByRole("article").filter({ hasText: "Guidance: Aria looks out to sea." })
    await reply.getByRole("button", { name: "New version with this guidance" }).click()
    await box(page).fill("Live unsaved guidance.")
    await showActions(reply)
    await reply.getByRole("button", { name: "Generate another version", exact: true }).click()
    await settled(slotId, 2)
    expect((await versions(slotId)).at(-1)!.direction).toBe("Live unsaved guidance.")
    // Regenerating the other reply doesn't take the text currently in the box.
    const other = page.getByRole("article").filter({ hasText: "Guidance: A different reply's guidance." })
    await showActions(other)
    await other.getByRole("button", { name: "Generate another version", exact: true }).click()
    await settled(secondId, 2)
    expect((await versions(secondId)).at(-1)!.direction).toBe("A different reply's guidance.")
    await expect(box(page)).toHaveValue("Live unsaved guidance.")
    // An explicit empty box removes guidance; New version with guidance… offers the same editor again.
    await box(page).fill("")
    await page.getByRole("button", { name: "New version", exact: true }).click()
    await settled(slotId, 3)
    expect((await versions(slotId)).at(-1)!.direction).toBeNull()
    await bar(page).getByRole("button", { name: "Close: back to new messages" }).click()
    await expect(box(page)).toHaveValue("")
    await expect(toggle(page)).toBeChecked()
    // A reply without guidance leaves the box's text as it is, for its guidance.
    await box(page).fill("Fog over the water.")
    const unguided = page.getByRole("article").nth(1)
    await messageMenu(unguided, "New version with guidance…")
    await expect(box(page)).toHaveValue("Fog over the water.")
    await expect(bar(page)).toBeVisible()
    await messageMenu(unguided, "Delete all versions")
    await expect(bar(page)).toHaveCount(0)
    await expect(box(page)).toHaveValue("Fog over the water.")
    await page.getByRole("button", { name: "New version with this guidance" }).click()
    await expect(bar(page)).toBeVisible()
    const guidance = await box(page).inputValue()
    await showAppNavigation(page)
    await page.getByRole("link", { name: "Home", exact: true }).filter({ visible: true }).first().click()
    await page.goBack()
    // Home opened in a tab of its own; the chat's tab kept its state (owner, 2026-11-05).
    await expect(bar(page)).toBeVisible()
    await expect(box(page)).toHaveValue(guidance)
  })

  for (const reloaded of [false, true])
    test(`typing guidance keeps the composer and the messages still${reloaded ? " after a reload" : ""} (${width}px)`, async ({
      page
    }) => {
      const { chatId, slotId: first } = await harbor()
      await settled(first, 1)
      // A third character, so naming one in the box could change who replies to a send.
      await rpc((api) =>
        Effect.gen(function* () {
          const bo = (yield* api.CreateCard({ label: "Bo", name: "Bo" })).entityId
          yield* api.ChangeCast({ chatId, slotId: null, change: { _tag: "Join", entityId: bo } })
        })
      )
      // A chat long enough to scroll, its last reply written with guidance.
      let parent = first
      for (let i = 0; i < 12; i++) {
        const sent = await rpc((api) =>
          api.SendMessage({ chatId, parentSlotId: parent, branch: false, content: `Line ${i}.\n\nMore of line ${i}.` })
        )
        if (sent._tag !== "Posted") throw new Error("Expected a posted message")
        parent = sent.entry.slotId
      }
      const last = await rpc((api) => api.Generate({ chatId, parentSlotId: parent, branch: false, direction: "Tide." }))
      if (last._tag !== "Posted") throw new Error("Expected a posted reply")
      const slotId = last.entry.slotId
      await settled(slotId, 1)
      await page.setViewportSize({ width, height: 844 })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/chats/${chatId}`)
      await expect(toggle(page)).toBeEnabled()
      const reply = page.getByRole("article").filter({ hasText: "Guidance: Tide." })
      await reply.getByRole("button", { name: "New version with this guidance" }).click()
      await expect(bar(page)).toBeVisible()
      await expect(box(page)).toHaveValue("Tide.")
      await box(page).press("End")
      if (reloaded) {
        // The owner's case: typed, reloaded with the bar open, typed again.
        await box(page).pressSequentially(" Fog", { delay: 60 })
        await expect
          .poll(async () => (await rpc((api) => api.OpenComposer({ chatId, forkId: null }))).content)
          .toBe("Tide. Fog")
        await page.reload()
        await expect(bar(page)).toBeVisible()
        await expect(box(page)).toHaveValue("Tide. Fog")
        await box(page).click()
        await box(page).press("End")
      }
      const measure = async () => {
        const composer = (await box(page).boundingBox())!
        const message = (await reply.boundingBox())!
        return [composer.y, composer.height, message.y, message.height].map(Math.round).join(",")
      }
      await page.waitForTimeout(800)
      const start = await measure()
      // Every frame while typing: the box and the reply above it stay where they are.
      await page.evaluate(() => {
        const w = window as unknown as { frames_: Array<string>; stop_: boolean }
        w.frames_ = []
        w.stop_ = false
        const tick = () => {
          const composer = document.querySelector('[data-testid="composer"]')!.getBoundingClientRect()
          const articles = document.querySelectorAll("article")
          const message = articles[articles.length - 1]!.getBoundingClientRect()
          w.frames_.push([composer.y, composer.height, message.y, message.height].map(Math.round).join(","))
          if (!w.stop_) requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
      await box(page).pressSequentially(" Bo nods", { delay: 120 })
      await page.waitForTimeout(400)
      await box(page).pressSequentially(" at Sam", { delay: 450 })
      // Emptied and typed again.
      await box(page).fill("")
      await box(page).pressSequentially("Bo", { delay: 450 })
      await page.waitForTimeout(1200)
      const frames = await page.evaluate(() => {
        const w = window as unknown as { frames_: Array<string>; stop_: boolean }
        w.stop_ = true
        return w.frames_
      })
      expect(await measure()).toBe(start)
      expect([...new Set(frames)]).toEqual([start])
    })
}

// Synthetic replies only: keyboard controls must preserve drafts and share visible actions.
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { startContinueProvider } from "./support/continueProvider.ts"
import { type Client, loginCookie, withCookie } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
let provider: Awaited<ReturnType<typeof startContinueProvider>>
test.beforeAll(async () => {
  provider = await startContinueProvider()
})
test.afterAll(async () => {
  await provider.stop()
})
let cookie: Promise<string> | null = null
const admin = <A>(use: (api: Client) => Effect.Effect<A, unknown>) => {
  cookie ??= loginCookie(server(), ADMIN.handle, ADMIN.password)
  return cookie.then((value) => withCookie(server(), value, use))
}

const setup = (human = false) =>
  admin((api) =>
    Effect.gen(function* () {
      yield* api.SetDisplayPrefs({ prefs: { guidance: false } })
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: "Keyboard fixture",
          baseUrl: provider.baseUrl,
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        }
      })
      const model = yield* api.AddUserModel({
        connectionId: connection.id,
        key: "native-prefill",
        overrides: { prefill: "assistant" }
      })
      yield* api.SetGenerationDefaults({
        defaults: { model: { connection: connection.id, model: model.id }, preset: null }
      })
      const chat = yield* api.CreateChat({ title: "Keyboard fixture" })
      const sent = human
        ? yield* api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "Human fixture" })
        : null
      yield* api.Generate({
        chatId: chat.id,
        parentSlotId: sent?._tag === "Posted" ? sent.entry.slotId : null,
        branch: false
      })
      return chat
    })
  )

test("Alt+Enter continues without sending or consuming composer text, including guidance", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const chat = await setup()
  // Delay both ways the capability can arrive, so completion alone cannot make the
  // shortcut ready. Releasing after the keypress reproduces the next-context race.
  let holdContext = true
  const held: Array<() => void> = []
  await page.routeWebSocket(/\/rpc$/, (socket) => {
    const upstream = socket.connectToServer()
    const contextReads = new Set<number>()
    socket.onMessage((data) => {
      if (typeof data === "string") {
        const frame = JSON.parse(data)
        if (frame.tag === "GetNextContext") contextReads.add(frame.id)
      }
      upstream.send(data)
    })
    upstream.onMessage((data) => {
      if (
        holdContext &&
        typeof data === "string" &&
        (contextReads.has(JSON.parse(data).requestId) || data.includes('"_tag":"Cache"'))
      )
        held.push(() => socket.send(data))
      else socket.send(data)
    })
  })
  await page.goto(`${server().url}/chats/${chat.id}`)
  const reply = page.getByRole("article").last()
  await expect(reply.locator(".markdown").last()).toContainText("The ledger")
  await expect(reply.getByText("generating", { exact: true })).toHaveCount(0, { timeout: 30_000 })
  for (const guidance of [false, true]) {
    if (guidance) await page.getByRole("switch", { name: "Guidance", exact: true }).click()
    const box = page.getByTestId("composer")
    await box.fill("UNSENT SYNTHETIC DRAFT")
    const requests = provider.requests.length
    await box.press("Alt+Enter")
    if (!guidance) {
      // The action must resume on readiness without another keypress.
      holdContext = false
      for (const release of held) release()
    }
    await expect.poll(() => provider.requests.length).toBe(requests + 1)
    expect(JSON.stringify(provider.requests.at(-1))).not.toContain("UNSENT SYNTHETIC DRAFT")
    expect(provider.requests.at(-1)!.messages.at(-1)!.role).toBe("assistant")
    await expect(box).toHaveValue("UNSENT SYNTHETIC DRAFT")
    await expect(page.getByRole("article")).toHaveCount(1)
    await expect(reply.getByText("generating", { exact: true })).toHaveCount(0, { timeout: 30_000 })
  }
})

test("editing, saving and version arrows share visible actions and ignore typing, IME and dialogs", async ({
  page
}) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const chat = await setup(true)
  await page.goto(`${server().url}/chats/${chat.id}`)
  const box = page.getByTestId("composer")
  const reply = page.getByRole("article").last()
  await expect(reply.locator(".markdown").last()).toContainText("The ledger")
  await expect(reply.getByText("generating", { exact: true })).toHaveCount(0, { timeout: 30_000 })
  await box.fill("typing")
  await box.press("ArrowUp")
  await box.press("Control+ArrowUp")
  await box.press("ArrowRight")
  await expect(page.getByRole("textbox", { name: "Message text", exact: true })).toHaveCount(0)
  await box.fill("")
  await box.dispatchEvent("keydown", { key: "ArrowUp", isComposing: true })
  await expect(page.getByRole("textbox", { name: "Message text", exact: true })).toHaveCount(0)
  await box.press("ArrowUp")
  const editor = page.getByRole("textbox", { name: "Message text", exact: true })
  await expect(editor).toBeVisible()
  await expect(reply.getByRole("button", { name: "Save", exact: true })).toBeVisible()
  await editor.fill("Edited synthetic reply")
  await editor.press("Control+Enter")
  await expect(editor).toHaveCount(0)
  await expect(reply.locator(".markdown").last()).toContainText("Edited synthetic reply")
  await box.press("Control+ArrowUp")
  await expect(
    page.getByRole("article").first().getByRole("textbox", { name: "Message text", exact: true })
  ).toBeVisible()
  await page.getByRole("button", { name: "Cancel", exact: true }).click()
  await box.focus()
  await box.blur()
  await page.keyboard.press("ArrowLeft")
  await expect(reply.locator(".markdown").last()).toContainText("The ledger")
  await page.keyboard.press("ArrowRight")
  await expect(reply.locator(".markdown").last()).toContainText("Edited synthetic reply")
  const requests = provider.requests.length
  await page.keyboard.press("ArrowRight")
  await expect.poll(() => provider.requests.length).toBe(requests + 1)
  await expect(reply.getByText("generating", { exact: true })).toHaveCount(0, { timeout: 30_000 })
  await reply.getByRole("button", { name: /choose a version/ }).click()
  const dialog = page.getByRole("dialog", { name: /Versions of message/ })
  await expect(dialog).toBeVisible()
  await page.keyboard.press("Alt+Enter")
  await expect.poll(() => provider.requests.length).toBe(requests + 1)
  await page.keyboard.press("Escape")
})

test("Enter sends is visible, persists and controls saved and pending composers", async ({ page }) => {
  test.setTimeout(120_000)
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const chat = await setup()
  await page.goto(`${server().url}/settings/interface`)
  await page.getByRole("radio", { name: /^Never/ }).click()
  await expect.poll(async () => (await admin((api) => api.GetDisplayPrefs({}))).enterSends).toBe("never")
  await page.reload()
  await expect(page.getByRole("radio", { name: /^Never/ })).toBeChecked()
  const card = await admin((api) => api.CreateCard({ label: "Keyboard pending", name: "Keyboard pending" }))
  for (const url of [`/chats/${chat.id}`, `/cards/${card.entityId}/chat`]) {
    await page.goto(`${server().url}${url}`)
    const box = page.getByTestId("composer")
    await expect(box).toBeEditable()
    await box.fill("first line")
    await box.press("Enter")
    await expect(box).toHaveValue("first line\n")
    await box.press("Alt+Enter") // Pending chats have nothing to continue; never send the draft.
    await expect(box).toHaveValue("first line\n")
    await box.press("Control+Enter")
    await expect(page.getByRole("article").filter({ hasText: "first line" })).toBeVisible()
    await expect(page.getByTestId("composer")).toHaveValue("")
  }
  await page.goto(`${server().url}/settings/interface`)
  await page.getByRole("radio", { name: /^Automatic/ }).click()
})

test("edit-own and version shortcuts follow the cast like the visible message controls", async ({ page }) => {
  test.setTimeout(120_000)
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const chat = await setup()
  await page.goto(`${server().url}/chats/${chat.id}`)
  await expect(page.getByRole("article").last().getByText("generating", { exact: true })).toHaveCount(0)
  const character = await admin((api) =>
    Effect.gen(function* () {
      const persona = yield* api.CreateCard({ label: "Keyboard persona", name: "Keyboard persona" })
      const character = yield* api.CreateCard({ label: "Keyboard character", name: "Keyboard character" })
      for (const card of [persona, character])
        yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: card.entityId } })
      yield* api.ChangeCast({
        chatId: chat.id,
        slotId: null,
        change: { _tag: "PlayedByMe", entityIds: [persona.entityId] }
      })
      const path = yield* api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 1 })
      yield* api.Generate({
        chatId: chat.id,
        parentSlotId: path.entries.at(-1)!.slotId,
        branch: false,
        speakerEntityId: persona.entityId
      })
      return character
    })
  )
  await expect(page.getByRole("article")).toHaveCount(2)
  await expect(page.getByRole("article").last().getByText("generating", { exact: true })).toHaveCount(0)
  await admin((api) =>
    Effect.gen(function* () {
      const path = yield* api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 1 })
      yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: path.entries.at(-1)!.slotId,
        branch: false,
        speakerEntityId: character.entityId,
        content: "A human-written character turn"
      })
    })
  )
  await expect(page.getByRole("article")).toHaveCount(3)
  const own = page.getByRole("article").nth(1)
  const last = page.getByRole("article").last()
  await expect(own).toHaveAccessibleName("Your message")
  await expect(last).toHaveAccessibleName("Reply")
  const box = page.getByTestId("composer")
  await box.press("Control+ArrowUp")
  await expect(own.getByRole("textbox", { name: "Message text", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Cancel", exact: true }).click()
  await box.focus()
  await box.blur()
  const requests = provider.requests.length
  await page.keyboard.press("ArrowRight")
  await expect.poll(() => provider.requests.length).toBe(requests + 1)
  await expect(last.getByText("generating", { exact: true })).toHaveCount(0)
  await expect(last.locator(".markdown").last()).toContainText("The ledger")
  // The persona turn must still be editable after it falls outside the initial 60-row window.
  await admin((api) =>
    Effect.gen(function* () {
      const path = yield* api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 1 })
      let parentSlotId = path.entries.at(-1)!.slotId
      for (let i = 0; i < 65; i++) {
        const sent = yield* api.SendMessage({
          chatId: chat.id,
          parentSlotId,
          branch: false,
          speakerEntityId: character.entityId,
          content: `Synthetic character turn ${i}`
        })
        if (sent._tag !== "Posted") throw new Error("Expected a posted fixture turn")
        parentSlotId = sent.entry.slotId
      }
    })
  )
  await page.reload()
  await expect(page.getByRole("article").filter({ hasText: "Keyboard persona" })).toHaveCount(0)
  // The absence assertion also succeeds before the path/cast has loaded after a reload.
  // Wait for the character role, as in the first shortcut check above.
  await expect(page.getByRole("article").last()).toHaveAccessibleName("Reply")
  await box.press("Control+ArrowUp")
  await expect(
    page
      .getByRole("article", { name: "Your message", exact: true })
      .filter({ hasText: "Keyboard persona" })
      .getByRole("textbox", { name: "Message text", exact: true })
  ).toBeVisible()
})

test("composer and Enter sends display at desktop and phone widths in both themes", async ({ page }) => {
  test.skip(!process.env.RP_SCREENS, "Screenshot capture requested through RP_SCREENS")
  const { mkdirSync } = await import("node:fs")
  mkdirSync(process.env.RP_SCREENS!, { recursive: true })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const chat = await admin((api) =>
    Effect.gen(function* () {
      yield* api.SetDisplayPrefs({ prefs: { guidance: false, enterSends: "never" } })
      const card = yield* api.CreateCard({ label: "Screenshot Mira", name: "Mira" })
      const chat = yield* api.CreateChat({ title: "The lantern keeper" })
      yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: card.entityId } })
      yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: null,
        branch: false,
        content: "The lantern keeper pauses by the harbor. Rain taps against the glass.",
        speakerEntityId: card.entityId
      })
      return chat
    })
  )
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ colorScheme: theme as "light" | "dark" })
      await page.goto(`${server().url}/chats/${chat.id}`)
      await page.evaluate((theme) => localStorage.setItem("rp.theme", theme), theme)
      await page.reload()
      await expect(page.getByTestId("composer")).toBeEditable()
      await page.getByTestId("composer").fill("We should leave before the watch changes.\nThere is still time.")
      await page.screenshot({ path: `${process.env.RP_SCREENS}/composer-${width}-${theme}.png` })
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
      await page.goto(`${server().url}/settings/interface`)
      await expect(page.getByRole("radio", { name: /^Never/ })).toBeChecked()
      await page.screenshot({ path: `${process.env.RP_SCREENS}/enter-sends-${width}-${theme}.png` })
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    }
})

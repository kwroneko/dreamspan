// Auto replies (DESIGN §2.3): the strip's "Auto…" chip asks how many replies and says what will
// be sent; then the characters reply in turn with nothing sent from you, counted in a row above
// the box with Stop. It ends at its bounds (replies, tokens written), when you type, when you
// press Stop, and with the tab (a reload). At 1440 and 390, light and dark, with the layout
// audit on the dialog, the row and the chip's hover. A fake chat model on loopback; every card
// is made up.
import { expect, type Page, test } from "@playwright/test"
import type { EntityId } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import { expectLayout, layoutAudit } from "./support/layoutAudit.ts"
import { type FakeProvider, startProvider } from "./support/provider.ts"
import { loginCookie, withCookie } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { nextReply } from "./support/strip.ts"

const server = serverPerFile(withAdmin)
const shots = process.env["AUTOMODE_SHOTS"]
let cookie: string
let provider: FakeProvider

const admin = <A>(use: Parameters<typeof withCookie<A>>[2]) => withCookie(server(), cookie, use)

test.beforeAll(async () => {
  cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
  provider = await startProvider({
    reply: "*nods* The tide is turning.",
    holdAfterText: false,
    respectOutputLimit: true
  })
  for (const name of ["Mira", "Wren", "Ash"]) {
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
  await admin((api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: "Local model",
          baseUrl: provider.baseUrl,
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        },
        apiKey: "sk-automode-chat-0042"
      })
      yield* api.RefreshModels({ connectionId: chat.id })
      const model = (yield* api.ListModels({ connectionId: chat.id, includeHidden: false })).find(
        (m) => m.key === "fake-small"
      )!
      yield* api.SetGenerationDefaults({ defaults: { model: { connection: chat.id, model: model.id }, preset: null } })
    })
  )
})

test.afterAll(async () => {
  provider.release()
  await provider.stop()
})

test.beforeEach(async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
})

test.afterEach(() => provider.release())

/** A chat of the named cards, played as Ana, with one message sent and no reply to it. */
const chatOf = (names: ReadonlyArray<string>) =>
  admin((api) =>
    Effect.gen(function* () {
      const cards = yield* api.ListCards()
      const id = (name: string) => cards.find((card) => card.name === name)!.entityId as EntityId
      const ana =
        cards.find((card) => card.name === "Ana")?.entityId ??
        (yield* api.CreateCard({ label: "Ana", name: "Ana" })).entityId
      yield* api.SetPersona({ entityId: ana, persona: true })
      const started = yield* api.StartChat({
        cards: names.map(id),
        persona: ana,
        greeting: null,
        greeters: [],
        first: { _tag: "Send", content: "*I shake the rain off my coat.* Evening, all.", speakerEntityId: null }
      })
      return started.chat.id
    })
  )

const tooltip = (page: Page) => page.locator('[data-layout-overlay="Tooltip floats above the page"]')
const chip = (page: Page) => nextReply(page).getByRole("button", { name: "Auto…", exact: true })
const row = (page: Page) => page.getByRole("group", { name: "Auto replies", exact: true })
const dialog = (page: Page) => page.getByRole("dialog", { name: "Auto replies" })
const messages = (page: Page) => page.locator("article[data-slot]")
const box = (page: Page) => page.getByLabel("Message", { exact: true })

const start = async (page: Page, replies: number, tokens?: number) => {
  await chip(page).click()
  await dialog(page).getByLabel("Replies", { exact: true }).fill(String(replies))
  if (tokens !== undefined)
    await dialog(page).getByLabel("Token limit (optional)", { exact: true }).fill(String(tokens))
  await dialog(page).getByRole("button", { name: "Start", exact: true }).click()
  await expect(dialog(page)).toHaveCount(0)
}

/** Nothing more is sent: the count of requests stays where it is for a while. */
const staysAt = async (count: number) => {
  await new Promise((resolve) => setTimeout(resolve, 1500))
  expect(provider.completions.length).toBe(count)
}

test("a chat with one character has no Auto chip", async ({ page }) => {
  const chatId = await chatOf(["Mira"])
  await page.goto(`${server().url}/chats/${chatId}`)
  await expect(box(page)).toBeVisible()
  await expect(nextReply(page)).toBeVisible()
  await expect(chip(page)).toHaveCount(0)
})

for (const width of [1440, 390])
  for (const colorScheme of ["light", "dark"] as const)
    test(`a run of two replies, counted and done, at ${width} ${colorScheme}`, async ({ page }) => {
      test.setTimeout(120_000)
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
      await page.emulateMedia({ colorScheme })
      const chatId = await chatOf(["Mira", "Wren", "Ash"])
      await page.goto(`${server().url}/chats/${chatId}`)
      await expect(messages(page)).toHaveCount(1)
      const before = provider.completions.length

      await chip(page).scrollIntoViewIfNeeded()
      if (width === 1440) {
        await chip(page).hover()
        await expect(tooltip(page)).toContainText("You choose how many before anything is sent.")
        const violations = await layoutAudit(page, { scope: '[data-layout-overlay="Tooltip floats above the page"]' })
        expect.soft(violations, "the chip's hover").toEqual([])
      }
      await chip(page).click()
      await expect(dialog(page)).toContainText("Sends up to 5 replies to this chat's model, one at a time")
      await dialog(page).getByLabel("Replies", { exact: true }).fill("0")
      await expect(dialog(page).getByRole("button", { name: "Start", exact: true })).toBeDisabled()
      await dialog(page).getByLabel("Replies", { exact: true }).fill("2")
      await expect(dialog(page).locator("[data-auto-sends]")).toContainText("Sends up to 2 replies")
      await page.mouse.move(0, 0)
      if (shots) await page.screenshot({ path: `${shots}/dialog-${width}-${colorScheme}.png` })
      await expectLayout(page, test.info(), `auto-dialog-${width}-${colorScheme}`, { scope: '[role="dialog"]' })
      // Opening the dialog sent nothing.
      expect(provider.completions.length).toBe(before)

      provider.hold()
      await dialog(page).getByRole("button", { name: "Start", exact: true }).click()
      await expect(row(page)).toContainText("Reply 1 of 2.")
      await expect(row(page).getByRole("button", { name: "Stop", exact: true })).toBeVisible()
      await expect(chip(page)).toBeDisabled()
      await page.mouse.move(0, 0)
      if (shots) await page.screenshot({ path: `${shots}/running-${width}-${colorScheme}.png` })
      await expectLayout(page, test.info(), `auto-running-${width}-${colorScheme}`)
      provider.release()

      await expect(row(page)).toContainText("Done: 2 replies.", { timeout: 30_000 })
      await expect(row(page)).toContainText("About 12 tokens written.")
      await expect(messages(page)).toHaveCount(3)
      expect(provider.completions.length).toBe(before + 2)
      await expect(row(page).getByRole("button", { name: "Continue", exact: true })).toHaveCount(0)
      if (shots) await page.screenshot({ path: `${shots}/done-${width}-${colorScheme}.png` })
      await expectLayout(page, test.info(), `auto-done-${width}-${colorScheme}`)
      await staysAt(before + 2)
      await row(page).getByRole("button", { name: "Dismiss", exact: true }).click()
      await expect(row(page)).toHaveCount(0)
      await expect(chip(page)).toBeEnabled()
    })

test("the token limit ends a run before its replies run out", async ({ page }) => {
  const chatId = await chatOf(["Mira", "Wren", "Ash"])
  await page.goto(`${server().url}/chats/${chatId}`)
  await expect(messages(page)).toHaveCount(1)
  const before = provider.completions.length
  // Each reply of the fake model writes 6 tokens.
  await start(page, 5, 10)
  await expect(row(page)).toContainText("Stopped after 2 of 5: the token limit was reached.", { timeout: 30_000 })
  await expect(messages(page)).toHaveCount(3)
  const requests = provider.completions.slice(before) as ReadonlyArray<Record<string, unknown>>
  expect(requests[0]!["max_tokens"] ?? requests[0]!["max_completion_tokens"]).toBe(10)
  expect(requests[1]!["max_tokens"] ?? requests[1]!["max_completion_tokens"]).toBe(4)
  await staysAt(before + 2)
  await expect(row(page).getByRole("button", { name: "Continue", exact: true })).toHaveCount(0)
})

test("typing ends a run; Continue carries on only when clicked, and Stop stops the reply", async ({ page }) => {
  test.setTimeout(120_000)
  const chatId = await chatOf(["Mira", "Wren", "Ash"])
  await page.goto(`${server().url}/chats/${chatId}`)
  await expect(messages(page)).toHaveCount(1)
  const before = provider.completions.length
  provider.hold()
  await start(page, 5)
  await expect(row(page)).toContainText("Reply 1 of 5.")
  await expect.poll(() => provider.completions.length).toBe(before + 1)
  await box(page).fill("Wait")
  await expect(row(page)).toContainText("Stopped after 0 of 5: you started typing.")
  // The reply being written finishes like any reply; nothing follows it.
  provider.release()
  await expect(messages(page).last().getByText("The tide is turning.")).toBeVisible()
  await expect(messages(page)).toHaveCount(2)
  await staysAt(before + 1)

  const carryOn = row(page).getByRole("button", { name: "Continue", exact: true })
  await expect(carryOn).toBeDisabled()
  await box(page).fill("")
  await expect(carryOn).toBeEnabled()
  await staysAt(before + 1)

  provider.hold()
  await carryOn.click()
  await expect(row(page)).toContainText("of 5.")
  await expect.poll(() => provider.completions.length).toBe(before + 2)
  await row(page).getByRole("button", { name: "Stop", exact: true }).click()
  await expect(row(page)).toContainText(/Stopped after \d of 5\./)
  provider.release()
  await staysAt(before + 2)
})

test("a run belongs to its tab: a reload ends it", async ({ page }) => {
  const chatId = await chatOf(["Mira", "Wren", "Ash"])
  await page.goto(`${server().url}/chats/${chatId}`)
  await expect(messages(page)).toHaveCount(1)
  const before = provider.completions.length
  provider.hold()
  await start(page, 5)
  await expect.poll(() => provider.completions.length).toBe(before + 1)
  await page.reload()
  await expect(box(page)).toBeVisible()
  await expect(row(page)).toHaveCount(0)
  provider.release()
  await expect(messages(page).last().getByText("The tide is turning.")).toBeVisible()
  await staysAt(before + 1)
})

for (const change of ["earlier edit", "branch switch", "navigation"] as const)
  test(`an auto run ends on ${change}, even with its own reply still running`, async ({ page }) => {
    const chatId = await chatOf(["Mira", "Wren", "Ash"])
    await page.goto(`${server().url}/chats/${chatId}`)
    await expect(messages(page)).toHaveCount(1)
    const before = provider.completions.length
    provider.hold()
    await start(page, 5)
    await expect.poll(() => provider.completions.length).toBe(before + 1)
    if (change === "earlier edit") {
      await admin((api) =>
        Effect.gen(function* () {
          const chat = yield* api.GetChat({ chatId })
          const path = yield* api.ReadPath({
            chatId,
            forkId: chat.currentForkId,
            leafSlotId: null,
            range: { _tag: "Bottom" },
            limit: 10
          })
          const first = path.entries[0]!
          yield* api.AmendVersion({
            versionId: first.version.id,
            forkId: chat.currentForkId,
            content: "The user edits an earlier line.",
            expectedRowVersion: first.version.rowVersion
          })
        })
      )
      await expect(row(page)).toHaveAttribute("data-auto-run", "moved")
    } else if (change === "branch switch") {
      const branch = await admin((api) =>
        Effect.gen(function* () {
          const chat = yield* api.GetChat({ chatId })
          return yield* api.CreateFork({ chatId, fromForkId: chat.currentForkId, atSlotId: chat.activeLeafSlotId })
        })
      )
      await page.goto(`${server().url}/chats/${chatId}?fork=${branch.fork.id}`)
    } else await page.goto(server().url)
    provider.release()
    await staysAt(before + 1)
  })

test("a draft blocks Start and two tabs cannot queue auto replies", async ({ page, context }) => {
  const chatId = await chatOf(["Mira", "Wren", "Ash"])
  await page.goto(`${server().url}/chats/${chatId}`)
  await expect(messages(page)).toHaveCount(1)
  const before = provider.completions.length
  await box(page).fill("An unsent draft.")
  await chip(page).click()
  await expect(dialog(page).getByRole("button", { name: "Start", exact: true })).toBeDisabled()
  expect(provider.completions.length).toBe(before)
  await dialog(page).getByRole("button", { name: "Cancel", exact: true }).click()
  await box(page).fill("")
  const other = await context.newPage()
  await other.goto(`${server().url}/chats/${chatId}`)
  await expect(messages(other)).toHaveCount(1)
  provider.hold()
  await start(page, 5)
  await expect.poll(() => provider.completions.length).toBe(before + 1)
  const rejected = await admin((api) =>
    Effect.gen(function* () {
      const chat = yield* api.GetChat({ chatId })
      return yield* Effect.flip(
        api.Generate({
          chatId,
          forkId: chat.currentForkId,
          parentSlotId: chat.activeLeafSlotId,
          branch: false,
          immediate: true
        })
      )
    })
  )
  expect(rejected._tag).toBe("LeafMoved")
  await row(page).getByRole("button", { name: "Stop", exact: true }).click()
  provider.release()
  await staysAt(before + 1)
  await expect(messages(other)).toHaveCount(2)
  await other.close()
})

test("the unsent Auto dialog and bounds survive reload without starting a run", async ({ page }) => {
  const chatId = await chatOf(["Mira", "Wren", "Ash"])
  await page.goto(`${server().url}/chats/${chatId}`)
  await expect(messages(page)).toHaveCount(1)
  const before = provider.completions.length
  await chip(page).click()
  await dialog(page).getByLabel("Replies", { exact: true }).fill("3")
  await dialog(page).getByLabel("Token limit (optional)", { exact: true }).fill("20")
  await page.reload()
  await expect(dialog(page)).toBeVisible()
  await expect(dialog(page).getByLabel("Replies", { exact: true })).toHaveValue("3")
  await expect(dialog(page).getByLabel("Token limit (optional)", { exact: true })).toHaveValue("20")
  await expect(row(page)).toHaveCount(0)
  await staysAt(before)
})

test("changing the account's chosen model ends an auto run", async ({ page }) => {
  const chatId = await chatOf(["Mira", "Wren", "Ash"])
  const defaults = await admin((api) => api.GetGenerationDefaults())
  await page.goto(`${server().url}/chats/${chatId}`)
  await expect(messages(page)).toHaveCount(1)
  await expect(chip(page)).toBeVisible()
  const before = provider.completions.length
  provider.hold()
  await start(page, 5)
  await expect.poll(() => provider.completions.length).toBe(before + 1)
  try {
    await admin((api) =>
      Effect.gen(function* () {
        const model = (yield* api.ListModels({ connectionId: defaults.model!.connection, includeHidden: false })).find(
          (model) => model.key === "fake-large"
        )!
        yield* api.SetGenerationDefaults({
          defaults: { ...defaults, model: { connection: model.connectionId, model: model.id } }
        })
      })
    )
    await expect(row(page)).toHaveAttribute("data-auto-run", "moved")
    provider.release()
    await staysAt(before + 1)
  } finally {
    await admin((api) => api.SetGenerationDefaults({ defaults }))
  }
})

// A reply's cost in its header (msgcost1): "$0.012" after the time and before the model's mark,
// from the usage ledger, opening the Generation panel with the cost, how it was priced, the
// input split into uncached, cache read and cache write, and the share cached. Nothing for an
// import or the user's turn. It never adds a line: the message keeps its height with it shown
// or hidden, at 1440 and 390, light and dark, both Message spacing modes, solo and group. Its
// switch in the Interface settings, with its hover explanation. Synthetic ST files only.
import { expect, type Locator, type Page, test } from "@playwright/test"
import type { ConnectionId, ModelId } from "@dreamspan/shared/providers.ts"
import { Effect } from "effect"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { card, encode, header, jsonl } from "../../server/test/support/stFolder.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { type FakeProvider, REPLY, startProvider } from "./support/provider.ts"
import { asUser, loginCookie } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
let provider: FakeProvider

const shoot = async (page: Page, name: string) => {
  if (!process.env.SCREENSHOT_DIR) return
  mkdirSync(process.env.SCREENSHOT_DIR, { recursive: true })
  await page.screenshot({ path: join(process.env.SCREENSHOT_DIR, `${name}.png`) })
}

const iso = (at: number) => new Date(at).toISOString()
const T0 = Date.now() - 3_600_000
let n = 0
const reply = (name: string, mes: string) => {
  const end = T0 + ++n * 60_000
  const info = {
    send_date: iso(end),
    gen_started: iso(end - 9000),
    gen_finished: iso(end),
    extra: { api: "claude", model: "claude-sonnet-4-5", token_count: 120 + n }
  }
  return { name, is_user: false, mes, ...info, swipe_id: 0, swipes: [mes], swipe_info: [info] }
}
const user = (mes: string) => ({
  name: "Sam",
  is_user: true,
  mes,
  send_date: iso(T0 + ++n * 60_000),
  extra: { token_count: 9 }
})
const solo = [
  header({}),
  reply("Mira", "Hi."),
  user("Hi."),
  reply("Mira", "Fine."),
  user("Go on."),
  reply("Mira", "Yes.")
]
const group = [
  header({}),
  reply("Mira", "Hi."),
  user("Hello both."),
  { ...reply("Bob", "Hm."), original_avatar: "Bob.png" },
  user("Ok."),
  { ...reply("Bob", "Sure."), original_avatar: "Bob.png" }
]

const lastReply = (page: Page) => page.getByRole("article", { name: "Reply" }).last()
const costOf = (message: Locator) => message.locator("header").getByRole("button", { name: /^Cost: / })
const tip = (page: Page, text: string | RegExp) => page.getByText(text).filter({ visible: true }).last()
const box = async (locator: Locator) => (await locator.boundingBox())!
/** Every message's height and its header's, top to bottom. */
const heights = (page: Page) =>
  page
    .locator("article")
    .evaluateAll((articles) =>
      articles.map((a) => [a.getBoundingClientRect().height, a.querySelector("header")!.getBoundingClientRect().height])
    )
const setDetails = (prefs: Record<string, unknown>) =>
  asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.SetDisplayPrefs({ prefs }))

test.setTimeout(600_000)

test.beforeAll(async () => {
  // $0.0123 a reply, as the provider reports it; 120 input tokens, 100 of them read from the cache.
  provider = await startProvider({ usageCost: 0.0123 })
})
test.afterAll(async () => {
  await provider.stop()
})

test("a reply's cost sits in its header, opens the panel, and never adds a line", async ({ page }, info) => {
  const { importId } = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: "Local server",
          baseUrl: provider.baseUrl,
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        },
        apiKey: "sk-msgcost-test-key"
      })
      yield* api.RefreshModels({ connectionId: connection.id })
      const model = (yield* api.ListModels({ connectionId: connection.id, includeHidden: false })).find(
        (m) => m.key === "fake-large"
      )!
      yield* api.SetGenerationDefaults({
        defaults: { model: { connection: connection.id, model: model.id }, preset: null }
      })
      return yield* api.StartStImport({ unsupported: [] })
    })
  )
  const cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
  const upload = async (path: string, body: Uint8Array) => {
    const response = await fetch(`${server().url}/st-import/file?${new URLSearchParams({ import: importId, path })}`, {
      method: "POST",
      headers: { origin: server().url, cookie, "content-type": "application/octet-stream" },
      body: new Uint8Array(body)
    })
    expect(response.status).toBe(200)
  }
  await upload("characters/Mira.png", card("Mira", "Hi."))
  await upload("characters/Bob.png", card("Bob", "Hm."))
  await upload("chats/Mira/Ledger.jsonl", jsonl(solo))
  await upload(
    "groups/g1.json",
    encode({
      id: "g1",
      name: "Party",
      members: ["Mira.png", "Bob.png"],
      disabled_members: [],
      chats: ["Party ledger"],
      chat_id: "Party ledger"
    })
  )
  await upload("group chats/Party ledger.jsonl", jsonl(group))
  await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      yield* api.FinishStImport({ importId, notSent: [] })
      yield* api.SeenStImport({ importId })
    })
  )
  const list = () => asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.ListChats({ limit: 20, before: null }))
  await expect.poll(async () => (await list()).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(2)
  const chats = await list()
  const ids = {
    solo: chats.find((c) => c.title === "Ledger")!.id,
    group: chats.find((c) => c.title !== "Ledger")!.id
  }
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.setViewportSize({ width: 1440, height: 900 })
  // The panel's screenshots show it open, not fading in.
  await page.emulateMedia({ reducedMotion: "reduce" })

  // A version of the last reply generated here in each chat: it has a cost; the imports don't.
  for (const id of Object.values(ids)) {
    await page.goto(`${server().url}/chats/${id}`)
    const last = lastReply(page)
    await last.hover()
    await last.getByRole("button", { name: "Generate another swipe" }).click()
    await expect(last).toContainText(REPLY)
    await expect(last.getByText("generating", { exact: true })).toHaveCount(0)
    await expect(costOf(last)).toHaveText("$0.012")
    await expect(page.locator("article header").getByRole("button", { name: /^Cost: / })).toHaveCount(1)
    await expect(
      page.getByRole("article", { name: "Your message" }).getByRole("button", { name: /^Cost: / })
    ).toHaveCount(0)
  }

  // After the time, before the model's mark, on the same line.
  const last = lastReply(page)
  const head = last.locator("header")
  const time = await box(head.locator("time"))
  const cost = await box(costOf(last))
  const mark = await box(head.locator("[data-model-mark]"))
  expect(cost.x).toBeGreaterThan(time.x + time.width - 1)
  expect(mark.x).toBeGreaterThan(cost.x + cost.width - 1)
  expect(Math.abs(cost.y + cost.height / 2 - (time.y + time.height / 2))).toBeLessThan(2)

  // Its hover lists the figures; a click opens them in the Generation panel.
  await costOf(last).hover()
  await expect(tip(page, "Cost: $0.012")).toBeVisible()
  await expect(tip(page, "Input tokens: 120 (20 uncached, 100 cache read, 0 cache write)")).toBeVisible()
  await page.mouse.move(0, 0)
  await costOf(last).click()
  const panel = page.getByRole("dialog", { name: "Generation" })
  await expect(panel).toBeVisible()
  for (const [label, value] of [
    ["Cost", "$0.012"],
    ["Priced by", "the provider's charge"],
    ["Input tokens", "120 (20 uncached, 100 cache read, 0 cache write)"],
    ["Cached", "83% of input"],
    // The Generation panel reports reasoning separately when it occurs (972e6a189).
    ["Output tokens", "6"],
    ["Reasoning", "none"]
  ] as const)
    await expect(panel.locator("dt", { hasText: label }).locator("+ dd")).toHaveText(value)
  await expect(panel).not.toContainText("Provider charged")
  await shoot(page, "panel-group-1440")
  if (process.env.LAYOUT_AUDIT) await expectLayout(page, info, "cost-panel-1440", { hovered: true })
  await page.keyboard.press("Escape")
  await page.setViewportSize({ width: 390, height: 844 })
  await costOf(last).click()
  await expect(panel).toBeVisible()
  await shoot(page, "panel-group-390")
  if (process.env.LAYOUT_AUDIT) await expectLayout(page, info, "cost-panel-390", { hovered: true })
  await page.keyboard.press("Escape")

  // Every surface: the same heights with the cost shown and hidden, the layout audit passing.
  for (const density of ["comfortable", "compact"] as const)
    for (const [which, id] of Object.entries(ids))
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 1000 })
        const measured: Array<Array<Array<number>>> = []
        for (const shown of [false, true]) {
          await setDetails({ chatDensity: density, messageDetails: { "message.cost": shown } })
          for (const theme of ["light", "dark"] as const) {
            await page.emulateMedia({ colorScheme: theme })
            await page.goto(`${server().url}/chats/${id}`)
            await page.evaluate((value) => localStorage.setItem("dreamspan.theme", value), theme)
            await page.reload()
            await expect(lastReply(page)).toContainText(REPLY)
            await expect(costOf(lastReply(page))).toHaveCount(shown ? 1 : 0)
            await page.mouse.move(0, 0)
            if (!shown) {
              if (theme === "light") measured.push(await heights(page))
              continue
            }
            await expect(costOf(lastReply(page))).toHaveText("$0.012")
            if (theme === "light") measured.push(await heights(page))
            // The header keeps one line for the time, the cost and the model at any width.
            const row = lastReply(page).locator("header")
            const offset = await row.evaluate((header) => {
              const at = header.querySelector("time")!.getBoundingClientRect()
              const cost = header.querySelector('button[aria-label^="Cost: "]')!.getBoundingClientRect()
              return Math.abs(cost.y - at.y)
            })
            expect(offset, `${which} ${density} ${width} ${theme}: cost is on the time's line`).toBeLessThan(2)
            expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
            const name = `${which}-${density}-${width}-${theme}`
            await shoot(page, name)
            if (process.env.LAYOUT_AUDIT) await expectLayout(page, info, name, { scope: "article" })
          }
        }
        const [hidden, withCost] = measured
        expect(withCost!.length).toBe(hidden!.length)
        for (const [i, [row, headRow]] of withCost!.entries()) {
          expect(Math.abs(row! - hidden![i]![0]!), `${which} ${density} ${width}: message ${i} height`).toBeLessThan(
            0.5
          )
          expect(Math.abs(headRow! - hidden![i]![1]!), `${which} ${density} ${width}: header ${i}`).toBeLessThan(0.5)
        }
      }

  // Its switch, on by default, explained on hover; off, no message shows a cost.
  await setDetails({ chatDensity: "comfortable", messageDetails: {} })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${server().url}/settings/interface`)
  const details = page.getByRole("group", { name: "Message details" })
  const toggle = details.getByRole("switch", { name: "Cost", exact: true })
  await expect(toggle).toBeChecked()
  await details.getByRole("button", { name: "About Cost", exact: true }).hover()
  await expect(tip(page, /^What a reply written here cost/)).toBeVisible()
  await shoot(page, "settings-1440")
  await toggle.click()
  await expect(toggle).not.toBeChecked()
  await expect
    .poll(
      async () =>
        (await asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.GetDisplayPrefs({}))).messageDetails[
          "message.cost"
        ]
    )
    .toBe(false)
  await page.goto(`${server().url}/chats/${ids.solo}`)
  await expect(lastReply(page)).toContainText(REPLY)
  await expect(page.locator("article header").getByRole("button", { name: /^Cost: / })).toHaveCount(0)
})

// Where the header wraps (a phone), a longer connection name filled the time's line, so the
// cost pushed the model's label onto a third line between about 328 and 368 px. Neither the
// cost nor the label starts a line now: at every width the header and message keep the height
// they have with the cost hidden, in both spacing modes.
test("the cost never adds a line at any phone width, with a long connection name", async ({ page }) => {
  const { importId } = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: "Workstation server at home",
          baseUrl: provider.baseUrl,
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        },
        apiKey: "sk-msgcost-test-key"
      })
      yield* api.RefreshModels({ connectionId: connection.id })
      const model = (yield* api.ListModels({ connectionId: connection.id, includeHidden: false })).find(
        (m) => m.key === "fake-large"
      )!
      yield* api.SetGenerationDefaults({
        defaults: { model: { connection: connection.id, model: model.id }, preset: null }
      })
      return yield* api.StartStImport({ unsupported: [] })
    })
  )
  const cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
  for (const [path, body] of [
    ["characters/Mira.png", card("Mira", "Hi.")],
    ["chats/Mira/Wide.jsonl", jsonl([header({}), reply("Mira", "Hi."), user("Go on."), reply("Mira", "Yes.")])]
  ] as const) {
    const response = await fetch(`${server().url}/st-import/file?${new URLSearchParams({ import: importId, path })}`, {
      method: "POST",
      headers: { origin: server().url, cookie, "content-type": "application/octet-stream" },
      body: new Uint8Array(body)
    })
    expect(response.status).toBe(200)
  }
  const list = () => asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.ListChats({ limit: 20, before: null }))
  await expect.poll(async () => (await list()).some((c) => c.title === "Wide"), { timeout: 30_000 }).toBe(true)
  const id = (await list()).find((c) => c.title === "Wide")!.id
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  // The first test turned it off; the choices merge by id.
  await setDetails({ chatDensity: "comfortable", messageDetails: { "message.cost": true } })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${server().url}/chats/${id}`)
  const last = lastReply(page)
  await last.hover()
  await last.getByRole("button", { name: "Generate another swipe" }).click()
  await expect(last).toContainText(REPLY)
  await expect(last.getByText("generating", { exact: true })).toHaveCount(0)
  await expect(costOf(last)).toHaveText("$0.012")

  const widths = Array.from({ length: 41 }, (_, i) => 320 + i * 8)
  for (const density of ["comfortable", "compact"] as const) {
    const measured: Array<Array<Array<Array<number>>>> = []
    for (const shown of [false, true]) {
      await setDetails({ chatDensity: density, messageDetails: { "message.cost": shown } })
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.reload()
      await expect(lastReply(page)).toContainText(REPLY)
      await expect(costOf(lastReply(page))).toHaveCount(shown ? 1 : 0)
      const atWidths: Array<Array<Array<number>>> = []
      for (const width of widths) {
        await page.setViewportSize({ width, height: 900 })
        // Two frames: the model label's observer settles after the resize.
        await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
        atWidths.push(await heights(page))
        if (shown) {
          // Shown in full, on the time's line.
          const cost = costOf(lastReply(page))
          expect(await cost.evaluate((e) => e.scrollWidth <= e.clientWidth), `${density} ${width}: cost clipped`).toBe(
            true
          )
          const at = await box(lastReply(page).locator("header time"))
          expect(Math.abs((await box(cost)).y - at.y), `${density} ${width}: cost off the time's line`).toBeLessThan(2)
        }
      }
      measured.push(atWidths)
    }
    const [hidden, withCost] = measured
    for (const [w, width] of widths.entries())
      for (const [i, [row, headRow]] of withCost![w]!.entries()) {
        expect(Math.abs(row! - hidden![w]![i]![0]!), `${density} ${width}: message ${i} height`).toBeLessThan(0.5)
        expect(Math.abs(headRow! - hidden![w]![i]![1]!), `${density} ${width}: header ${i} height`).toBeLessThan(0.5)
      }
  }
})

// A price list that names its own rate for reasoning tokens (spec/PRICES.md §4.2): the part of the
// reply's output the provider reports as reasoning is priced at it, the rest at the output rate,
// and the cost details say so. Without the field (a model the list prices alone) they don't.
test("a reasoning rate from the server's prices shows in the cost details", async ({ page }) => {
  const priced = await startProvider({
    models: [
      { id: "think-a", name: "think-a", context_length: 32768 },
      { id: "think-b", name: "think-b", context_length: 32768 }
    ],
    // 4 of the 6 output tokens are reasoning; 20 uncached input and 100 cache read.
    reasoningTokens: 4,
    prices: {
      object: "list",
      unit: "USD per 1M tokens",
      data: [
        { id: "think-a", input: 1, output: 10, cache_read: 0.5, reasoning: 4 },
        { id: "think-b", input: 1, output: 10, cache_read: 0.5 }
      ]
    }
  })
  try {
    const models_: Record<string, { connection: ConnectionId; model: ModelId }> = {}
    const made = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
      Effect.gen(function* () {
        const connection = yield* api.CreateConnection({
          kind: "openai-chat",
          settings: {
            name: "Reasoning rates",
            baseUrl: priced.baseUrl,
            compat: {},
            cacheTtlS: null,
            maxConcurrent: null,
            presetOverrideRefId: null,
            providerSettings: { priceEndpoint: true }
          },
          apiKey: "sk-msgcost-test-key"
        })
        yield* api.RefreshModels({ connectionId: connection.id })
        const models = yield* api.ListModels({ connectionId: connection.id, includeHidden: false })
        const chats: Record<string, string> = {}
        for (const key of ["think-a", "think-b"]) {
          const model = models.find((m) => m.key === key)!
          models_[key] = { connection: connection.id, model: model.id }
          const chat = yield* api.CreateChat({ title: `Rate ${key}` })
          const sent = yield* api.SendMessage({
            chatId: chat.id,
            parentSlotId: null,
            branch: false,
            content: "Is the bridge still standing?"
          })
          if (sent._tag !== "Posted") return yield* Effect.die("unexpected queue")
          chats[key] = chat.id
        }
        return { chats, models: models_ }
      })
    )
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await setDetails({ chatDensity: "comfortable", messageDetails: { "message.cost": true } })
    await page.setViewportSize({ width: 1440, height: 900 })
    for (const [key, cost, reasoningRow] of [
      // (20 + 100 * 0.5 + 2 * 10 + 4 * 4) / 1e6, then (20 + 50 + 6 * 10) / 1e6.
      ["think-a", "$0.00011", "$4.00 per million tokens (its own rate, not the output rate)"],
      ["think-b", "$0.00013", null]
    ] as const) {
      // A reply uses the default model when it's asked for.
      await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        api.SetGenerationDefaults({ defaults: { model: made.models[key]!, preset: null } })
      )
      await page.goto(`${server().url}/chats/${made.chats[key]}`)
      await page
        .getByRole("button", { name: /^(Reply$|Generate(?! another))/ })
        .last()
        .click()
      const reply = lastReply(page)
      await expect(reply).toContainText(REPLY)
      await expect(reply.getByText("generating", { exact: true })).toHaveCount(0)
      await expect(costOf(reply)).toHaveText(cost)
      await costOf(reply).click()
      const panel = page.getByRole("dialog", { name: "Generation" })
      await expect(panel).toBeVisible()
      await expect(panel.locator("dt", { hasText: "Priced by" }).locator("+ dd")).toContainText(
        "this server's price list"
      )
      const row = panel.locator("dt", { hasText: "Reasoning priced at" })
      if (reasoningRow === null) await expect(row).toHaveCount(0)
      else await expect(row.locator("+ dd")).toHaveText(reasoningRow)
      await page.keyboard.press("Escape")
    }
  } finally {
    await priced.stop()
  }
})

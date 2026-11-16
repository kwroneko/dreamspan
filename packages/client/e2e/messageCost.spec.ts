// A reply's cost in its header (msgcost1): "$0.012" after the time and before the model's mark,
// from the usage ledger, opening the Generation panel with the cost, how it was priced, the
// input split into uncached, cache read and cache write, and the share cached. Nothing for an
// import or the user's turn. It never adds a line: the message keeps its height with it shown
// or hidden, at 1440 and 390, light and dark, both Message spacing modes, solo and group. Its
// switch in the Interface settings, with its hover explanation. Synthetic ST files only.
import { expect, type Locator, type Page, test } from "@playwright/test"
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
    await last.getByRole("button", { name: "Generate another version" }).click()
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
    ["Output tokens", "6, reasoning included"]
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
            await page.evaluate((value) => localStorage.setItem("rp.theme", value), theme)
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
            const at = await box(row.locator("time"))
            const c = await box(costOf(lastReply(page)))
            expect(Math.abs(c.y - at.y)).toBeLessThan(2)
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

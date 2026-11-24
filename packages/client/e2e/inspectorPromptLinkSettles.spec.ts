// A preset prompt's source link in the request inspector lands on that prompt's header and stays
// there (owner, 2026-11-24): with long prompts above it and a much longer one right below, the
// editors above grew after the jump and left the view mid-way through the prompt below.
// Against the production server and a fake OpenAI-compatible provider; everything is made up.
import { readFileSync } from "node:fs"
import type { ChatId, VersionId } from "@dreamspan/shared/chat.ts"
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { type FakeProvider, startProvider } from "./support/provider.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { scrollUntil } from "./support/scrollPane.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
let provider: FakeProvider
let chat: { readonly id: ChatId; readonly reply: VersionId }

const long = (what: string, lines: number) =>
  Array.from(
    { length: lines },
    (_, i) => `${what}, line ${i + 1}: the tide charts are kept in the harbor office.`
  ).join("\n")

// Two long prompts above the target, a short target, and a much longer prompt right below it.
const preset = (() => {
  const file = JSON.parse(
    readFileSync(new URL("../../server/test/fixtures/presets/default.json", import.meta.url), "utf8")
  ) as {
    prompts: Array<{ identifier: string; name?: string; content?: string; enabled?: boolean }>
    prompt_order: Array<{ order: Array<{ identifier: string; enabled: boolean }> }>
  }
  for (const prompt of file.prompts) {
    if (prompt.identifier === "main") prompt.content = long("Main", 60)
    if (prompt.identifier === "enhanceDefinitions") {
      prompt.content = long("Definitions", 60)
      prompt.enabled = true
    }
    if (prompt.identifier === "nsfw") {
      prompt.name = "Database"
      prompt.content = "The ledger lists every boat in the harbor."
    }
    if (prompt.identifier === "jailbreak") prompt.content = long("Rules", 200)
  }
  const first = ["main", "enhanceDefinitions", "nsfw", "jailbreak"]
  for (const entry of file.prompt_order) {
    const rest = entry.order.filter((item) => !first.includes(item.identifier))
    entry.order = [...first.map((identifier) => ({ identifier, enabled: true })), ...rest]
  }
  return file
})()

const upload = async (name: string, data: unknown) => {
  const login = await fetch(`${server().url}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(ADMIN)
  })
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!
  const response = await fetch(`${server().url}/library/import?name=${encodeURIComponent(name)}.json`, {
    method: "POST",
    headers: { origin: server().url, cookie, "content-type": "application/octet-stream" },
    body: JSON.stringify(data)
  })
  expect(response.status).toBe(200)
}

test.beforeAll(async () => {
  provider = await startProvider()
  await upload("Ledger preset", preset)
  await upload("Mira", {
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: { name: "Mira", description: "{{char}} keeps the harbor ledger.", first_mes: "*Mira looks up.*" }
  })
  chat = await admin((api) =>
    Effect.gen(function* () {
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: "Local model server",
          baseUrl: provider.baseUrl,
          compat: {},
          cacheTtlS: 300,
          maxConcurrent: null,
          presetOverrideRefId: null
        },
        apiKey: "sk-prompt-link-test-0042"
      })
      const model = yield* api.AddUserModel({ connectionId: connection.id, key: "fake-small", overrides: {} })
      const ledger = (yield* api.ListLibrary({ kind: "preset" })).find((r) => r.label === "Ledger preset")!
      yield* api.SetGenerationDefaults({
        defaults: { model: { connection: connection.id, model: model.id }, preset: ledger.id }
      })
      const mira = (yield* api.ListCards()).find((card) => card.label === "Mira")!
      const started = yield* api.StartChat({
        cards: [mira.entityId],
        persona: null,
        greeting: 0,
        first: { _tag: "Send", content: "The road flooded.", speakerEntityId: null }
      })
      const reply = yield* api.Generate({ chatId: started.chat.id, parentSlotId: started.entry.slotId, branch: false })
      if (reply._tag !== "Posted") return yield* Effect.die(new Error("the reply was queued"))
      return { id: started.chat.id, reply: reply.entry.version.id }
    })
  )
})
test.afterAll(async () => {
  await provider.stop()
})

/** The target's header top, from the top of the pane that scrolls it, every frame for `ms`. */
const tops = (page: Page, ms: number) =>
  page.evaluate(
    (ms) =>
      new Promise<Array<number>>((resolve) => {
        const seen: Array<number> = []
        const until = performance.now() + ms
        const sample = () => {
          const block = document.querySelector<HTMLElement>('[data-prompt="nsfw"]')
          let scroll = block?.parentElement
          while (scroll && !/auto|scroll/.test(getComputedStyle(scroll).overflowY)) scroll = scroll.parentElement
          seen.push(
            block && scroll ? block.getBoundingClientRect().top - scroll.getBoundingClientRect().top : Number.NaN
          )
          if (performance.now() < until) requestAnimationFrame(sample)
          else resolve(seen)
        }
        requestAnimationFrame(sample)
      }),
    ms
  )

for (const width of [1440, 390]) {
  test(`at ${width}px the link lands on the prompt's header and it stays at the top`, async ({ page }) => {
    await page.setViewportSize({ width, height: width < 600 ? 844 : 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/chats/${chat.id}/context/${chat.reply}`)
    const messages = page.getByRole("region", { name: "Messages" })
    const link = await scrollUntil(
      messages,
      messages.getByRole("link", { name: "Preset prompt “Database”", exact: true }).first()
    )
    await link.scrollIntoViewIfNeeded()
    await link.click()
    await expect(page).toHaveURL(/\/library\/[^?]+\?focus=nsfw$/)
    const block = page.locator('[data-prompt="nsfw"]')
    await expect(block.getByRole("textbox").first()).toContainText("The ledger lists every boat in the harbor.")
    await expect(block).toBeInViewport()
    // Through the jump and the layout settling, and for a second after: the header near the top.
    const settling = await tops(page, 1000)
    const settled = await tops(page, 1000)
    for (const top of [...settling.slice(-10), ...settled]) {
      expect(top).toBeGreaterThanOrEqual(-2)
      expect(top).toBeLessThanOrEqual(160)
    }
    // No drift once settled.
    expect(Math.max(...settled) - Math.min(...settled)).toBeLessThanOrEqual(1)
  })
}

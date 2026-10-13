import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import type { ChatId, PathEntry } from "@rp/shared/chat.ts"
import type { RefId } from "@rp/shared/library.ts"
import { asUser, loginCookie } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { startProvider, type FakeProvider, REPLY } from "./support/provider.ts"

const server = serverPerFile(withAdmin)
let provider: FakeProvider
let chatId: ChatId
let entries: ReadonlyArray<PathEntry>

test.beforeAll(async () => {
  provider = await startProvider()
  const cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
  const headers = { origin: server().url, cookie, "content-type": "application/octet-stream" }
  const preset = await fetch(`${server().url}/library/import?name=Stepped.json`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      openai_max_context: 400,
      openai_max_tokens: 40,
      frequency_penalty: 0
    })
  })
  expect(preset.status).toBe(200)
  const refId = ((await preset.json()) as { library: { ref: { id: RefId } } }).library.ref.id
  const { importId } = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.StartStImport({ unsupported: [] })
  )
  const body = [
    { chat_metadata: {} },
    ...Array.from({ length: 12 }, (_, i) => ({
      name: "User",
      is_user: true,
      is_system: i === 0,
      send_date: "2026-01-01T00:00:00.000Z",
      mes: `Turn ${i}: ${"r".repeat(100)}`
    }))
  ]
    .map((line) => JSON.stringify(line))
    .join("\n")
  const imported = await fetch(
    `${server().url}/st-import/file?${new URLSearchParams({ import: importId, path: "group chats/Stepped.jsonl" })}`,
    { method: "POST", headers, body }
  )
  expect(imported.status).toBe(200)
  expect((await imported.json()) as object).toMatchObject({ outcome: "added" })
  await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: "No TTL",
          baseUrl: provider.baseUrl,
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        }
      })
      const model = yield* api.AddUserModel({ connectionId: connection.id, key: "fake-small", overrides: {} })
      yield* api.SetGenerationDefaults({
        defaults: { model: { connection: connection.id, model: model.id }, preset: refId }
      })
      const chats = yield* api.ListChats({ limit: 10, before: null })
      chatId = chats[0]!.id
      entries = (yield* api.ReadPath({ chatId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 50 })).entries
    })
  )
})
test.afterAll(async () => {
  await provider.stop()
})

test("dropped messages have a faded border and accessible icon distinct from hidden messages", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chatId}?slot=${entries[1]!.slotId}`)
  const dropped = page.locator(`article[data-slot="${entries[1]!.slotId}"]`)
  await expect(dropped).toHaveAttribute("data-out-of-context", "true")
  await expect(dropped).toHaveClass(/text-muted.*border-dashed/)
  await expect(dropped.getByRole("img", { name: "Not in the context", exact: true })).toBeVisible()
  const hidden = page.locator(`article[data-slot="${entries[0]!.slotId}"]`)
  await expect(hidden.getByRole("img", { name: "Hidden from context", exact: true })).toBeVisible()
  await expect(hidden).not.toHaveAttribute("data-out-of-context")
  await expect(hidden.getByRole("img", { name: "Not in the context", exact: true })).toHaveCount(0)
})

test("a changed prefix shows the rewrite estimate without a TTL or countdown", async ({ page }) => {
  await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.Generate({ chatId, parentSlotId: entries.at(-1)!.slotId, branch: false })
  )
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chatId}`)
  const reply = page.getByRole("article", { name: "Reply" }).filter({ hasText: REPLY })
  await expect(reply).toContainText(REPLY)
  await expect(reply.getByText(/notes? on its context/)).toHaveCount(0)
  // The last user turn remains in the reusable prefix; same-length text does not move the start.
  await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.AmendVersion({
      versionId: entries.at(-1)!.version.id,
      content: `Turn 11: ${"s".repeat(100)}`,
      expectedRowVersion: 1
    })
  )
  const estimate = page.getByRole("region", { name: "Cache estimate" })
  await expect(estimate).toContainText("Cache rewrite (estimate)")
  await expect(estimate).toContainText(/Next send rewrites ~[\d,]+ tokens/)
  await expect(estimate).not.toContainText(/\d:\d\d left/)
  await expect(estimate.getByRole("button", { name: /countdown/ })).toHaveCount(0)
  await reply.getByRole("link", { name: "Context" }).click()
  await expect(page.getByText(/older ones don't fit/)).toBeVisible()
})

test("two tabs and an inactive-path deep link keep their own context boundary", async ({ page, context }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const longLeaf = entries.at(-1)!.slotId
  const url = `${server().url}/chats/${chatId}?leaf=${longLeaf}&slot=${entries[1]!.slotId}`
  await page.goto(url)
  const dropped = page.locator(`article[data-slot="${entries[1]!.slotId}"]`)
  await expect(dropped).toHaveAttribute("data-out-of-context", "true")
  const branch = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.SendMessage({ chatId, parentSlotId: entries[0]!.slotId, branch: true, content: "Short branch." })
  )
  expect(branch._tag).toBe("Posted")
  if (branch._tag !== "Posted") throw new Error("expected posted branch")
  const other = await context.newPage()
  await other.goto(`${server().url}/chats/${chatId}?leaf=${branch.entry.slotId}`)
  await expect(other.getByText("Short branch.", { exact: true })).toBeVisible()
  await expect(other.locator('[data-out-of-context="true"]')).toHaveCount(0)
  await page.reload()
  await expect(dropped).toHaveAttribute("data-out-of-context", "true")
  await expect(dropped.getByRole("img", { name: "Not in the context", exact: true })).toBeVisible()
  await expect(page.getByRole("img", { name: "Hidden from context", exact: true })).toBeVisible()
  await other.reload()
  await expect(other.locator('[data-out-of-context="true"]')).toHaveCount(0)
  await expect(dropped).toHaveAttribute("data-out-of-context", "true")
  await other.close()
})

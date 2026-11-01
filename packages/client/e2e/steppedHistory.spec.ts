import { fixtureSql } from "../../server/test/support/lcmFixtures.ts"
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import type { ChatId, ForkId, PathEntry } from "@rp/shared/chat.ts"
import type { RefId } from "@rp/shared/library.ts"
import { asUser, loginCookie } from "./support/rpc.ts"
import { messageMenu } from "./support/message.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { cacheChip } from "./support/strip.ts"
import { startProvider, type FakeProvider, REPLY } from "./support/provider.ts"

const server = serverPerFile(withAdmin)
let provider: FakeProvider
let chatId: ChatId
let originalFork: ForkId
let entries: ReadonlyArray<PathEntry>

test.beforeAll(async () => {
  provider = await startProvider()
  const cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
  const headers = { origin: server().url, cookie, "content-type": "application/octet-stream" }
  const preset = await fetch(`${server().url}/library/import?name=Stepped.json`, {
    method: "POST",
    headers,
    body: JSON.stringify({ frequency_penalty: 0 })
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
      // The small budget is the model's own setting; the prompt preset carries none.
      const model = yield* api.AddUserModel({
        connectionId: connection.id,
        key: "fake-small",
        overrides: { settings: { samplers: { openai_max_context: 400, openai_max_tokens: 40 } } }
      })
      yield* api.SetGenerationDefaults({
        defaults: { model: { connection: connection.id, model: model.id }, preset: refId }
      })
      const chats = yield* api.ListChats({ limit: 10, before: null })
      chatId = chats[0]!.id
      originalFork = chats[0]!.currentForkId!
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
  const next = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.GetNextContext({ chatId, leafSlotId: null })
  )
  const firstSent = entries.find((e) => e.depth >= next.historyStart!.depth)!
  await page.goto(`${server().url}/chats/${chatId}?slot=${firstSent.slotId}`)
  const explanation = page.getByRole("status").filter({ hasText: "aren’t sent to the model: the model’s context" })
  await expect(explanation).toContainText("context budget allows 400 tokens")
  const sent = page.locator(`article[data-slot="${firstSent.slotId}"]`)
  await expect(sent).toBeVisible()
  await expect(sent).not.toHaveAttribute("data-out-of-context")
  expect((await explanation.boundingBox())!.y).toBeLessThan((await sent.boundingBox())!.y)
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
  const chip = cacheChip(page)
  await expect(chip).toHaveAccessibleName(/^Cache: [\d,]+ tokens uncached on the next reply/)
  await expect(chip).toHaveText(/^↻ [\d.]+k? uncached$/)
  await chip.click()
  const estimate = page.getByRole("dialog", { name: "Not cached", exact: true })
  await expect(estimate).toContainText(/Your next reply re-sends about [\d,]+ tokens at full price/)
  await expect(estimate).toContainText("Why: ")
  await expect(estimate).not.toContainText(/\d:\d\d/)
  await expect(estimate.getByRole("button", { name: /countdown/ })).toHaveCount(0)
  await page.keyboard.press("Escape")
  await expect(estimate).toHaveCount(0)
  await messageMenu(reply, "Context it was generated from")
  await expect(page.getByText(/older ones don't fit/)).toBeVisible()
})

test("two tabs and an inactive-path deep link keep their own context boundary", async ({ page, context }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const longFork = (await asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.GetChat({ chatId })))
    .currentForkId!
  const url = `${server().url}/chats/${chatId}?fork=${longFork}&slot=${entries[1]!.slotId}`
  await page.goto(url)
  const dropped = page.locator(`article[data-slot="${entries[1]!.slotId}"]`)
  await expect(dropped).toHaveAttribute("data-out-of-context", "true")
  const branch = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.SendMessage({ chatId, parentSlotId: entries[0]!.slotId, branch: true, content: "Short branch." })
  )
  expect(branch._tag).toBe("Posted")
  if (branch._tag !== "Posted") throw new Error("expected posted branch")
  const other = await context.newPage()
  await other.goto(`${server().url}/chats/${chatId}?fork=${branch.chat.currentForkId}`)
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

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`insertion before retained history explains that the next reply cannot see it (${width}px, ${theme})`, async ({
      page
    }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      // Before the summarized test below, which summarizes these messages in this chat: here they're
      // only dropped. The imported branch, named.
      await page.goto(`${server().url}/chats/${chatId}?fork=${originalFork}&slot=${entries[1]!.slotId}`)
      const dropped = page.locator(`article[data-slot="${entries[1]!.slotId}"]`)
      await expect(dropped).toHaveAttribute("data-out-of-context", "true")
      await messageMenu(dropped, "Insert message below")
      const editor = page.getByTestId("insert-editor")
      await expect(editor).toContainText("Before the model's history start: the next reply won't see it.")
      // Nor does the strip's cache chip say what the next reply re-reads from it.
      await expect(page.getByText(/re-reads? (the rest|\d)/)).toHaveCount(0)
      if (process.env.SCREENSHOT_DIR)
        await page.screenshot({
          path: `${process.env.SCREENSHOT_DIR}/insert-before-history-start-${width}-${theme}.png`
        })
      await editor.getByRole("button", { name: "Cancel", exact: true }).click()
    })

test("summarized messages are distinct from dropped and hidden messages", async ({ page }) => {
  await Effect.runPromise(
    fixtureSql(server().dataDir, [
      {
        sql: "INSERT INTO state_events(id,chat_id,seq,key,value_json,origin,created_at) SELECT 'lcm-on',?,coalesce(max(seq),0)+1,'lcm.settings','{\"enabled\":true}','user',1 FROM state_events WHERE chat_id=?",
        params: [chatId, chatId]
      },
      {
        sql: "INSERT INTO summary_revisions(id,summary_id,content,token_count,origin,created_at) VALUES('ui-revision','ui-summary','Synthetic summary.',5,'generated',1)"
      },
      {
        sql: "INSERT INTO summaries(id,chat_id,level,selected_revision_id,first_slot_id,last_slot_id,slot_count,status,created_at) VALUES('ui-summary',?,1,'ui-revision',?,?,3,'complete',1)",
        params: [chatId, entries[0]!.slotId, entries[2]!.slotId]
      },
      ...entries.slice(0, 3).map((entry, i) => ({
        sql: "INSERT INTO summary_inputs(summary_id,ordinal,slot_id,version_id,amend_count) VALUES('ui-summary',?,?,?,0)",
        params: [i, entry.slotId, entry.contextExcluded ? null : entry.version.id]
      })),
      { sql: "UPDATE summaries SET sealed=1 WHERE id='ui-summary'" }
    ])
  )
  const sent = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.SendMessage({
      chatId,
      parentSlotId: entries.at(-1)!.slotId,
      branch: true,
      // Keep the newest turn inside the recent-history allowance (daaa81f
      // refuses dropping it), while older raw messages still leave the context.
      content: "Recent raw material " + "x".repeat(200)
    })
  )
  if (sent._tag !== "Posted") throw new Error("expected posted message")
  const next = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.GetNextContext({ chatId, leafSlotId: sent.entry.slotId, forkId: sent.chat.currentForkId })
  )
  expect(next.historyStart?.depth, JSON.stringify(next.budget)).toBeGreaterThan(entries[3]!.depth)
  expect(next.historyStart?.depth).toBeLessThanOrEqual(sent.entry.depth)
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chatId}?fork=${sent.chat.currentForkId}&slot=${entries[1]!.slotId}`)
  const summarized = page.locator(`article[data-slot="${entries[1]!.slotId}"]`)
  await expect(summarized).toHaveAttribute("data-summarized", "true")
  await expect(summarized.getByRole("img", { name: /^Summarized/ })).toBeVisible()
  await expect(summarized).not.toHaveAttribute("data-out-of-context")
  const hidden = page.locator(`article[data-slot="${entries[0]!.slotId}"]`)
  await expect(hidden.getByRole("img", { name: "Hidden from context", exact: true })).toBeVisible()
  await expect(hidden).not.toHaveAttribute("data-summarized")
  const dropped = page.locator(`article[data-slot="${entries[3]!.slotId}"]`)
  await expect(dropped).toHaveAttribute("data-out-of-context", "true")
  await expect(dropped).not.toHaveAttribute("data-summarized")
})

// Count actual wire requests, including reads started by hidden registered surfaces.
// READ_COUNTS_WORK enables the synthetic scale measurement; normal CI uses a small fixture.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { openPanel } from "./support/panel.ts"
import { syntheticPreset } from "./support/syntheticPreset.ts"
import { writeScaleFolder } from "./support/stScaleFolder.ts"

const work = process.env.READ_COUNTS_WORK
test.use({ trace: work ? "off" : "retain-on-failure" })
const server = serverPerFile({
  ...withAdmin,
  DB_READERS: "2",
  ...(process.env.READ_COUNTS_CLIENT_DIST ? { CLIENT_DIST: process.env.READ_COUNTS_CLIENT_DIST } : {}),
  ...(work ? { DATA_DIR: join(work, "data") } : {})
})
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)

test("chat navigation shares reads and still refreshes after writes", async ({ page }, info) => {
  test.setTimeout(work ? 3_600_000 : 120_000)
  page.setDefaultTimeout(30000)
  if (work && !existsSync(join(work, "imported"))) {
    mkdirSync(work, { recursive: true })
    const folder = join(work, "synthetic-scale")
    if (!existsSync(join(folder, "data/default-user/settings.json")))
      writeScaleFolder(folder, { cards: 422, chats: 2102, longChats: 3, groups: 20 })
    // Match the layout audit's 188k-message fixture size.
    const user = join(folder, "data/default-user")
    const files = ["chats", "group chats"].flatMap((dir) =>
      readdirSync(join(user, dir), { recursive: true, encoding: "utf8" })
        .filter((name) => name.endsWith(".jsonl"))
        .map((name) => join(user, dir, name))
    )
    const chats = files.map((path) => ({ path, lines: readFileSync(path, "utf8").trimEnd().split("\n") }))
    const total = chats.reduce((sum, c) => sum + c.lines.length - 1, 0)
    for (const c of chats) {
      const count = Math.max(1, Math.floor(((c.lines.length - 1) * 188000) / total))
      writeFileSync(c.path, c.lines.slice(0, count + 1).join("\n") + "\n")
    }
    const scanned = await admin((api) => api.ScanStFolder({ path: folder }))
    const job = await admin((api) => api.StartStPathImport({ path: scanned.root, prefix: "data/default-user/" }))
    await expect
      .poll(async () => (await admin((api) => api.GetStImport({ importId: job.importId }))).job.status, {
        timeout: 3_000_000,
        intervals: [2000, 5000]
      })
      .not.toBe("running")
    expect((await admin((api) => api.GetStImport({ importId: job.importId }))).job.status).toBe("complete")
    await admin((api) => api.SeenStImport({ importId: job.importId }))
    writeFileSync(join(work, "imported"), "complete\n")
  }
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const importFile = async (name: string, body: unknown) => {
    const response = await page.request.post(`${server().url}/library/import?name=${name}.json`, {
      headers: { "content-type": "application/octet-stream", origin: server().url },
      data: Buffer.from(JSON.stringify(body))
    })
    expect(response.ok()).toBe(true)
  }
  await importFile("Read-count-preset", syntheticPreset())
  await importFile("Read-count-book", {
    name: "Read-count-book",
    entries: Object.fromEntries(
      Array.from({ length: 200 }, (_, uid) => [
        uid,
        {
          uid,
          key: [`lantern-${uid}`],
          comment: `Entry ${uid}`,
          content: `Synthetic lore ${uid}.`.repeat(20)
        }
      ])
    )
  })
  const fixture = await admin((api) =>
    Effect.gen(function* () {
      // A repeated measurement reuses its scale library, not the previous run's global snippet.
      for (const snippet of yield* api.ListSnippets({ chatId: null }))
        yield* api.DeleteNote({ noteRefId: snippet.ref.id })
      const a = yield* api.CreateCard({ label: "Read-count Aria", name: "Read-count Aria" })
      const b = yield* api.CreateCard({ label: "Read-count Wren", name: "Read-count Wren" })
      const persona = yield* api.CreateCard({ label: "Read-count Juniper", name: "Read-count Juniper" })
      const preset = (yield* api.ListLibrary({ kind: "preset" })).find((r) => r.label === "Read-count-preset")!
      const book = (yield* api.ListLibrary({ kind: "lorebook" })).find((r) => r.label === "Read-count-book")!
      yield* api.ChangeGenerationDefaults({ change: { preset: preset.id } })
      const chats = []
      for (const title of ["Read-count first", "Read-count second"]) {
        const started = yield* api.StartChat({
          cards: [a.entityId, b.entityId],
          persona: persona.entityId,
          greeting: null,
          first: { _tag: "Send", content: "A synthetic opening.", speakerEntityId: null }
        })
        yield* api.RenameChat({ chatId: started.chat.id, name: title })
        yield* api.ChangeCast({
          chatId: started.chat.id,
          slotId: null,
          change: { _tag: "Lorebook", ref: book.id, active: true }
        })
        chats.push(started.chat.id)
      }
      return { chats, a }
    })
  )
  const requests: Array<{ tag: string; payload: Record<string, unknown>; at: number }> = []
  const pending = new Set<string>()
  let last = 0
  page.on("websocket", (socket) => {
    socket.on("close", () => pending.clear())
    socket.on("framereceived", ({ payload }) => {
      for (const line of payload.toString().split("\n").filter(Boolean)) {
        const message = JSON.parse(line) as { _tag: string; requestId: string }
        if (message._tag === "Exit") {
          pending.delete(message.requestId)
          last = Date.now()
        }
      }
    })
    socket.on("framesent", ({ payload }) => {
      for (const line of payload.toString().split("\n").filter(Boolean)) {
        const message = JSON.parse(line) as { _tag: string; tag: string; id: string; payload: Record<string, unknown> }
        if (message._tag === "Request") {
          if (!message.tag.startsWith("Subscribe")) pending.add(message.id)
          requests.push({ tag: message.tag, payload: message.payload, at: Date.now() })
          last = Date.now()
        }
      }
    })
  })
  const settle = () =>
    expect
      .poll(() => (pending.size === 0 ? Date.now() - last : 0), { timeout: 30000, intervals: [100] })
      .toBeGreaterThan(700)
  const samples: Array<{
    operation: string
    ms: number
    from: number
    to: number
    counts: Record<string, number>
    requests: typeof requests
  }> = []
  const measure = async (operation: string, action: () => Promise<void>) => {
    const from = Date.now()
    const start = requests.length
    await action()
    const ms = Date.now() - from
    await settle()
    const sent = requests.slice(start)
    const counts: Record<string, number> = {}
    for (const r of sent) counts[r.tag] = (counts[r.tag] ?? 0) + 1
    const sample = { operation, ms, from, to: Date.now(), counts, requests: sent }
    samples.push(sample)
    console.log(JSON.stringify({ operation, ms, counts }))
    return sample
  }
  const ready = async () => {
    await expect(page.getByLabel("Message", { exact: true })).toBeEditable()
  }
  const navigate = async (id: string) => {
    await page.locator(`button[data-chat-id="${id}"]`).first().click()
    await expect(page).toHaveURL(new RegExp(`/chats/${id}`))
    await ready()
  }
  for (let i = 0; i < (work ? 5 : 1); i++) {
    await page.goto(`${server().url}/?side=chats`)
    await expect(page.locator(`button[data-chat-id="${fixture.chats[0]}"]`).first()).toBeVisible()
    await settle()
    const opened = await measure("open chat", () => navigate(fixture.chats[0]!))
    if (!process.env.READ_COUNTS_RECORD) {
      expect(opened.counts.ListChatCards ?? 0).toBeLessThanOrEqual(2)
      expect(opened.counts.OpenComposer ?? 0).toBeLessThanOrEqual(1)
      expect(opened.counts.ListSnippets ?? 0).toBeLessThanOrEqual(1)
      expect(opened.counts.GetGlobalRegex ?? 0).toBeLessThanOrEqual(2)
      expect(opened.counts.ListLibrary ?? 0).toBeLessThanOrEqual(10)
    }
    const switchedChat = await measure("switch chat", () => navigate(fixture.chats[1]!))
    if (!process.env.READ_COUNTS_RECORD) {
      expect(switchedChat.counts.OpenComposer ?? 0).toBeLessThanOrEqual(1)
      expect(switchedChat.counts.ListSnippets ?? 0).toBeLessThanOrEqual(1)
      expect(switchedChat.counts.GetGlobalRegex ?? 0).toBeLessThanOrEqual(2)
      expect(switchedChat.counts.ListLibrary ?? 0).toBeLessThanOrEqual(6)
    }
    let cardReads = 0
    for (const tab of ["Model", "Prompt preset", "Lorebooks", "Cast", "Read-count Aria", "Snippets"]) {
      const switched = await measure(`tab ${tab}`, async () => {
        const panel = await openPanel(page, tab)
        await expect(panel.getByText(/^(Loading|Still loading)/)).toHaveCount(0)
      })
      cardReads += switched.counts.ListChatCards ?? 0
      if (!process.env.READ_COUNTS_RECORD && tab === "Read-count Aria")
        expect(switched.counts.GetCardPromptUse ?? 0).toBeLessThanOrEqual(1)
    }
    if (!process.env.READ_COUNTS_RECORD) expect(cardReads).toBeLessThanOrEqual(1)
    await openPanel(page, "Prompt preset")
    await settle()
    await measure("large preset", async () => {
      await page.getByRole("button", { name: "Open the preset in the large editor", exact: true }).click()
      await expect(
        page.getByRole("dialog", { name: "Preset editor", exact: true }).getByRole("heading", { level: 1 })
      ).toBeVisible()
    })
    await page
      .getByRole("dialog", { name: "Preset editor", exact: true })
      .getByRole("button", { name: "Close", exact: true })
      .click()
    const lore = await openPanel(page, "Lorebooks")
    await lore.getByRole("button", { name: /^Read-count-book/ }).click()
    const region = lore.getByRole("region", { name: "Lorebook Read-count-book", exact: true })
    await expect(region.getByRole("button", { name: "Large editor", exact: true })).toBeVisible()
    await settle()
    await measure("large lorebook", async () => {
      await region.getByRole("button", { name: "Large editor", exact: true }).click()
      await expect(
        page.getByRole("dialog", { name: "Lorebook editor", exact: true }).getByRole("heading", { level: 1 })
      ).toBeVisible()
    })
    await page
      .getByRole("dialog", { name: "Lorebook editor", exact: true })
      .getByRole("button", { name: "Back to the chat", exact: true })
      .click()
  }
  // Both lists are already mounted: a write must invalidate the shared library query.
  await openPanel(page, "Prompt preset")
  await page.getByRole("button", { name: "Open the preset in the large editor", exact: true }).click()
  const editor = page.getByRole("dialog", { name: "Preset editor", exact: true })
  await editor.getByRole("button", { name: "Rename Read-count-preset", exact: true }).click()
  await editor.getByRole("textbox", { name: "New name for Read-count-preset", exact: true }).fill("Read-count renamed")
  await page.keyboard.press("Enter")
  await editor.getByRole("button", { name: "Close", exact: true }).click()
  await expect(page.getByRole("button", { name: /^Prompt preset: / })).toContainText("Read-count renamed")
  const snippets = await openPanel(page, "Snippets")
  await snippets.getByRole("button", { name: "New snippet", exact: true }).click()
  const fresh = snippets.getByRole("region", { name: "Snippet Untitled snippet", exact: true })
  await expect(fresh).toBeVisible()
  await fresh.getByRole("switch", { name: "All chats", exact: true }).click()
  await navigate(fixture.chats[0]!)
  await expect(
    (await openPanel(page, "Snippets")).getByRole("region", { name: "Snippet Untitled snippet", exact: true })
  ).toBeVisible()
  await info.attach("read-counts", { body: JSON.stringify(samples, null, 2), contentType: "application/json" })
  if (work)
    writeFileSync(
      join(work, `${process.env.READ_COUNTS_RECORD ? "before" : "after"}.json`),
      JSON.stringify(samples, null, 2)
    )
})

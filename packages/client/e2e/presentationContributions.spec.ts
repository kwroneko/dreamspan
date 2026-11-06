import { expect, test, type Page } from "@playwright/test"
import { Effect } from "effect"
import { resolve } from "node:path"
import { createServer, type ViteDevServer } from "vite"
import { openSummarySettings } from "./support/panel.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { level1 } from "./support/summaries.ts"
import { fixtureSql } from "../../server/test/support/lcmFixtures.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import type { install, close } from "./support/presentationContributions.ts"
test.use({ actionTimeout: 15_000 })

const server = serverPerFile(withAdmin)
let vite: ViteDevServer
let url: string
test.beforeAll(async () => {
  vite = await createServer({
    root: resolve(import.meta.dirname, ".."),
    server: {
      host: "127.0.0.1",
      port: 0,
      proxy: {
        "/rpc": { target: server().url.replace(/^http/, "ws"), ws: true },
        "/auth": { target: server().url }
      }
    }
  })
  await vite.listen()
  url = vite.resolvedUrls!.local[0]!.replace(/\/$/, "")
})
test.afterAll(async () => {
  await vite?.close()
})

const plugin = (page: Page, mode: Parameters<typeof install>[0] | "close") =>
  page.evaluate(async (mode) => {
    const path = "/e2e/support/presentationContributions.ts"
    const fixture = (await import(/* @vite-ignore */ path)) as { install: typeof install; close: typeof close }
    if (mode === "close") await fixture.close()
    else await fixture.install(mode)
  }, mode)

test("remaining presentation seams update mounted hosts and restore scoped defaults", async ({ page }) => {
  test.setTimeout(180_000)
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const fixture = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const card = yield* api.CreateCard({ label: "Seam Mira", name: "Mira" })
      const chat = yield* api.CreateChat({ title: "Synthetic presentation seams" })
      yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: card.entityId } })
      let parent = null as import("@rp/shared/chat.ts").SlotId | null
      for (let n = 1; n <= 6; n++) {
        const sent = yield* api.SendMessage({
          chatId: chat.id,
          parentSlotId: parent,
          branch: false,
          content: `Original ${n}`
        })
        if (sent._tag !== "Posted") throw new Error("unexpected queue")
        parent = sent.entry.slotId
      }
      const path = yield* api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 100 })
      const last = path.entries.at(-1)!
      const entry = yield* api.WriteVersion({
        slotId: last.slotId,
        content: "A refused synthetic reply",
        expectedRowVersion: last.rowVersion
      })
      yield* api.SetDisplayPrefs({ prefs: { timeline: "summaries", coverageRail: true } })
      return { chat, card, entries: path.entries, entry }
    })
  )
  await level1(server().dataDir, fixture.chat.id, fixture.entries.slice(0, 3), "Synthetic retained summary")
  const modelVersion = uuidv7() as import("@rp/shared/chat.ts").VersionId
  await Effect.runPromise(
    fixtureSql(server().dataDir, [
      {
        sql: "INSERT INTO version_records(id,slot_id,ordinal,status,writer,content,macro_mode,origin,created_at,updated_at,mark,fork_id) SELECT ?,slot_id,ordinal+1,'complete','model',content,'verbatim','generated',created_at,updated_at,'refused',fork_id FROM version_records WHERE id=?",
        params: [modelVersion, fixture.entry.version.id]
      }
    ])
  )
  await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.SelectVersion({
      slotId: fixture.entry.slotId,
      versionId: modelVersion,
      expectedVersionId: fixture.entry.version.id
    })
  )
  await page.goto(`${url}/chats/${fixture.chat.id}`)
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeEditable({ timeout: 30_000 })
  await expect(page.getByText("Synthetic retained summary", { exact: true })).toBeVisible()
  const article = page.locator(`article[data-slot="${fixture.entry.slotId}"]`)
  await expect(article.getByRole("group", { name: "Versions", exact: true })).toBeVisible()
  await plugin(page, "surfaces")
  for (const name of ["summary", "boundary", "rail", "overlay"])
    await expect(page.getByText(`Plugin ${name}`, { exact: true })).toBeVisible()
  await expect(page.getByText("Plugin branches", { exact: true })).toBeVisible()
  await expect(page.getByText("Plugin preview", { exact: true }).first()).toBeVisible()
  await article.getByRole("button", { name: "Plugin version", exact: true }).click()
  await expect(page.locator("body")).toHaveAttribute("data-plugin-steps", "1")
  await article.dispatchEvent("pointerdown", { pointerType: "touch", clientX: 200, clientY: 300 })
  await article.dispatchEvent("pointerup", { pointerType: "touch", clientX: 100, clientY: 300 })
  await expect(page.locator("body")).toHaveAttribute("data-plugin-steps", "2")
  await page.getByRole("button", { name: "Show Mira's card", exact: true }).click()
  await expect(page.getByText("Plugin card action", { exact: true })).toBeVisible()
  await expect(page.getByText("Plugin card peer", { exact: true })).toBeVisible()
  await page.getByRole("tab", { name: "This chat", exact: true }).click()
  await expect(page.getByText("Plugin settings section", { exact: true })).toBeVisible()
  await plugin(page, "close")
  await expect(page.getByRole("switch", { name: "Summarize older messages" })).toBeVisible()
  await expect(page.getByText("Plugin branches", { exact: true })).toHaveCount(0)
  await expect(page.getByText("Plugin preview", { exact: true })).toHaveCount(0)
  await plugin(page, "fields")
  // The summary fields are the Summaries tab's settings.
  await openSummarySettings(page)
  await expect(page.getByText("Plugin summary fields", { exact: true })).toBeVisible()
  await plugin(page, "close")
  await expect(page.getByText("Plugin summary fields", { exact: true })).toHaveCount(0)
  await page.getByRole("button", { name: "Hide panel", exact: true }).click()
  await plugin(page, "hide")
  await expect(page.getByText("Original 1", { exact: true })).toBeVisible()
  await expect(page.getByRole("group", { name: "Versions", exact: true })).toHaveCount(0)
  await expect(page.getByTestId("lcm-boundary")).toHaveCount(0)
  await article.dispatchEvent("pointerdown", { pointerType: "touch", clientX: 200, clientY: 300 })
  await article.dispatchEvent("pointerup", { pointerType: "touch", clientX: 100, clientY: 300 })
  await expect(page.locator("body")).toHaveAttribute("data-plugin-steps", "2")
  await plugin(page, "close")
  await expect(page.getByText("Synthetic retained summary", { exact: true })).toBeVisible()
  await expect(article.getByRole("group", { name: "Versions", exact: true })).toBeVisible()
  await plugin(page, "rows")
  await expect(page.getByText("Plugin row", { exact: true })).toBeVisible()
  await plugin(page, "close")
  await expect(page.getByText("Plugin row", { exact: true })).toHaveCount(0)
  await plugin(page, "providers")
  // As many as are registered (six since display, images and snippets added theirs).
  const providers = Number(await page.locator("body").getAttribute("data-plugin-provider-count"))
  expect(providers).toBeGreaterThanOrEqual(3)
  await expect(page.locator("[data-plugin-provider]")).toHaveCount(providers)
  await plugin(page, "close")
  await expect(page.locator("[data-plugin-provider]")).toHaveCount(0)
  await plugin(page, "composer")
  await expect(page.getByText("Plugin composer", { exact: true })).toBeVisible()
  await plugin(page, "close")
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeEditable()
  await page.goto(`${url}/settings/chats`)
  await plugin(page, "account")
  await expect(page.getByText("Plugin account section", { exact: true })).toBeVisible()
  await plugin(page, "close")
  await expect(page.getByRole("switch", { name: "New chats summarize older messages" })).toBeVisible()
})

test("root comparison names the family and descendant comparison names the parent", async ({ page }) => {
  const { root, child } = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const root = yield* api.CreateCard({ label: "Synthetic comparison root", name: "Synthetic comparison root" })
      const child = yield* api.ForkCard({
        refId: root.id,
        name: "Synthetic comparison child",
        nickname: "Child",
        characterVersion: "v2"
      })
      return { root, child }
    })
  )
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  for (const [card, title] of [
    [root, "Compare with family"],
    [child, "Compare with parent"]
  ] as const) {
    await page.goto(`${url}/cards/${card.entityId}`)
    await page.getByRole("button", { name: title, exact: true }).click()
    await expect(page.getByRole("dialog", { name: title, exact: true })).toBeVisible()
  }
})

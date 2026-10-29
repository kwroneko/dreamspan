import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { uuidv7 } from "@rp/shared/id.ts"
import type { VersionId } from "@rp/shared/chat.ts"
import type { RefId } from "@rp/shared/library.ts"
import { fixtureSql } from "../../server/test/support/lcmFixtures.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { startProvider, type FakeProvider } from "./support/provider.ts"
import { showActions } from "./support/message.ts"

const server = serverPerFile(withAdmin)
let provider: FakeProvider

test.beforeAll(async () => {
  provider = await startProvider()
})
test.afterAll(async () => {
  await provider.stop()
})

for (const width of [1440, 390])
  for (const colorScheme of ["light", "dark"] as const) {
    test(`display rules preserve source: ${width}, ${colorScheme}`, async ({ browser }) => {
      test.setTimeout(120_000)
      const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme })
      const page = await context.newPage()
      const violations: string[] = []
      page.on("console", (message) => {
        if (message.text().includes("Content Security Policy")) violations.push(message.text())
      })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const imported = await page.request.post(`${server().url}/library/import?name=Display.json`, {
        headers: { origin: server().url, "content-type": "application/octet-stream" },
        data: JSON.stringify({
          openai_max_context: 8192,
          extensions: {
            regex_scripts: [
              {
                id: "display",
                scriptName: "Display greeting",
                findRegex: "/Hi (.*)/g",
                replaceString: "Welcome **$1**",
                placement: [2],
                markdownOnly: true
              },
              {
                id: "prompt",
                scriptName: "Prompt only",
                findRegex: "/Hi/g",
                replaceString: "BAD PROMPT",
                placement: [2],
                promptOnly: true,
                disabled: true
              },
              {
                id: "storage",
                scriptName: "Storage rewrite",
                findRegex: "/Hi/g",
                replaceString: "BAD STORAGE",
                placement: [2]
              },
              {
                id: "hostile",
                scriptName: "Slow rule",
                findRegex: "/^(a+)+$/",
                replaceString: "x",
                placement: [2],
                markdownOnly: true
              }
            ]
          }
        })
      })
      expect(imported.status()).toBe(200)
      const refId = ((await imported.json()) as { library: { ref: { id: RefId } } }).library.ref.id
      const fixture = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        Effect.gen(function* () {
          yield* api.SetDisplayPrefs({ prefs: { outputMacros: false, displayRegex: false } })
          const connection = yield* api.CreateConnection({
            kind: "openai-chat",
            settings: {
              name: "Synthetic display provider",
              baseUrl: provider.baseUrl,
              compat: {},
              cacheTtlS: null,
              maxConcurrent: null,
              presetOverrideRefId: null
            },
            apiKey: null
          })
          const model = yield* api.AddUserModel({ connectionId: connection.id, key: "fake-small", overrides: {} })
          const card = yield* api.CreateCard({ label: "Display fixture Mira", name: "Mira" })
          const chat = yield* api.CreateChat({ title: "Display rules — synthetic fixture" })
          yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: card.entityId } })
          yield* api.SetLcmEnabled({ chatId: chat.id, enabled: false })
          yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Preset", ref: refId } })
          yield* api.ChangeCast({
            chatId: chat.id,
            slotId: null,
            change: { _tag: "Model", connection: connection.id, model: model.id }
          })
          const human = yield* api.SendMessage({
            chatId: chat.id,
            parentSlotId: null,
            branch: false,
            content: "Human {{user}}"
          })
          if (human._tag !== "Posted") throw new Error("queued")
          const modelText = yield* api.SendMessage({
            chatId: chat.id,
            parentSlotId: human.entry.slotId,
            branch: false,
            content: "Hi {{user}}",
            speakerEntityId: card.entityId
          })
          if (modelText._tag !== "Posted") throw new Error("queued")
          return { chat, human: human.entry, model: modelText.entry }
        })
      )
      // Synthetic completed model text, without involving a real model or owner's data.
      const modelVersion = uuidv7() as VersionId
      await Effect.runPromise(
        fixtureSql(server().dataDir, [
          {
            sql: "INSERT INTO versions(id,slot_id,ordinal,status,writer,content,macro_mode,origin,created_at,updated_at,fork_id,speaker_entity_id) SELECT ?,slot_id,ordinal+1,'complete','model',content,'verbatim','generated',created_at,updated_at,fork_id,speaker_entity_id FROM versions WHERE id=?",
            params: [modelVersion, fixture.model.version.id]
          }
        ])
      )
      await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        api.SelectVersion({
          slotId: fixture.model.slotId,
          versionId: modelVersion,
          expectedVersionId: fixture.model.version.id
        })
      )
      await page.goto(`${server().url}/chats/${fixture.chat.id}?panel=display`)
      const reply = page.locator(`article[data-slot="${fixture.model.slotId}"]`)
      await expect(reply.locator(".markdown")).toHaveText("Hi {{user}}")
      await page.getByRole("switch", { name: /^Expand macros in model output/ }).click()
      await expect(reply.locator(".markdown")).toHaveText("Hi User")
      await expect(page.locator(`article[data-slot="${fixture.human.slotId}"] .markdown`)).toHaveText("Human {{user}}")
      await page.getByRole("switch", { name: /^Use preset display regex/ }).click()
      // Import cannot approve itself, and the extra viewer switch does not grant approval.
      await expect(reply.locator(".markdown")).toHaveText("Hi User")
      await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        Effect.gen(function* () {
          const opened = yield* api.OpenEditor({ refId })
          yield* api.SetRegexApproval({ refId, approved: true, expectedRowVersion: opened.ref.rowVersion })
        })
      )
      await page.reload()
      await expect(reply.locator('.markdown [data-streamdown="strong"]')).toHaveText("User")
      await expect(reply.locator(".markdown")).toHaveText("Welcome User")
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      if (process.env.SCREENSHOT_DIR)
        await page.screenshot({ path: join(process.env.SCREENSHOT_DIR, `display-${width}-${colorScheme}.png`) })
      // The original is what the editor reads, and what the next real request sends.
      await page.getByRole("button", { name: width < 640 ? "Close" : "Close the panel", exact: true }).click()
      if (process.env.SCREENSHOT_DIR)
        await page.screenshot({ path: join(process.env.SCREENSHOT_DIR, `display-chat-${width}-${colorScheme}.png`) })
      if (width === 1440 && colorScheme === "light") {
        // Approval changes in another editor tab must reach an already open chat.
        const editor = await context.newPage()
        await editor.goto(`${server().url}/library/${refId}`)
        await editor.getByRole("button", { name: "Stop them", exact: true }).click()
        await expect(editor.getByRole("button", { name: "Allow them", exact: true })).toBeVisible()
        await expect(reply.locator(".markdown")).toHaveText("Hi User")
        await editor.getByRole("button", { name: "Allow them", exact: true }).click()
        await editor.getByRole("alertdialog").getByRole("button", { name: "Allow them", exact: true }).click()
        await expect(reply.locator(".markdown")).toHaveText("Welcome User")
        await editor.close()
        // A write from a separate RPC session sends no browser library signal.
        // The server's context notification must refresh approval as well.
        for (const approved of [false, true]) {
          await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
            Effect.gen(function* () {
              const opened = yield* api.OpenEditor({ refId })
              yield* api.SetRegexApproval({ refId, approved, expectedRowVersion: opened.ref.rowVersion })
            })
          )
          await expect(reply.locator(".markdown")).toHaveText(approved ? "Welcome User" : "Hi User")
        }
      }
      await showActions(reply)
      await reply.getByRole("button", { name: "Edit", exact: true }).click()
      await expect(reply.getByLabel("Message text")).toHaveValue("Hi {{user}}")
      await reply.getByRole("button", { name: "Cancel", exact: true }).click()
      const before = provider.completions.length
      await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        api.Generate({ chatId: fixture.chat.id, parentSlotId: fixture.model.slotId, branch: false })
      )
      await expect.poll(() => provider.completions.length).toBeGreaterThan(before)
      expect(provider.completions.at(-1)!.messages.some((m) => m.content.includes("Hi {{user}}"))).toBe(true)
      expect(provider.completions.at(-1)!.messages.some((m) => m.content.includes("Welcome User"))).toBe(false)
      const stored = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        api.ReadPath({ chatId: fixture.chat.id, leafSlotId: fixture.model.slotId, range: { _tag: "Bottom" }, limit: 2 })
      )
      expect(stored.entries.at(-1)!.version.content).toBe("Hi {{user}}")
      if (width === 1440 && colorScheme === "light") {
        const hostileId = uuidv7() as VersionId
        const hostileText = "a".repeat(100) + "!"
        await Effect.runPromise(
          fixtureSql(server().dataDir, [
            {
              sql: "INSERT INTO versions(id,slot_id,ordinal,status,writer,content,macro_mode,origin,created_at,updated_at,fork_id,speaker_entity_id) SELECT ?,slot_id,ordinal+1,'complete','model',?,'verbatim','generated',created_at,updated_at,fork_id,speaker_entity_id FROM versions WHERE id=?",
              params: [hostileId, hostileText, modelVersion]
            }
          ])
        )
        const current = stored.entries.at(-1)!
        await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
          api.SelectVersion({
            slotId: current.slotId,
            versionId: hostileId,
            expectedVersionId: current.version.id
          })
        )
        await page.reload()
        await expect(reply.getByRole("note")).toContainText("time limit", { timeout: 15_000 })
        await expect(reply.locator(".markdown")).toHaveText(hostileText)
        await page.getByLabel("Message", { exact: true }).fill("The browser remains responsive.")
      }
      expect(violations).toEqual([])
      await context.close()
    })
  }

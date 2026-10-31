// Synthetic imports only: explain an empty history; ST's selected preset becomes the current
// prompt preset without changing the budget, which the model's own context size restores.
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { card, encode, header, jsonl, message } from "../../server/test/support/stFolder.ts"
import { asUser, loginCookie } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)

for (const chars of [14_000, 20_000]) {
  test(`explains a refused request with a ${chars / 4}-token card and restores it with the model's context size`, async ({
    page
  }) => {
    test.setTimeout(120_000)
    const { importId, model } = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
      Effect.gen(function* () {
        const connection = yield* api.CreateConnection({
          kind: "openai-chat",
          settings: {
            name: `Small ${chars}`,
            baseUrl: "http://127.0.0.1:5999/v1",
            compat: {},
            cacheTtlS: null,
            maxConcurrent: null,
            presetOverrideRefId: null
          }
        })
        // ST's own defaults, set on the model: 4,095 tokens, 300 for the reply.
        const model = yield* api.AddUserModel({
          connectionId: connection.id,
          key: "small-model",
          overrides: { settings: { samplers: { openai_max_context: 4095, openai_max_tokens: 300 } } }
        })
        yield* api.SetGenerationDefaults({
          defaults: { model: { connection: connection.id, model: model.id }, preset: null }
        })
        return { importId: yield* api.StartStImport({ unsupported: [] }).pipe(Effect.map((r) => r.importId)), model }
      })
    )
    const cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
    const upload = async (path: string, body: Uint8Array) => {
      const response = await fetch(
        `${server().url}/st-import/file?${new URLSearchParams({ import: importId, path })}`,
        {
          method: "POST",
          headers: { origin: server().url, cookie, "content-type": "application/octet-stream" },
          body: new Uint8Array(body)
        }
      )
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ outcome: expect.stringMatching(/added|updated|unchanged/) })
    }
    await upload("settings.json", encode({ oai_settings: { preset_settings_openai: "Roomy" } }))
    await upload("characters/Mira.png", card("Mira", "Hello.", {}, { description: "x".repeat(chars) }))
    await upload(
      `chats/Mira/Imported-${chars}.jsonl`,
      jsonl([
        header({}),
        ...Array.from({ length: 50 }, (_, i) =>
          message({
            name: i % 2 ? "Sam" : "Mira",
            user: i % 2 === 1,
            minute: i,
            mes: `Turn ${i}: ${"a".repeat(100)}`
          })
        )
      ])
    )
    const { chat, next, entries } = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
      Effect.gen(function* () {
        const chat = (yield* api.ListChats({ limit: 10, before: null })).find((c) => c.title === `Imported-${chars}`)!
        return {
          chat,
          next: yield* api.GetNextContext({ chatId: chat.id, leafSlotId: null }),
          entries: (yield* api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 100 }))
            .entries
        }
      })
    )
    // daaa81f refuses dropping the newest message rather than sending empty history.
    expect(next.historyStart).toBeNull()
    expect(next.assemblyError).toMatch(chars === 14_000 ? /newest message/ : /fixed context.*maximum context size/)
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/chats/${chat.id}`)
    const explanation = page.getByRole("status").filter({ hasText: "aren’t sent to the model: the model’s context" })
    // A budget refusal is a calm notice naming each number's source; the history note doesn't repeat it.
    const refusal = page.getByRole("status").filter({ hasText: "The next reply doesn't fit the context size" })
    if (chars === 20_000) {
      await expect(refusal).toContainText(
        `take ~${next.budget!.nonHistoryTokens.toLocaleString()} tokens and the reply reserves 300 (the model's response length): more than the context size of 4,095 tokens (the model's context size setting)`
      )
    } else {
      await expect(refusal).toContainText(next.assemblyError!)
      await expect(refusal).toContainText("The context size is 4,095 tokens (the model's context size setting)")
      await expect(refusal).not.toContainText("more than the")
    }
    await expect(explanation).toHaveCount(0)
    const last = page.locator(`article[data-slot="${entries.at(-1)!.slotId}"]`)
    await expect(last).toBeVisible()
    await expect(last).not.toHaveAttribute("data-out-of-context")
    for (const width of [1440, 390])
      for (const theme of ["light", "dark"] as const) {
        await page.setViewportSize({ width, height: 960 })
        await page.emulateMedia({ colorScheme: theme })
        await page.evaluate((value) => localStorage.setItem("rp.theme", value), theme)
        await page.reload()
        await expect(refusal).toBeVisible()
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
        if (process.env.SCREENSHOT_DIR) {
          mkdirSync(process.env.SCREENSHOT_DIR, { recursive: true })
          await page.screenshot({
            path: join(process.env.SCREENSHOT_DIR, `assembly-refusal-${chars}-${width}-${theme}.png`)
          })
        }
      }
    await page.setViewportSize({ width: 1440, height: 960 })
    // The composer names the prompt preset in effect: ST's selected one isn't imported yet.
    const preset = page.getByRole("combobox", { name: "Prompt preset", exact: true })
    await expect(preset).toHaveText("Default (built-in)")
    // The later preset upload becomes the current prompt preset; its budget stays in the file.
    await upload("OpenAI Settings/Roomy.json", encode({ openai_max_context: 32000, openai_max_tokens: 300 }))
    await page.reload()
    await expect(preset).toHaveText("Roomy")
    await expect(last).toBeVisible()
    await expect(refusal).toContainText("4,095 tokens")
    await expect(explanation).toHaveCount(0)
    // The model's own context size brings the whole history back.
    await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
      api.EditModel({
        modelId: model.id,
        expectedRowVersion: model.rowVersion,
        overrides: { settings: { samplers: { openai_max_context: 32000, openai_max_tokens: 300 } } }
      })
    )
    await page.reload()
    await expect(last).toBeVisible()
    await expect(last).not.toHaveAttribute("data-out-of-context")
    await expect(explanation).toHaveCount(0)
    await expect(refusal).toHaveCount(0)
    await expect(page.locator('[data-out-of-context="true"]')).toHaveCount(0)
    const restored = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
      api.GetNextContext({ chatId: chat.id, leafSlotId: null })
    )
    expect(restored.assemblyError).toBeNull()
    expect(restored.historyStart?.depth).toBe(0)
  })
}

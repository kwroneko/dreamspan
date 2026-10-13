// Synthetic imports only: explain an empty history, then restore it with ST's selected preset.
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { card, encode, header, jsonl, message } from "../../server/test/support/stFolder.ts"
import { asUser, loginCookie } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)

for (const chars of [14_000, 20_000]) {
  test(`explains an empty history with a ${chars / 4}-token card and restores it with the imported preset`, async ({
    page
  }) => {
    const { importId } = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
      Effect.gen(function* () {
        yield* api.SetGenerationDefaults({ defaults: { model: null, preset: null } })
        return yield* api.StartStImport({ unsupported: [] })
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
    expect(next.historyStart?.depth ?? null).toBe(chars === 14_000 ? 50 : null)
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/chats/${chat.id}`)
    const explanation = page.getByRole("status").filter({ hasText: "Not sent: the preset" })
    await expect(explanation).toBeVisible()
    await expect(explanation).toContainText("“Default” (ST’s built-in default) allows 4,095 tokens")
    await expect(explanation).toContainText("targets 3,276, reserves 300 for the reply")
    await expect(explanation).toContainText(`take ~${next.budget!.nonHistoryTokens.toLocaleString()}`)
    const last = page.locator(`article[data-slot="${entries.at(-1)!.slotId}"]`)
    await expect(last).toBeVisible()
    expect((await explanation.boundingBox())!.y).toBeGreaterThan((await last.boundingBox())!.y)
    if (chars === 14_000) await expect(last).toHaveAttribute("data-out-of-context", "true")
    // The later preset upload adopts the named default and brings the whole history back.
    await upload("OpenAI Settings/Roomy.json", encode({ openai_max_context: 32000, openai_max_tokens: 300 }))
    await page.reload()
    await expect(last).toBeVisible()
    await expect(last).not.toHaveAttribute("data-out-of-context")
    await expect(explanation).toHaveCount(0)
    await expect(page.locator('[data-out-of-context="true"]')).toHaveCount(0)
  })
}

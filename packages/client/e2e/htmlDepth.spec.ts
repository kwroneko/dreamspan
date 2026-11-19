// "HTML in older messages sent to the model" (spec/HTML-MESSAGES.md §3.6, step 4) in the chat's
// settings: as written by default, then text only after N messages, then leaving out panels,
// each kept in the chat's state from the message shown, at 1440 and 390, light and dark, with
// the layout audit. What the model then sees is the assembler's (server/test/assembler.test.ts).
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import type { EntityId } from "@dreamspan/shared/chat.ts"
import { stCardV2 } from "../../server/test/formats/support.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { openPanel } from "./support/panel.ts"
import { asUser, loginCookie, withCookie } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`HTML in older messages at ${width} (${theme})`, async ({ page }, info) => {
      test.setTimeout(120_000)
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const imported = await page.request.post(`${server().url}/library/import?name=synthetic.json`, {
        data: Buffer.from(JSON.stringify(stCardV2())),
        headers: { origin: server().url, "content-type": "application/octet-stream" }
      })
      expect(imported.status()).toBe(200)
      const entityId = (await imported.json()).library.ref.entityId as EntityId
      const { chat, slotId } = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        Effect.map(
          api.StartChat({
            cards: [entityId],
            persona: null,
            greeting: null,
            first: { _tag: "Send", content: "The board reads <b>Day 3</b>.", speakerEntityId: null }
          }),
          (r) => ({ chat: r.chat, slotId: r.entry.slotId })
        )
      )
      const cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
      const read = () =>
        withCookie(server(), cookie, (api) => api.GetCast({ chatId: chat.id, slotId, forkId: chat.currentForkId }))
      await page.goto(`${server().url}/chats/${chat.id}`)
      const settings = await openPanel(page, "This chat")
      const section = settings.getByRole("region", { name: "HTML in older messages" })
      const send = section.getByRole("combobox", { name: /^Send/ })
      const older = section.getByRole("combobox", { name: /^Older than/ })
      await expect(section.getByText("HTML in older messages sent to the model")).toBeVisible()
      await expect(send).toHaveText("As written")
      await expect(older).toHaveCount(0)
      expect((await read()).htmlDepth).toBeUndefined()
      await expectLayout(page, info, `html-depth-default-${width}-${theme}`, {
        scope: '[role="tabpanel"][aria-label="This chat"]'
      })

      await send.click()
      await page.getByRole("option", { name: "Text only", exact: true }).click()
      await expect(send).toHaveText("Text only")
      await expect(older).toHaveText("4 messages")
      await expect.poll(async () => (await read()).htmlDepth).toEqual({ mode: "text", n: 4 })
      await older.click()
      await page.getByRole("option", { name: "2 messages", exact: true }).click()
      await expect.poll(async () => (await read()).htmlDepth).toEqual({ mode: "text", n: 2 })
      await expectLayout(page, info, `html-depth-text-${width}-${theme}`, {
        scope: '[role="tabpanel"][aria-label="This chat"]'
      })

      await send.click()
      await page.getByRole("option", { name: "Leave out panels", exact: true }).click()
      await expect.poll(async () => (await read()).htmlDepth).toEqual({ mode: "panels", n: 2 })
      await page.reload()
      const again = (await openPanel(page, "This chat")).getByRole("region", { name: "HTML in older messages" })
      await expect(again.getByRole("combobox", { name: /^Send/ })).toHaveText("Leave out panels")
      await expect(again.getByRole("combobox", { name: /^Older than/ })).toHaveText("2 messages")
      await again.getByRole("combobox", { name: /^Send/ }).click()
      await page.getByRole("option", { name: "As written", exact: true }).click()
      await expect.poll(async () => (await read()).htmlDepth?.mode).toBe("as_written")
      await expect(again.getByRole("combobox", { name: /^Older than/ })).toHaveCount(0)
    })

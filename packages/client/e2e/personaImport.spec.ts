// Synthetic ST personas: the last speaker is selected, an earlier one is the user's too and
// never one of the characters (no Speak now, no Next), and changing the persona leaves
// historical message authors intact.
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { card, encode, header, jsonl, message } from "../../server/test/support/stFolder.ts"
import { png } from "../../server/test/formats/support.ts"
import { asUser, loginCookie } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { openPanel, closePanel } from "./support/panel.ts"
import { expectLayout } from "./support/layoutAudit.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)

for (const width of [1440, 390]) {
  for (const scheme of ["light", "dark"] as const) {
    test(`one imported persona at ${width} ${scheme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ colorScheme: scheme })
      const tag = `Personas ${width} ${scheme}`
      const cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
      const run = await admin((api) => api.StartStImport({ unsupported: [] }))
      const files = new Map([
        [
          "settings.json",
          encode({ power_user: { personas: { "a.png": "Ada", "b.png": "Bo" }, default_persona: "a.png" } })
        ],
        ["User Avatars/a.png", png()],
        ["User Avatars/b.png", png()],
        ["characters/Bot.png", card("Bot", "Hello.")],
        [
          `chats/Bot/${tag}.jsonl`,
          jsonl([
            header({ persona: "a.png" }),
            message({ name: "Ada", user: true, mes: "Ada opens the door.", minute: 1, persona: "a.png" }),
            message({ name: "Bo", user: true, mes: "Bo enters the harbor.", minute: 2 }),
            message({ name: "Bot", mes: "Welcome to the harbor.", minute: 3 })
          ])
        ]
      ])
      for (const [path, body] of files) {
        const response = await fetch(
          `${server().url}/st-import/file?${new URLSearchParams({ import: run.importId, path })}`,
          {
            method: "POST",
            headers: { cookie, "content-type": "application/octet-stream" },
            body: new Uint8Array(body)
          }
        )
        expect(response.status).toBe(200)
        expect((await response.json()).outcome).not.toBe("failed")
      }
      await admin((api) => api.FinishStImport({ importId: run.importId, notSent: [] }))
      const { chat, cast } = await admin((api) =>
        Effect.gen(function* () {
          const chat = (yield* api.ListChats({ limit: 100, before: null })).find((c) => c.title === tag)!
          return { chat, cast: yield* api.GetCast({ chatId: chat.id, slotId: null }) }
        })
      )
      expect(cast.playedByMe).toEqual([cast.cards.find((c) => c.name === "Bo")!.entityId])
      expect(cast.macroNames.user).toBe("Bo")
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/chats/${chat.id}`)
      const ada = page.getByRole("article").filter({ hasText: "Ada opens the door." })
      const bo = page.getByRole("article").filter({ hasText: "Bo enters the harbor." })
      await expect(ada.locator("header")).toContainText("Ada")
      await expect(bo.locator("header")).toContainText("Bo")
      await openPanel(page, "Cast")
      const persona = page.getByRole("group", { name: "Your persona" })
      await expect(persona.getByRole("button", { name: "Playing as Bo. Change your persona" })).toBeVisible()
      const castList = page.getByRole("list", { name: "Characters in this chat" })
      // The persona is apart from the characters, in its own row; the earlier persona is
      // neither a character nor offered to speak.
      await expect(castList.getByRole("listitem")).toHaveCount(1)
      await expect(castList.getByRole("listitem", { name: "Bo", exact: true })).toHaveCount(0)
      await expect(castList.getByRole("listitem", { name: "Ada", exact: true })).toHaveCount(0)
      await expect(page.getByRole("button", { name: "Speak now: Ada" })).toHaveCount(0)
      await expect(persona).toContainText("Bo")
      await expect(page.getByRole("heading", { level: 2, name: "1 character", exact: true })).toBeVisible()
      if (process.env.LAYOUT_AUDIT) await expectLayout(page, test.info(), "persona-import-cast")
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
      if (process.env.SCREENSHOT_DIR)
        await page.screenshot({ path: join(process.env.SCREENSHOT_DIR, `personas-${width}-${scheme}.png`) })
      await persona.getByRole("button", { name: /^Playing as / }).click()
      await page.getByRole("option", { name: "Ada", exact: true }).click()
      await expect(persona.getByRole("button", { name: "Playing as Ada. Change your persona" })).toBeVisible()
      expect(
        (await admin((api) => api.GetCast({ chatId: chat.id, slotId: chat.activeLeafSlotId }))).macroNames.user
      ).toBe("Ada")
      // The phone's panel covers the messages; close it before checking the history.
      await closePanel(page)
      // Bo, played until the switch, left with it: Next offers only the character.
      const next = page.getByRole("button", { name: /^Next: / }).first()
      if (await next.isVisible()) {
        await expect(next).toHaveAccessibleName(/^Next: Bot\b/)
        await expect(next).not.toHaveAccessibleName(/\b(Ada|Bo)\b/)
      }
      await expect(ada.locator("header")).toContainText("Ada")
      await expect(bo.locator("header")).toContainText("Bo")
      // The same imported persona is used in the library, its own page, and its editor.
      await page.goto(`${server().url}/library?show=personas&q=Ada`)
      const row = page.getByRole("listitem").filter({ has: page.getByRole("link", { name: "Ada", exact: true }) })
      await expect(row).toContainText(/\d+ chats? ·/)
      await expect(row).not.toContainText("Never used")
      await row.getByRole("link", { name: "Ada", exact: true }).click()
      await expect(page.getByRole("heading", { level: 1, name: "Ada", exact: true })).toBeVisible()
      await expect(page.getByRole("list", { name: "Chats", exact: true })).toContainText(tag)
      if (process.env.LAYOUT_AUDIT) await expectLayout(page, test.info(), "persona-chats")
      if (process.env.SCREENSHOT_DIR)
        await page.screenshot({ path: join(process.env.SCREENSHOT_DIR, `persona-usage-${width}-${scheme}.png`) })
      await page.getByRole("link", { name: "Edit card", exact: true }).click()
      await expect(page.getByRole("link", { name: /^Used by \d+ chats?\./ })).toBeVisible()
      await page.getByRole("link", { name: /^Used by \d+ chats?\./ }).click()
      await expect(page.getByRole("list", { name: "Chats", exact: true })).toContainText(tag)
    })
  }
}

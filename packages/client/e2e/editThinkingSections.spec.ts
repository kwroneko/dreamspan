// A reply's tagged thinking in its edit (review-thinkedit1; SillyTavern's reasoning block, which
// its auto-parse fills from the reply's text): the auto-parsed section is the message's thinking
// field, explained as thinking in the reply, changed in its tags and removed like any other. At
// desktop and phone widths, light and dark, with a layout audit of the open editor. Synthetic
// chat only.
import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, test } from "@playwright/test"
import { sectionsDisplay } from "@dreamspan/shared/replySections.ts"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
import { showActions } from "./support/message.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { expectTextBox, replaceEditorText } from "./support/textbox.ts"

const server = serverPerFile({
  ...withAdmin,
  FAKE_GENERATOR_TPS: "200",
  FAKE_GENERATOR_TOKENS: "20",
  FAKE_GENERATOR_SECTION: "12"
})
const shots = process.env.SCREENSHOT_DIR

const lastEntry = (chatId: string) =>
  asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api
      .ReadPath({ chatId: chatId as never, leafSlotId: null, range: { _tag: "Bottom" }, limit: 10 })
      .pipe(Effect.map((path) => path.entries.at(-1)!))
  )

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`a reply's tagged thinking is its thinking in its edit, at ${width} ${theme}`, async ({ page }, info) => {
      test.setTimeout(120_000)
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const shot = async (name: string) => {
        if (shots) {
          mkdirSync(shots, { recursive: true })
          await page.waitForTimeout(150)
          await page.screenshot({ path: resolve(shots, `${name}-${width}-${theme}.png`), animations: "disabled" })
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      }
      const chat = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        Effect.gen(function* () {
          const chat = yield* api.CreateChat({ title: `Tagged thinking ${width} ${theme}` })
          const sent = yield* api.SendMessage({
            chatId: chat.id,
            parentSlotId: null,
            branch: false,
            content: "The road flooded."
          })
          if (sent._tag !== "Posted") return yield* Effect.die("unexpected queue")
          return chat
        })
      )
      await page.goto(`${server().url}/chats/${chat.id}`)
      await page
        .getByRole("button", { name: /^(Reply$|Generate(?! another))/ })
        .last()
        .click()
      await expect.poll(async () => (await lastEntry(chat.id)).version.status, { timeout: 30_000 }).toBe("complete")
      const generated = (await lastEntry(chat.id)).version
      expect(generated.reasoning).toBeUndefined()
      const tagged = sectionsDisplay(generated.replySections)
      expect(tagged).toMatch(/\S/)
      const reply = page.getByRole("article").last()
      const thinking = reply.getByRole("textbox", { name: "Thinking", exact: true })
      const edit = async () => {
        await showActions(reply)
        await reply.getByRole("button", { name: "Edit", exact: true }).click()
        await expect(reply.getByRole("textbox", { name: "Message text", exact: true })).toBeVisible()
      }
      const save = async () => {
        await reply.getByRole("button", { name: "Save", exact: true }).click()
        await expect(reply.getByRole("textbox", { name: "Message text", exact: true })).toHaveCount(0)
      }

      // The tagged thinking opens as the edit's thinking, not as Add thinking.
      await edit()
      await expectTextBox(thinking, tagged)
      await expect(reply.getByRole("button", { name: "Add thinking", exact: true })).toHaveCount(0)
      await reply.getByRole("button", { name: "About Thinking", exact: true }).hover()
      await expect(page.getByText(/The thinking in the reply, shown folded above it/).last()).toBeVisible()
      await shot("edit-tagged-thinking")
      await expectLayout(page, info, `edit-tagged-thinking-${width}-${theme}`, { scope: "article:last-of-type" })

      // Changed: still thinking in the reply, in its tags, on a new version.
      await replaceEditorText(thinking, "Wade across at the ford.")
      await save()
      await expect
        .poll(async () => sectionsDisplay((await lastEntry(chat.id)).version.replySections))
        .toBe("Wade across at the ford.")
      const saved = (await lastEntry(chat.id)).version
      expect(saved.replySections!.sections[0]!.open).toBe(generated.replySections!.sections[0]!.open)
      expect(saved.reasoning).toBeUndefined()
      await reply.locator('[data-reasoning-panel="sections"] button[aria-expanded]').first().click()
      await expect(reply.getByRole("region", { name: "Thinking in the reply" })).toHaveText(/Wade across at the ford\./)

      // Removed like any other thinking.
      await edit()
      await reply.getByRole("button", { name: "Remove thinking", exact: true }).click()
      await expect(thinking).toHaveCount(0)
      await save()
      await expect.poll(async () => (await lastEntry(chat.id)).version.replySections).toBeUndefined()
      await expect(reply.locator('[data-reasoning-panel="sections"]')).toHaveCount(0)
    })

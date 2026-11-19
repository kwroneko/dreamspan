// A reply's thinking in its edit (thinkedit1; SillyTavern's reasoning block edit, Add and
// remove): the thinking field above the text, its hover explanation, a changed thinking saved
// as a new version, removed and added again on the user's own version, the field's text kept
// across a reload before Save, and the ST export carrying it as extra.reasoning. At desktop and
// phone widths, light and dark, with a layout audit of the open editor. Synthetic chat only.
import { mkdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { expect, test } from "@playwright/test"
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
  FAKE_GENERATOR_REASONING: "12"
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
    test(`a reply's thinking is edited, removed and added in its edit, and exported, at ${width} ${theme}`, async ({
      page
    }, info) => {
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
      const title = `Edit thinking ${width} ${theme}`
      const chat = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        Effect.gen(function* () {
          const chat = yield* api.CreateChat({ title })
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
      expect(generated.reasoning).toMatch(/\S/)
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

      // The reply's thinking opens in its edit, above the text, explained on hover.
      await edit()
      await expect(thinking).toBeVisible()
      await expectTextBox(thinking, generated.reasoning!)
      const about = reply.getByRole("button", { name: "About Thinking", exact: true })
      await about.hover()
      await expect(page.getByText(/saved as plain text, without the provider's signature/).last()).toBeVisible()
      await shot("edit-thinking")
      await expectLayout(page, info, `edit-thinking-${width}-${theme}`, { scope: "article:last-of-type" })

      // Changed: a new version with the thinking typed, the reply as it came kept among its versions.
      await replaceEditorText(thinking, "My own plan for the road.")
      await save()
      await expect.poll(async () => (await lastEntry(chat.id)).version.reasoning).toBe("My own plan for the road.")
      expect((await lastEntry(chat.id)).versionCount).toBe(2)
      const panel = reply.locator('[data-reasoning-panel="reasoning"]')
      await panel.locator("button[aria-expanded]").click()
      await expect(reply.getByRole("region", { name: "Reasoning" })).toHaveText(/My own plan for the road\./)

      // Removed: the field goes, Add thinking stands in for it; saved, the reply has none.
      await edit()
      await reply.getByRole("button", { name: "Remove thinking", exact: true }).click()
      await expect(thinking).toHaveCount(0)
      const add = reply.getByRole("button", { name: "Add thinking", exact: true })
      await expect(add).toBeVisible()
      await shot("edit-thinking-removed")
      await expectLayout(page, info, `edit-thinking-removed-${width}-${theme}`, { scope: "article:last-of-type" })
      await save()
      await expect.poll(async () => (await lastEntry(chat.id)).version.reasoning).toBeUndefined()
      await expect(panel).toHaveCount(0)
      // The user's own version changed in place: no new version.
      expect((await lastEntry(chat.id)).versionCount).toBe(2)

      // Added again; what's typed outlives a reload before Save.
      await edit()
      await add.click()
      await expect(thinking).toBeFocused()
      await page.keyboard.insertText("Added after the flood.")
      await expect
        .poll(async () =>
          (await asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.MessageDrafts({ chatId: chat.id }))).some(
            (draft) => draft.key.field === "reasoning" && draft.content === "Added after the flood."
          )
        )
        .toBe(true)
      await page.reload()
      await expectTextBox(reply.getByRole("textbox", { name: "Thinking", exact: true }), "Added after the flood.")
      await save()
      await expect.poll(async () => (await lastEntry(chat.id)).version.reasoning).toBe("Added after the flood.")

      // The ST export carries it as the message's extra.reasoning.
      await page.getByRole("button", { name: "Chat actions", exact: true }).click()
      await page.getByRole("menuitem", { name: "Export…", exact: true }).click()
      const dialog = page.getByRole("dialog", { name: "Export this chat", exact: true })
      const download = page.waitForEvent("download")
      await dialog.getByRole("button", { name: "Export", exact: true }).click()
      const lines = readFileSync(await (await download).path(), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { extra?: { reasoning?: string } })
      expect(lines.at(-1)!.extra?.reasoning).toBe("Added after the flood.")
    })

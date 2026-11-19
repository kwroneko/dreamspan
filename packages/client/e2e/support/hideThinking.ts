// Hiding a reply's thinking from the model (SetThinkingHidden), from each thinking panel's
// header: the provider's Reasoning and the Thinking in the reply. The thinking stays on the
// message, its header marked "Hidden from the model", across a reload; Show to the model again
// undoes it. Nothing generates. At desktop and phone widths, light and dark, with a layout audit.
import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { asUser } from "./rpc.ts"
import { expectLayout } from "./layoutAudit.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./server.ts"

export const hideThinkingTests = () => {
  const server = serverPerFile({
    ...withAdmin,
    FAKE_GENERATOR_TPS: "20",
    FAKE_GENERATOR_TOKENS: "40",
    FAKE_GENERATOR_REASONING: "20",
    FAKE_GENERATOR_SECTION: "20"
  })
  const shots = process.env.SCREENSHOT_DIR

  const lastEntry = (chatId: string) =>
    asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
      api
        .ReadPath({ chatId: chatId as never, leafSlotId: null, range: { _tag: "Bottom" }, limit: 10 })
        .pipe(Effect.map((path) => path.entries.at(-1)!))
    )

  for (const width of [1440, 390])
    for (const theme of ["light", "dark"] as const) {
      test(`thinking hidden from the model stays, marked, and is shown again at ${width} ${theme}`, async ({
        page
      }, info) => {
        test.setTimeout(90_000)
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
            const chat = yield* api.CreateChat({ title: `Hide thinking ${width} ${theme}` })
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
        const reply = page.getByRole("article").last()
        const reasoningPanel = reply.locator('[data-reasoning-panel="reasoning"]')
        const sectionsPanel = reply.locator('[data-reasoning-panel="sections"]')
        // A choice made while streaming is saved, and Undo restores this branch's choice.
        const streamingHide = reasoningPanel.getByRole("button", { name: "Hide from the model" })
        await expect(streamingHide).toBeVisible({ timeout: 20_000 })
        expect((await lastEntry(chat.id)).version.status).toBe("generating")
        await streamingHide.click()
        await expect(reasoningPanel.locator("[data-thinking-hidden]")).toBeVisible()
        await page.getByRole("button", { name: "Undo", exact: true }).click()
        await expect(reasoningPanel.locator("[data-thinking-hidden]")).toHaveCount(0)
        // Offered once the reply is done, on each panel.
        await expect(reply.getByRole("button", { name: "Show as reply text" })).toBeVisible({ timeout: 20_000 })
        const hideReasoning = reasoningPanel.getByRole("button", { name: "Hide from the model" })
        await expect(hideReasoning).toBeVisible()
        await expect(hideReasoning).not.toHaveAttribute("aria-disabled")
        await expect(sectionsPanel.getByRole("button", { name: "Hide from the model" })).toBeVisible()
        const articles = await page.getByRole("article").count()

        await hideReasoning.click()
        await expect(reasoningPanel.locator("[data-thinking-hidden]")).toHaveText("Hidden from the model")
        await expect(reasoningPanel.getByRole("button", { name: "Show to the model again" })).toBeVisible()
        await expect(sectionsPanel.locator("[data-thinking-hidden]")).toHaveCount(0)
        expect((await lastEntry(chat.id)).hiddenThinking).toEqual(["reasoning"])

        await sectionsPanel.getByRole("button", { name: "Hide from the model" }).click()
        await expect(sectionsPanel.locator("[data-thinking-hidden]")).toBeVisible()
        // The message and its thinking stay; nothing was generated.
        await expect(page.getByRole("article")).toHaveCount(articles)
        expect((await lastEntry(chat.id)).hiddenThinking).toEqual(["reasoning", "sections"])
        for (const dismiss of await page.locator("[data-toast]").getByRole("button", { name: "Dismiss" }).all())
          await dismiss.click()
        await shot("thinking-hidden")
        await expectLayout(page, info, `thinking-hidden-${width}-${theme}`, { scope: "article:last-of-type" })

        // Kept across a reload; the panel opens with its text still there.
        await page.reload()
        const again = page.getByRole("article").last()
        await expect(again.locator('[data-reasoning-panel="reasoning"] [data-thinking-hidden]')).toBeVisible()
        await again.locator('[data-reasoning-panel="reasoning"] button[aria-expanded]').click()
        await expect(again.getByRole("region", { name: "Reasoning" })).toHaveText(/\S/)
        await shot("thinking-hidden-open")
        await expectLayout(page, info, `thinking-hidden-open-${width}-${theme}`, { scope: "article:last-of-type" })

        await again
          .locator('[data-reasoning-panel="reasoning"]')
          .getByRole("button", { name: "Show to the model again" })
          .click()
        await expect(again.locator('[data-reasoning-panel="reasoning"] [data-thinking-hidden]')).toHaveCount(0)
        expect((await lastEntry(chat.id)).hiddenThinking).toEqual(["sections"])
      })
    }
}

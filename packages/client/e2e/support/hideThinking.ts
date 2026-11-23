// Each thinking panel's "Sent to the model" / "Not sent to the model" (owner, 2026-11-23): the
// next request's own decision, shown live, with its reason on hover; a click flips the user's
// choice for that thinking only, and does nothing where the settings keep it out anyway. The
// preset's two send-back counts change it without a reload. Nothing generates after the one
// fake reply. At desktop and phone widths, light and dark, with a layout audit.
import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, type Locator, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { asUser } from "./rpc.ts"
import { expectLayout } from "./layoutAudit.ts"
import { saveRevision } from "./saveRevision.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./server.ts"

const tooltip = (page: Page) => page.locator('[data-layout-overlay="Tooltip floats above the page"]')

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

  /** The panel's toggle, by either state. */
  const toggle = (panel: Locator) => panel.getByRole("button", { name: /^(Not sent|Sent) to the model$/ })
  const hover = async (page: Page, button: Locator, text: string | RegExp) => {
    // From outside: a tooltip whose trigger was just clicked opens again only after the pointer leaves.
    await page.mouse.move(0, 0)
    await button.hover()
    await expect(tooltip(page)).toContainText(text)
    await page.mouse.move(0, 0)
    await expect(tooltip(page)).toHaveCount(0)
  }

  for (const width of [1440, 390])
    for (const theme of ["light", "dark"] as const) {
      test(`thinking panels show whether each is sent, live, and flip it at ${width} ${theme}`, async ({
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
        const { chat, preset } = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
          Effect.gen(function* () {
            const preset = yield* api.CreatePreset({ label: `Send-back ${width} ${theme}` })
            yield* api.ChangeGenerationDefaults({ change: { preset: preset.id } })
            const chat = yield* api.CreateChat({ title: `Thinking sent ${width} ${theme}` })
            const sent = yield* api.SendMessage({
              chatId: chat.id,
              parentSlotId: null,
              branch: false,
              content: "The road flooded."
            })
            if (sent._tag !== "Posted") return yield* Effect.die("unexpected queue")
            return { chat, preset }
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
        const reasoning = toggle(reasoningPanel)
        const sections = toggle(sectionsPanel)
        // While a plain reply is written, whether it's sent isn't known yet.
        await expect(reasoning).toBeVisible({ timeout: 20_000 })
        expect((await lastEntry(chat.id)).version.status).toBe("generating")
        await expect(reasoning).toHaveText("Not sent to the model")
        await expect(reply.getByRole("button", { name: "Show as reply text" })).toBeVisible({ timeout: 20_000 })

        // A new preset sends nothing back: both not sent, saying why, and a click does nothing.
        for (const [button, why] of [
          [reasoning, "the preset sends no provider reasoning back"],
          [sections, "the preset sends no tagged thinking back"]
        ] as const) {
          await expect(button).toHaveText("Not sent to the model")
          await expect(button).toHaveAttribute("aria-pressed", "false")
          await expect(button).toHaveAttribute("aria-disabled", "true")
          await expect(button).toHaveAccessibleDescription(`Not sent: ${why}.`)
          await hover(page, button, why)
        }
        // A click on it does nothing (aria-disabled keeps it focusable, so its hover is reachable).
        await sections.click({ force: true })
        expect((await lastEntry(chat.id)).hiddenThinking ?? []).toEqual([])
        await expect(sections).toHaveText("Not sent to the model")
        await shot("thinking-not-sent")
        await expectLayout(page, info, `thinking-not-sent-${width}-${theme}`, { scope: "article:last-of-type" })

        // The preset's two counts, side by side in one group; the chat stays open in its tab.
        const editor = await page.context().newPage()
        await editor.setViewportSize({ width, height: width === 390 ? 844 : 900 })
        await editor.goto(`${server().url}/library/${preset.id}`)
        const settings = editor.locator('[data-preset-section="reply-sections"]')
        const group = settings.locator("[data-thinking-send-back]")
        const tagged = group.getByRole("spinbutton", { name: "Send thinking back for the last replies" })
        const provider = group.getByRole("spinbutton", {
          name: "Send the provider's reasoning back for the last replies"
        })
        await group.scrollIntoViewIfNeeded()
        await expect(tagged).toHaveValue("0")
        await expect(provider).toHaveValue("0")
        await expect(provider).toHaveAccessibleDescription(
          /Changes the cached prefix only when replies drop out of the last N\./
        )
        const [a, b] = [(await tagged.boundingBox())!, (await provider.boundingBox())!]
        expect(b.y).toBeGreaterThan(a.y)
        expect(Math.abs(a.x - b.x)).toBeLessThan(2)
        await tagged.fill("1")
        await provider.fill("1")
        await saveRevision(editor)
        await expectLayout(editor, info, `thinking-send-back-${width}-${theme}`, {
          scope: '[data-preset-section="reply-sections"]'
        })
        if (shots)
          await group.screenshot({
            path: resolve(shots, `thinking-send-back-${width}-${theme}.png`),
            animations: "disabled"
          })
        await editor.close()

        // Live, without a reload: the tagged thinking is sent now; the provider's reasoning
        // still isn't (a fake reply has nothing from a provider to send), and says why.
        await expect(sections).toHaveText("Sent to the model", { timeout: 15_000 })
        await expect(sections).toHaveAttribute("aria-pressed", "true")
        await expect(sections).not.toHaveAttribute("aria-disabled")
        await expect(sectionsPanel.locator("[data-thinking-sent]")).toHaveCount(1)
        await hover(page, sections, "within the last reply the preset sends back")
        await expect(reasoning).toHaveText("Not sent to the model")
        await expect(reasoning).toHaveAttribute("aria-disabled", "true")
        await hover(page, reasoning, /Not sent: /)
        await shot("thinking-sent")
        await expectLayout(page, info, `thinking-sent-${width}-${theme}`, { scope: "article:last-of-type" })

        // A click flips it for this thinking only; the message and its thinking stay.
        const articles = await page.getByRole("article").count()
        await sections.click()
        await expect(sections).toHaveText("Not sent to the model")
        await expect(sectionsPanel.locator("[data-thinking-hidden]")).toHaveCount(1)
        await expect(reasoningPanel.locator("[data-thinking-hidden]")).toHaveCount(0)
        expect((await lastEntry(chat.id)).hiddenThinking).toEqual(["sections"])
        await expect(page.getByRole("article")).toHaveCount(articles)
        for (const dismiss of await page.locator("[data-toast]").getByRole("button", { name: "Dismiss" }).all())
          await dismiss.click()
        await hover(page, sections, "you left it out of later requests")
        await shot("thinking-hidden")
        await expectLayout(page, info, `thinking-hidden-${width}-${theme}`, { scope: "article:last-of-type" })

        // Kept across a reload; the panel opens with its text still there.
        await page.reload()
        const again = page.getByRole("article").last()
        const sectionsAgain = toggle(again.locator('[data-reasoning-panel="sections"]'))
        await expect(sectionsAgain).toHaveText("Not sent to the model")
        await expect(again.locator('[data-reasoning-panel="sections"] [data-thinking-hidden]')).toHaveCount(1)
        await again.locator('[data-reasoning-panel="sections"] button[aria-expanded]').click()
        await expect(again.locator('[data-reasoning-panel="sections"]')).toContainText(/\S/)
        await expectLayout(page, info, `thinking-hidden-open-${width}-${theme}`, { scope: "article:last-of-type" })

        // Flipped back: sent again.
        await sectionsAgain.click()
        await expect(sectionsAgain).toHaveText("Sent to the model")
        await expect(again.locator("[data-thinking-hidden]")).toHaveCount(0)
        expect((await lastEntry(chat.id)).hiddenThinking ?? []).toEqual([])
      })
    }
}

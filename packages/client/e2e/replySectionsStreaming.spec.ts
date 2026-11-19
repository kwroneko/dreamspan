// In-output thinking while the reply streams (owner, 2026-11-02; spec/REPLY-SECTIONS.md): once
// the opening tag has fully arrived, everything after it goes to the thinking panel, not the
// reply body, until the closing tag; then the body streams. The panel shows "Thinking…" all
// the while, folded when the user prefers it folded, and streams live once opened. The fake
// generator writes `<thin`+`king>` … `</thin`+`king>`, both tags split across chunks, slowly
// enough to look at each state.
import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile({
  ...withAdmin,
  FAKE_GENERATOR_TPS: "10",
  FAKE_GENERATOR_TOKENS: "40",
  FAKE_GENERATOR_SECTION: "120"
})
const shots = process.env.SCREENSHOT_DIR

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`thinking streams into its folded panel, live once opened, at ${width} ${theme}`, async ({ page }) => {
      test.setTimeout(120_000)
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const shot = async (name: string) => {
        if (shots) {
          mkdirSync(shots, { recursive: true })
          await page.screenshot({ path: resolve(shots, `${name}-${width}-${theme}.png`), animations: "disabled" })
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      }
      const chat = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        Effect.gen(function* () {
          // Folded while streaming: the user's preference.
          yield* api.SetDisplayPrefs({ prefs: { reasoning: "collapsed" } })
          const chat = yield* api.CreateChat({ title: `Thinking ${width} ${theme}` })
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
      const panel = reply.locator('[data-reasoning-panel="sections"]')
      const toggle = panel.locator("button[aria-expanded]").first()
      const region = reply.getByRole("region", { name: "Thinking in the reply" })
      /** The message's text outside its thinking panel. */
      const bodyText = () =>
        reply.evaluate((article) => {
          const copy = article.cloneNode(true) as HTMLElement
          copy.querySelectorAll("[data-reasoning-panel]").forEach((p) => p.remove())
          return copy.innerText
        })

      // Thinking: folded, its header says so, and nothing of it is in the body.
      await expect(toggle).toHaveText(/^Thinking…·\d+ words?$/)
      await expect(panel.locator("[data-thinking]")).toHaveCount(1)
      await expect(toggle).toHaveAttribute("aria-expanded", "false")
      await expect(region).toBeHidden()
      await expect(toggle).toHaveAccessibleDescription(/Shows this thinking, live as it's written/)
      expect(await bodyText()).not.toMatch(/<\/?think/i)
      await shot("thinking-streaming-folded")

      // Opened: the thinking so far, growing as it's written, still never in the body.
      await toggle.click()
      await expect(region).toBeVisible()
      await expect(region).toHaveAttribute("aria-busy", "true")
      await expect(region).toHaveText(/\S/)
      const before = (await region.innerText()).length
      await expect.poll(async () => (await region.innerText()).length, { timeout: 15_000 }).toBeGreaterThan(before)
      await expect(toggle).toHaveText(/^Thinking…/)
      await expect(region).not.toContainText("<think")
      expect(await bodyText()).not.toMatch(/<\/?think/i)
      const sample = (await region.innerText()).trim().slice(0, 24)
      expect(await bodyText()).not.toContain(sample)
      await shot("thinking-streaming-open")

      // Closed tag: the header says the thinking is done, and the body streams.
      await expect(toggle).toHaveText(/^Thinking in the reply·/, { timeout: 30_000 })
      await expect(panel.locator("[data-thinking]")).toHaveCount(0)
      await expect.poll(bodyText, { timeout: 15_000 }).toMatch(/\S{3}/)
      expect(await bodyText()).not.toMatch(/<\/?think/i)

      // Done: it folds, and what was saved is the parse of the whole reply.
      await expect(toggle).toHaveAttribute("aria-expanded", "false", { timeout: 30_000 })
      await expect(reply.getByRole("button", { name: "Show as reply text" })).toBeVisible()
      await shot("thinking-done")
      const saved = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 10 })
      )
      const version = saved.entries.at(-1)!.version
      expect(version.status).toBe("complete")
      expect(version.content).not.toMatch(/<\/?think/i)
      expect(version.content.trim().length).toBeGreaterThan(0)
      expect(version.replySections!.sections).toHaveLength(1)
      expect(version.replySections!.sections[0]).toMatchObject({ open: "<thinking>", close: "</thinking>" })
      // Opened again, the panel shows the saved thinking.
      await toggle.click()
      await expect(region).toBeVisible()
      await expect(region).not.toHaveAttribute("aria-busy", "true")
      expect((await region.innerText()).trim().length).toBeGreaterThan(20)
    })
  }

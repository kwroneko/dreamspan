// Tagged reply sections (spec/REPLY-SECTIONS.md) in the browser: the fake generator streams
// reasoning, then a reply that opens a `<thinking>` section (its tag split across chunks) and
// closes it `</think>`. The reply shows two folded panels, the provider's Reasoning first, a
// body without the section, and Show as reply text puts the section back as a new version.
import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile({
  ...withAdmin,
  FAKE_GENERATOR_TPS: "20",
  FAKE_GENERATOR_TOKENS: "80",
  FAKE_GENERATOR_REASONING: "20",
  FAKE_GENERATOR_SECTION: "30"
})
const shots = process.env.SCREENSHOT_DIR

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`reply sections show in their own panel at ${width} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const shot = async (name: string) => {
        if (shots) {
          mkdirSync(shots, { recursive: true })
          await page.waitForTimeout(200)
          await page.screenshot({ path: resolve(shots, `${name}-${width}-${theme}.png`), animations: "disabled" })
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      }
      const chat = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        Effect.gen(function* () {
          yield* api.SetDisplayPrefs({ prefs: { reasoning: "expanded" } })
          const chat = yield* api.CreateChat({ title: `Sections ${width} ${theme}` })
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
      const reasoning = reply.getByRole("button", { name: /^Reasoning/ })
      const notes = reply.getByRole("button", { name: /^Thinking in the reply/ })
      const region = reply.getByRole("region", { name: "Thinking in the reply" })
      // Streaming, both open as the preference says, the thinking growing in its panel while
      // the reply is still being written; then both fold when the reply is done.
      await expect(notes).toHaveText(/^Thinking in the reply…/)
      await expect(region).toBeVisible()
      await expect(region).toHaveText(/\S/)
      await expect(region).not.toContainText("<think")
      await shot("reply-sections-streaming")
      await expect(notes).toHaveText(/^Thinking in the reply…/)
      await expect(notes).toHaveText(/^Thinking in the reply·/, { timeout: 20_000 })
      await expect(reasoning).toHaveAttribute("aria-expanded", "false")
      await expect(notes).toHaveAttribute("aria-expanded", "false")
      // The provider's panel comes first.
      const order = await reply
        .locator("[data-reasoning-panel]")
        .evaluateAll((panels) => panels.map((p) => p.getAttribute("data-reasoning-panel")))
      expect(order).toEqual(["reasoning", "sections"])
      // Collapse all once per reply, on the first panel.
      await expect(reply.getByRole("button", { name: "Collapse all" })).toHaveCount(1)
      // The body has no trace of the section.
      const body = (await reply.innerText()).split(/Show as reply text\n/).at(-1)!
      expect(body).not.toMatch(/think/i)
      await shot("reply-sections-folded")

      await notes.click()
      await expect(region).toBeVisible()
      await expect(region).not.toContainText("<think")
      expect((await region.innerText()).trim().length).toBeGreaterThan(20)
      await reasoning.click()
      await expect(reply.getByRole("region", { name: "Reasoning" })).toBeVisible()
      await shot("reply-sections-open")
      await reply.getByRole("button", { name: "Collapse all" }).first().click()
      await expect(region).toBeHidden()
      await expect(reply.getByRole("region", { name: "Reasoning" })).toBeHidden()

      // A wrong parse undone: the section back in the text, a new version, the reasoning kept.
      await reply.getByRole("button", { name: "Show as reply text" }).click()
      await expect(reply).toContainText("<thinking>")
      await expect(reply).toContainText("</think>")
      await expect(notes).toBeHidden()
      await expect(reasoning).toBeVisible()
      await shot("reply-sections-as-text")

      // The preset's setting, beside End of request, on by default with the default pair.
      const label = `Sections preset ${width} ${theme}`
      await asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.CreatePreset({ label }))
      // From the library a preset opens at its own address (the Presets tab, Edit as a link).
      await page.goto(`${server().url}/library`)
      await page.getByRole("tab", { name: /^Presets/ }).click()
      await page.getByRole("link", { name: `Edit ${label}`, exact: true }).click()
      const editor = page.getByRole("main")
      const heading = editor.getByRole("heading", { name: "Thinking at the start of a reply" })
      await heading.scrollIntoViewIfNeeded()
      const section = editor.locator('[data-preset-section="reply-sections"]')
      await expect(section.getByRole("switch", { name: "Move tagged thinking into its own panel" })).toBeChecked()
      await expect(section.getByRole("textbox", { name: "Opening tag" })).toHaveValue("<think(?:ing)?>")
      await expect(section.getByRole("textbox", { name: "Closing tag" })).toHaveValue("</think(?:ing)?>")
      await shot("reply-sections-editor")
      await expect(section.getByRole("button", { name: "Add the default pair" })).toHaveCount(0)
      const sendBack = section.getByRole("spinbutton", { name: "Send thinking back for the last replies" })
      await sendBack.fill("")
      await sendBack.fill("2")
      await expect(sendBack).toHaveValue("2")
      expect((await sendBack.boundingBox())!.width).toBeLessThan(150)
      await sendBack.scrollIntoViewIfNeeded()
      await shot("reply-sections-editor-send-back")
    })
  }

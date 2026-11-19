// Tagged reply sections (spec/REPLY-SECTIONS.md) in the browser: the fake generator streams
// reasoning, then a reply that opens a `<thinking>` section and closes it `</thinking>` (both
// tags split across chunks). The reply shows two folded panels, the provider's Reasoning first, a
// body without the section, and Show as reply text puts the section back as a new version.
import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, test, type Locator } from "@playwright/test"
import { originalReply, sectionsDisplay } from "@dreamspan/shared/replySections.ts"
import { Effect } from "effect"
import { asUser } from "./support/rpc.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { saveRevision } from "./support/saveRevision.ts"
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
      test.setTimeout(120_000)
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
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
      const notes = reply.locator('[data-reasoning-panel="sections"] button[aria-expanded]').first()
      const region = reply.getByRole("region", { name: "Thinking in the reply" })
      // Streaming, both open as the preference says, the thinking growing in its panel while
      // the reply is still being written; then both fold when the reply is done.
      await expect(notes).toHaveText(/^Thinking(…| in the reply)·/)
      await expect(region).toBeVisible()
      await expect(region).toHaveText(/\S/)
      await expect(region).not.toContainText("<think")
      await shot("reply-sections-streaming")
      await expect(reply.getByRole("button", { name: "Show as reply text" })).toBeVisible({ timeout: 20_000 })
      await expect(notes).toHaveText(/^Thinking in the reply·/)
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
      const parsed = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        api
          .ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 10 })
          .pipe(Effect.map((path) => path.entries.at(-1)!.version))
      )
      await reply.getByRole("button", { name: "Show as reply text" }).click()
      await expect(notes).toBeHidden()
      await expect(reasoning).toBeVisible()
      // HTML rendering strips unknown tags, keeping their content (ARCHITECTURE §12,
      // HTML in messages, inline). Check rendered thinking and the complete stored source.
      await expect(reply.locator(".markdown")).toContainText(sectionsDisplay(parsed.replySections))
      const restored = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        api
          .ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 10 })
          .pipe(Effect.map((path) => path.entries.at(-1)!.version))
      )
      expect(restored).toMatchObject({
        content: originalReply(parsed.content, parsed.replySections),
        origin: "edited",
        sourceVersionId: parsed.id,
        reasoning: parsed.reasoning
      })
      expect(restored.id).not.toBe(parsed.id)
      expect(restored.replySections).toBeUndefined()
      await shot("reply-sections-as-text")

      // The preset's setting, beside End of request, on by default with the default pairs,
      // literal tags unless a pair is treated as a regex.
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
      const opening = section.getByRole("textbox", { name: "Opening tag" })
      const closing = section.getByRole("textbox", { name: "Closing tag" })
      await expect(opening).toHaveCount(2)
      await expectThinkingFields(section)
      await expect(opening.first()).toHaveValue("<think>")
      await expect(closing.first()).toHaveValue("</think>")
      await expect(opening.nth(1)).toHaveValue("<thinking>")
      await expect(closing.nth(1)).toHaveValue("</thinking>")
      const asRegex = section.getByRole("checkbox", { name: "Treat as a regex" })
      await expect(asRegex).toHaveCount(2)
      await expect(asRegex.first()).not.toBeChecked()
      await expect(opening.first()).toHaveAccessibleDescription("Where a section starts, exactly as written.")
      await expect(section).not.toContainText("Each tag is a regular expression")
      await shot("reply-sections-editor")
      // Opting a pair into regex: its tags are patterns, checked as such.
      await asRegex.first().click()
      await expect(asRegex.first()).toBeChecked()
      await expect(opening.first()).toHaveAccessibleDescription("Where a section starts: a regular expression.")
      await opening.first().fill("<think(")
      await expect(section).toContainText(/Invalid regular expression|Unterminated group/)
      await asRegex.first().click()
      await expect(section).not.toContainText(/Invalid regular expression|Unterminated group/)
      const sendBack = section.getByRole("spinbutton", { name: "Send thinking back for the last replies" })
      await sendBack.fill("")
      await sendBack.fill("2")
      await expect(sendBack).toHaveValue("2")
      expect((await sendBack.boundingBox())!.width).toBeLessThan(150)
      await sendBack.scrollIntoViewIfNeeded()
      await shot("reply-sections-editor-send-back")

      // Literal tag symbols survive editing, saving and reloading.
      await opening.first().fill("<|plan|>")
      await closing.first().fill("<|/plan|>")
      await expect(opening.first()).toHaveValue("<|plan|>")
      await expect(closing.first()).toHaveValue("<|/plan|>")
      await saveRevision(page)
      await page.reload()
      await expect(opening.first()).toHaveValue("<|plan|>")
      await expect(closing.first()).toHaveValue("<|/plan|>")
      await opening.first().scrollIntoViewIfNeeded()
      await shot("reply-sections-editor-literal")
    })
  }

// A focused geometry audit of the settings, independent of reply generation.
for (const width of [390, 1024, 1440])
  for (const theme of ["light", "dark"] as const) {
    test(`thinking settings layout at ${width} ${theme}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 1000 })
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const preset = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        api.CreatePreset({ label: `Thinking layout ${width} ${theme}` })
      )
      await page.goto(`${server().url}/library/${preset.id}`)
      const section = page.locator('[data-preset-section="reply-sections"]')
      await expect(section).toBeVisible()
      await section.scrollIntoViewIfNeeded()
      await expectThinkingFields(section)
      if (shots) {
        mkdirSync(shots, { recursive: true })
        await section.locator("..").screenshot({
          path: resolve(shots, `thinking-settings-${width}-${theme}.png`),
          animations: "disabled"
        })
      }
      await expectLayout(page, info, "thinking-settings", { scope: '[data-preset-section="reply-sections"]' })
      const pairs = section.locator("[data-section-pair]")
      await expect(section.getByRole("button", { name: "Add a pair", exact: true })).toHaveCount(0)
      await section.getByRole("button", { name: "Add another tag pair", exact: true }).click()
      await expect(pairs).toHaveCount(3)
      const added = pairs.last()
      await expect(added).toHaveAttribute("data-flashing", "")
      await expect(added).toBeInViewport({ ratio: 1 })
      await expectLayout(page, info, "thinking-settings-added", { scope: '[data-preset-section="reply-sections"]' })
      // Empty is valid: even the last pair retains its corner remove control.
      for (let count = 3; count > 0; count--) {
        await pairs.last().getByRole("button", { name: "Remove this pair", exact: true }).click()
        await expect(pairs).toHaveCount(count - 1)
      }
      await expectLayout(page, info, "thinking-settings-empty", {
        scope: '[data-preset-section="reply-sections"]'
      })
    })
  }

async function expectThinkingFields(section: Locator) {
  const heading = section.getByRole("heading", { name: "Thinking at the start of a reply", exact: true })
  const geometry = await heading.evaluate((node) => {
    const section = node.closest('[data-preset-section="reply-sections"]')!
    const head = node.getBoundingClientRect()
    const add = section.querySelector('button[aria-label="Add another tag pair"]')!.getBoundingClientRect()
    return { headingRight: head.right, headingBottom: head.bottom, addX: add.x, addY: add.y }
  })
  expect(geometry.addX).toBeGreaterThanOrEqual(geometry.headingRight)
  expect(geometry.addY).toBeLessThan(geometry.headingBottom)
  for (const pair of await section.locator("[data-section-pair]").all()) {
    // Measure the box and X in one frame; the editor can restore its scroll position
    // between separate Playwright geometry reads while the page settles.
    const corner = await pair.evaluate((box) => {
      const outer = box.getBoundingClientRect()
      const remove = box.querySelector('button[aria-label="Remove this pair"]')!.getBoundingClientRect()
      return { right: outer.right - remove.right, top: remove.top - outer.top }
    })
    expect(corner.right).toBeLessThanOrEqual(16)
    expect(corner.top).toBeLessThanOrEqual(16)
    await expect(pair.getByRole("checkbox")).toHaveCount(2)
  }
  const tags = section.getByRole("textbox")
  for (const tag of await tags.all()) {
    await expect(tag).toHaveJSProperty("tagName", "INPUT")
    const box = (await tag.boundingBox())!
    expect(box.height).toBeLessThanOrEqual(40)
    expect(box.width).toBeLessThanOrEqual(640)
  }
  // DOM order also governs keyboard and screen-reader order.
  const order = await section
    .locator("input:not([type=hidden]):not([type=checkbox]), [role=switch], button")
    .evaluateAll((controls) =>
      controls
        .map((control) =>
          control.getAttribute("role") === "switch"
            ? "switch"
            : control.getAttribute("type") === "number"
              ? "send-back"
              : control.tagName === "INPUT"
                ? "tag"
                : control.textContent?.trim()
        )
        .filter((name) => name === "tag" || name === "switch" || name === "send-back" || name?.startsWith("Add "))
    )
  const toggle = order.indexOf("switch")
  expect(toggle).toBeGreaterThan(order.lastIndexOf("tag"))
  expect(order[toggle + 1]).toBe("send-back")
  const tagsGeometry = await section
    .locator("[data-section-pair]")
    .first()
    .evaluate((pair) => {
      const fields = pair.querySelectorAll("input:not([type=hidden]):not([type=checkbox])")
      return {
        firstY: fields[0]!.getBoundingClientRect().y,
        secondY: fields[1]!.getBoundingClientRect().y,
        gridWidth: pair.querySelector("[data-reply-section-tags]")!.getBoundingClientRect().width
      }
    })
  if (tagsGeometry.gridWidth >= 456) expect(tagsGeometry.firstY).toBe(tagsGeometry.secondY)
  else expect(tagsGeometry.secondY).toBeGreaterThan(tagsGeometry.firstY)
}

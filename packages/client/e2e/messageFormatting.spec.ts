import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const sample = `The harbor at dusk. *A quiet thought.* _Another thought._ __A promise kept.__
"Hello, *traveler*." “The tide is turning.” «Come closer.»
「Listen to the waves.」 『Stay awhile.』 ＂Welcome home.＂
A single line ends here.
The next line stays separate.

*An unfinished thought
"An unfinished sentence

\`"code" *literal* __literal__\`

\`\`\`text
"code stays plain" *literal* __literal__
\`\`\`

<span title="synthetic">HTML stays text</span>`

for (const width of [1440, 390])
  for (const colorScheme of ["light", "dark"] as const) {
    test(`message formatting: ${width} ${colorScheme}`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme })
      const page = await context.newPage()
      const violations: string[] = []
      page.on("console", (message) => {
        if (message.text().includes("Content Security Policy")) violations.push(message.text())
      })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const fixture = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        Effect.gen(function* () {
          const chat = yield* api.CreateChat({ title: "Harbor at dusk — synthetic formatting" })
          yield* api.SetLcmEnabled({ chatId: chat.id, enabled: false })
          const sent = yield* api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: sample })
          if (sent._tag !== "Posted") throw new Error("expected message")
          return { chat, sent }
        })
      )
      await page.goto(`${server().url}/chats/${fixture.chat.id}`)
      const message = page.locator(`article[data-slot="${fixture.sent.entry.slotId}"] .markdown`)
      await expect(message).toContainText("The harbor at dusk.")
      if (process.env.FORMATTING_STAGE !== "before") {
        await expect(message.locator("u")).toHaveText("A promise kept.")
        await expect(message.locator("q").first()).toHaveText('"Hello, traveler."')
        // Six quote styles and the auto-closed sentence; the literal HTML attribute
        // stays in the main colour, as ST's default encode_tags=false requires.
        await expect(message.locator("q")).toHaveCount(7)
        await expect(message.locator("br")).not.toHaveCount(0)
        await expect(message.locator("span[title=synthetic]")).toHaveCount(0)
        const contrast = await message.evaluate((element) => {
          const canvas = document.createElement("canvas")
          const context = canvas.getContext("2d")!
          const luminance = (color: string) => {
            context.fillStyle = color
            context.fillRect(0, 0, 1, 1)
            const [r, g, b] = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map((value) => {
              const channel = value / 255
              return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
            })
            return r! * 0.2126 + g! * 0.7152 + b! * 0.0722
          }
          const background = luminance(getComputedStyle(element.closest("article")!).backgroundColor)
          return Object.fromEntries(
            ["p", "em", "u", "q"].map((selector) => {
              const foreground = luminance(getComputedStyle(element.querySelector(selector)!).color)
              return [selector, (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)]
            })
          )
        })
        for (const ratio of Object.values(contrast)) expect(ratio).toBeGreaterThanOrEqual(4.5)
        if (process.env.FORMATTING_SCREENS)
          writeFileSync(
            join(process.env.FORMATTING_SCREENS, `contrast-${width}-${colorScheme}.json`),
            JSON.stringify(contrast, null, 2)
          )
        // A fenced block is one frame, labelled with its language: nothing inside it draws
        // a second box (Streamdown's body and the pre have no border or background).
        const block = message.locator('[data-streamdown="code-block"]')
        await expect(block).toHaveCount(1)
        await expect(block.locator('[data-streamdown="code-block-header"]')).toHaveText("text")
        await expect(block.locator("pre")).toContainText('"code stays plain"')
        const frames = await block.evaluate((root) =>
          [root, ...root.querySelectorAll("*")].filter((element) => {
            const style = getComputedStyle(element)
            const painted = !["rgba(0, 0, 0, 0)", "transparent"].includes(style.backgroundColor)
            return painted || parseFloat(style.borderTopWidth) > 0 || parseFloat(style.borderLeftWidth) > 0
          }).length
        )
        expect(frames).toBe(1)
        const quote = message.locator("q").first()
        expect(await quote.locator("em").evaluate((el) => getComputedStyle(el).color)).toBe(
          await quote.evaluate((el) => getComputedStyle(el).color)
        )
      }
      if (process.env.FORMATTING_SCREENS) {
        await page.screenshot({
          path: join(
            process.env.FORMATTING_SCREENS,
            `${process.env.FORMATTING_STAGE ?? "after"}-${width}-${colorScheme}.png`
          ),
          fullPage: true
        })
      }
      if (process.env.FORMATTING_STAGE !== "before") {
        await page.goto(`${server().url}/chats/${fixture.chat.id}?panel=display`)
        const colors = [
          { label: "Main text", key: "mainTextColor", selector: "p", value: "#254b32" },
          { label: "Italics", key: "italicsTextColor", selector: "em", value: "#815734" },
          { label: "Underline", key: "underlineTextColor", selector: "u", value: "#2b6575" },
          { label: "Quote", key: "quoteTextColor", selector: "q", value: "#905087" }
        ] as const
        for (const color of colors) {
          const control = page.getByLabel(`${color.label} colour`, { exact: true })
          await expect(control).toBeVisible()
          await expect(control).toBeEnabled()
          await control.fill(color.value)
          await expect
            .poll(() =>
              asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
                Effect.map(api.GetDisplayPrefs({}), (prefs) => prefs[color.key])
              )
            )
            .toBe(color.value)
          await expect
            .poll(() =>
              message
                .locator(color.selector)
                .first()
                .evaluate((el) => getComputedStyle(el).color)
            )
            .toBe(`rgb(${[1, 3, 5].map((at) => parseInt(color.value.slice(at, at + 2), 16)).join(", ")})`)
        }
        await page.reload()
        for (const color of colors)
          await expect(page.getByLabel(`${color.label} colour`, { exact: true })).toHaveValue(color.value)
        if (process.env.FORMATTING_SCREENS)
          await page.screenshot({
            path: join(process.env.FORMATTING_SCREENS, `settings-${width}-${colorScheme}.png`),
            fullPage: true
          })
        for (const color of colors) {
          const reset = page.getByRole("button", { name: `Reset ${color.label.toLowerCase()} colour`, exact: true })
          await expect(reset).toBeEnabled()
          await reset.click()
          await expect
            .poll(() =>
              asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
                Effect.map(api.GetDisplayPrefs({}), (prefs) => prefs[color.key])
              )
            )
            .toBeNull()
        }
        const stored = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
          api.ReadPath({ chatId: fixture.chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 1 })
        )
        expect(stored.entries[0]?.version.content).toBe(sample)
      }
      expect(violations).toEqual([])
      await context.close()
    })
  }

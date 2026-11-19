// Document blocks in frames, scripts off (spec/HTML-MESSAGES.md §3.3, step 2): a synthetic
// message's full-document code block shows in a frame with an opaque origin, its own document,
// its height and the theme's colours, its script not run; with "Run panels in the last N
// messages" an older one waits for Run panel. At 1440 and 390, light and dark, with the layout audit.
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
import { closePanel } from "./support/panel.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)

const panel = (label: string) =>
  [
    `The ${label} panel follows.`,
    "",
    "```html",
    "<!doctype html>",
    "<html><head><style>",
    "body { margin: 0; color: var(--dreamspan-text); background: var(--dreamspan-background) }",
    ".box { box-sizing: border-box; height: 20vh; padding: 8px; border: 2px solid var(--dreamspan-accent) }",
    "</style></head>",
    `<body><div class="box" id="panel">${label} panel</div>`,
    "<script>document.body.dataset.ran = 'yes'</script>",
    "</body></html>",
    "```"
  ].join("\n")

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`a document block in a frame at ${width} (${theme})`, async ({ page }, info) => {
      test.setTimeout(120_000)
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
      const violations: string[] = []
      page.on("console", (message) => {
        if (message.text().includes("Content Security Policy")) violations.push(message.text())
      })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const fixture = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        Effect.gen(function* () {
          const chat = yield* api.CreateChat({ title: `Panels ${width} ${theme}` })
          yield* api.SetLcmEnabled({ chatId: chat.id, enabled: false })
          const first = yield* api.SendMessage({
            chatId: chat.id,
            parentSlotId: null,
            branch: false,
            content: panel("First"),
            reply: false
          })
          if (first._tag !== "Posted") throw new Error("expected message")
          const second = yield* api.SendMessage({
            chatId: chat.id,
            parentSlotId: first.entry.slotId,
            branch: false,
            content: panel("Second"),
            reply: false
          })
          if (second._tag !== "Posted") throw new Error("expected message")
          return { chat, first, second }
        })
      )
      await page.goto(`${server().url}/chats/${fixture.chat.id}`)
      const second = page.locator(`article[data-slot="${fixture.second.entry.slotId}"]`)
      const frame = second.locator('iframe[title="Panel"]')
      // A loaded host takes its time to render the first messages (the gate's runs).
      await expect(frame).toBeVisible({ timeout: 30_000 })
      await expect(frame).toHaveAttribute("sandbox", "allow-scripts")
      const inside = second.frameLocator('iframe[title="Panel"]')
      await expect(inside.locator("#panel")).toHaveText("Second panel")
      const content = page.frames().find((candidate) => candidate.url().endsWith("/frame/panel"))!
      expect(await content.evaluate(() => origin)).toBe("null")
      // The block's script didn't run; the theme's colours and the column's vh arrived.
      expect(await content.evaluate(() => document.body.dataset.ran ?? "")).toBe("")
      const colours = await inside.locator("#panel").evaluate((element) => ({
        color: getComputedStyle(element).color,
        border: getComputedStyle(element).borderTopColor
      }))
      const app = await page.evaluate(() => {
        const probe = document.createElement("div")
        probe.className = "text-text border-accent border"
        document.body.append(probe)
        const style = getComputedStyle(probe)
        const result = { color: style.color, border: style.borderTopColor }
        probe.remove()
        return result
      })
      expect(colours.color).toBe(app.color)
      expect(colours.border).toBe(app.border)
      // The column's height can still change as the page settles (the composer loading); the
      // frame hears of each change, so its 20vh follows within a moment.
      const panelHeight = () => inside.locator("#panel").evaluate((element) => element.getBoundingClientRect().height)
      await expect
        .poll(async () => {
          const column = await page.getByTestId("messages").evaluate((element) => element.clientHeight)
          return Math.abs((await panelHeight()) - column * 0.2)
        })
        .toBeLessThan(2)
      // The frame is as tall as its document.
      await expect
        .poll(async () => Math.abs(((await frame.boundingBox())?.height ?? 0) - (await panelHeight())))
        .toBeLessThan(1.5)
      await expectLayout(page, info, `html-frame-${width}-${theme}`, {
        scope: `article[data-slot="${fixture.second.entry.slotId}"]`
      })
      await page.screenshot({ path: info.outputPath(`html-frame-${width}-${theme}.png`) })

      // Only the last message's panel runs; the older one waits for Run panel.
      await page.goto(`${server().url}/chats/${fixture.chat.id}?panel=interface`)
      await page.getByRole("combobox", { name: /^Run panels in/ }).click()
      await page.getByRole("option", { name: "The last message", exact: true }).click()
      await expect(page.getByRole("combobox", { name: /^Run panels in/ })).toHaveText("The last message")
      await closePanel(page)
      const first = page.locator(`article[data-slot="${fixture.first.entry.slotId}"]`)
      await expect(first.locator('iframe[title="Panel"]')).toHaveCount(0)
      await expect(first.getByText("Older panel")).toBeVisible()
      await expect(second.locator('iframe[title="Panel"]')).toBeVisible()
      await first.getByRole("button", { name: "Run panel" }).click()
      await expect(first.frameLocator('iframe[title="Panel"]').locator("#panel")).toHaveText("First panel")
      await expectLayout(page, info, `html-frame-older-${width}-${theme}`, {
        scope: `article[data-slot="${fixture.first.entry.slotId}"]`
      })
      // The frame refuses its own script; the app reports nothing.
      expect(violations.filter((text) => !text.includes("/frame/"))).toEqual([])
    })

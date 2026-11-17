// The workshop beside a story before it exists (owner, 2026-11-17: "It should be a chat UI already
// open with the composer ... The chat is created when the first message is sent."): the Workshop
// tab opens on the chat's message area, with a brief intro, and its composer, focused; the first
// send makes the workshop and sends the message in one action; the intro is gone after it, and a
// reload keeps the workshop. At 1440 and 390, light and dark, with the layout audit. Synthetic
// data and a scripted loopback provider only.
import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, test } from "@playwright/test"
import { expectLayout } from "./support/layoutAudit.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { makeStory, SIDE_ANSWER, sidePanel, useSideChatProvider } from "./support/workshopSideChat.ts"

const shots = process.env.SCREENSHOT_DIR
const QUESTION = "What has happened in the harbor so far?"

test.describe("a workshop made by its first message", () => {
  const server = serverPerFile(withAdmin)
  useSideChatProvider(server)

  for (const width of [1440, 390])
    for (const theme of ["light", "dark"] as const)
      test(`composer first, made on send, kept on reload at ${width} ${theme}`, async ({ page }, info) => {
        test.setTimeout(120_000)
        const story = await makeStory(server, `Harbor ${width} ${theme}`)
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
        await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
        await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
        const shot = async (name: string) => {
          if (!shots) return
          mkdirSync(shots, { recursive: true })
          await page.waitForTimeout(200)
          await page.screenshot({ path: resolve(shots, `workshop-start-${name}-${width}-${theme}.png`) })
        }
        const panelScope = width === 390 ? '[role="dialog"]' : 'aside[aria-label="Chat panel"]'

        await page.goto(`${server().url}/chats/${story.id}?panel=workshop`)
        const panel = sidePanel(page)
        await expect(panel.getByText(/out of character/).first()).toBeVisible({ timeout: 30_000 })
        await shot("opened")

        // The chat's own surface, before anything exists: the intro in the message area, the
        // composer under it, focused, with the strip's model and preset chips.
        const intro = panel.locator("[data-side-chat-intro]")
        await expect(intro).toBeVisible()
        await expect(intro).toContainText("out of character")
        await expect(panel.getByRole("button", { name: /^Start a workshop$/ })).toHaveCount(0)
        const box = panel.getByLabel("Message", { exact: true })
        await expect(box).toBeVisible()
        await expect(box).toBeFocused()
        const send = panel.getByRole("button", { name: /^Send( as .+)?$/ })
        await expect(send).toBeVisible()
        await expect(panel.getByRole("button", { name: /^Model: / })).toBeVisible()
        await expect(panel.getByRole("button", { name: /^Prompt preset: / })).toBeVisible()
        // The saved workshop's composer before the first send (workshopstart2): the speaker
        // chip, Guidance and Generate, and the capability chip, changeable already.
        await expect(panel.getByRole("switch", { name: "Guidance" })).toBeVisible()
        await expect(panel.getByRole("button", { name: /^Generate/ })).toBeVisible()
        const chip = panel.getByRole("button", { name: /^What the assistant may do: / })
        await expect(chip).toBeVisible()
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await expectLayout(page, info, `workshop-start-pending-${width}-${theme}`, { scope: panelScope })
        await chip.click()
        const grantRow = page
          .getByRole("dialog", { name: "What the assistant may do" })
          .locator('[data-capability="library.write"]')
        await grantRow.getByRole("button", { name: "Ask first", exact: true }).click()
        await expect(grantRow).toHaveAttribute("data-mode", "ask")
        await page.keyboard.press("Escape")
        await expect(chip).toHaveAccessibleName(/asking first/)
        await box.focus()
        expect(
          await asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.ListAttachedWorkshops({ chatId: story.id }))
        ).toEqual([])

        // The first send makes the workshop and sends the message, in one action.
        await box.fill(QUESTION)
        await send.click()
        await expect(page).toHaveURL(/[?&]workshop=[^&]+/)
        const workshopId = new URL(page.url()).searchParams.get("workshop")!
        const side = panel.locator(`[data-side-chat="${workshopId}"]`)
        await expect(side).toBeVisible()
        await expect(side.getByRole("article").filter({ hasText: QUESTION })).toHaveCount(1)
        await expect(side.getByRole("article").filter({ hasText: SIDE_ANSWER })).toHaveCount(1, { timeout: 60_000 })
        await expect(panel.locator("[data-side-chat-intro]")).toHaveCount(0)
        await expect(side.getByLabel("Message", { exact: true })).toHaveValue("")
        const attached = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
          api.ListAttachedWorkshops({ chatId: story.id })
        )
        expect(attached.map((chat) => chat.id)).toEqual([workshopId])
        // The grant chosen before the send is the workshop's.
        const granted = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
          api.ListWorkshopCapabilities({ chatId: workshopId as never })
        )
        expect(granted.find((c) => c.id === "library.write")?.mode).toBe("ask")
        await shot("sent")
        await expectLayout(page, info, `workshop-start-sent-${width}-${theme}`, { scope: panelScope })

        // A reload keeps it: the same workshop, its messages, no intro.
        await page.reload()
        await expect(side.getByRole("article").filter({ hasText: QUESTION })).toHaveCount(1, { timeout: 30_000 })
        await expect(side.getByRole("article").filter({ hasText: SIDE_ANSWER })).toHaveCount(1)
        await expect(panel.locator("[data-side-chat-intro]")).toHaveCount(0)
        await shot("reloaded")
      })
})

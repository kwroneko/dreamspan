// The Chats page's start cards open a chat not made yet (owner, 2026-11-17: "The chat is created
// when the first message is sent"): New chat opens the pending chat page with no characters, New
// workshop the workshop's own pending page with the saved workshop's composer (speaker chip,
// Guidance, Generate, the model, preset and capability chips); nothing exists until the first
// send, and a reload keeps the page, its title and what's typed. A workshop's grants chosen
// before the first send are its own once made, and Generate is a first send too. At 1440 and
// 390 with the layout audit. Synthetic data and a scripted loopback provider only.
import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { expectLayout } from "./support/layoutAudit.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { useSideChatProvider } from "./support/workshopSideChat.ts"
import { expectTextBox } from "./support/textbox.ts"

const shots = process.env.SCREENSHOT_DIR

test.describe("chats started from the Chats page", () => {
  const server = serverPerFile(withAdmin)
  const provider = useSideChatProvider(server)
  const chats = () =>
    asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.ListChats({ limit: 500, before: null }))
  const shot = async (page: Page, name: string) => {
    if (!shots) return
    mkdirSync(shots, { recursive: true })
    await page.waitForTimeout(200)
    await page.screenshot({ path: resolve(shots, `${name}.png`) })
  }

  for (const width of [1440, 390]) {
    test(`New chat makes nothing until the first send, and a reload keeps it at ${width}`, async ({ page }, info) => {
      test.setTimeout(120_000)
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ reducedMotion: "reduce" })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const before = (await chats()).length
      const title = `Notebook ${width}`
      await page.goto(`${server().url}/chats`)
      await page.getByLabel("Title of the new chat").fill(title)
      await page.getByRole("button", { name: "New chat", exact: true }).click()
      await expect(page).toHaveURL(/\/new\/chat$/)
      await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible()
      await expect(page.locator("[data-empty-chat-intro]")).toBeVisible()
      await expect(page.getByLabel("Title of the new chat")).toHaveValue(title)
      const box = page.getByLabel("Message", { exact: true })
      await box.fill("A note to keep.")
      await expect(page.getByRole("button", { name: /^Generate/ })).toBeVisible()
      expect((await chats()).length).toBe(before)
      await shot(page, `new-chat-pending-${width}`)
      await expectLayout(page, info, `new-chat-pending-${width}`)

      // A reload keeps the pending page, its title and what's typed; still nothing is made.
      await page.waitForTimeout(800)
      await page.reload()
      await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible({ timeout: 30_000 })
      await expect(page.getByLabel("Title of the new chat")).toHaveValue(title)
      await expectTextBox(box, "A note to keep.")
      expect((await chats()).length).toBe(before)

      // The first send makes it, under that title, and its page opens in place.
      await page.getByRole("button", { name: /^Send/ }).click()
      await expect(page).toHaveURL(/\/chats\/[^/?]+/)
      await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible()
      await expect(page.getByRole("article").filter({ hasText: "A note to keep." })).toHaveCount(1)
      const after = await chats()
      expect(after.length).toBe(before + 1)
      expect(after.find((chat) => chat.title === title)).toBeTruthy()
      // The title's draft ended with it: the card is empty again.
      await page.goto(`${server().url}/chats`)
      await expect(page.getByLabel("Title of the new chat")).toHaveValue("")
      await shot(page, `new-chat-sent-${width}`)
    })

    test(`New workshop makes nothing until Generate, with the grants chosen before it at ${width}`, async ({
      page
    }, info) => {
      test.setTimeout(150_000)
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ reducedMotion: "reduce" })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const workshops = async () => (await chats()).filter((chat) => chat.kind === "workshop")
      const before = (await workshops()).length
      const title = `Library tidy ${width}`
      await page.goto(`${server().url}/chats`)
      await page.getByLabel("Title of the new workshop").fill(title)
      await page.getByRole("button", { name: "New workshop", exact: true }).click()
      await expect(page).toHaveURL(/\/new\/workshop/)
      await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible()
      await expect(page.locator("[data-workshop-intro]")).toBeVisible()
      await expect(page.getByLabel("Title of the new workshop")).toHaveValue(title)
      await expect(page.getByRole("button", { name: /^Assistant: / })).toBeVisible()
      // The saved workshop's composer: speaker, Guidance, Generate, Send, and the strip's chips.
      const box = page.getByLabel("Message", { exact: true })
      await expect(box).toBeFocused()
      await expect(page.getByRole("switch", { name: "Guidance" })).toBeVisible()
      await expect(page.getByRole("button", { name: /^Generate/ })).toBeVisible()
      await expect(page.getByRole("button", { name: /^Send/ })).toBeVisible()
      await expect(page.getByRole("button", { name: /^Model: / })).toBeVisible()
      await expect(page.getByRole("button", { name: /^Prompt preset: / })).toBeVisible()
      const chip = page.getByRole("button", { name: /^What the assistant may do: / })
      await expect(chip).toBeVisible()
      expect((await workshops()).length).toBe(before)
      await shot(page, `new-workshop-pending-${width}`)
      await expectLayout(page, info, `new-workshop-pending-${width}`)

      // A reload keeps the pending page and its title; still nothing is made.
      await page.waitForTimeout(800)
      await page.reload()
      await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible({ timeout: 30_000 })
      await expect(page.getByLabel("Title of the new workshop")).toHaveValue(title)
      expect((await workshops()).length).toBe(before)

      // A grant chosen before the first send: changing the library, Ask first.
      const capability = "library.write"
      await chip.click()
      const row = page
        .getByRole("dialog", { name: "What the assistant may do" })
        .locator(`[data-capability="${capability}"]`)
      await row.getByRole("button", { name: "Ask first", exact: true }).click()
      await expect(row.getByRole("button", { name: "Ask first", exact: true })).toHaveAttribute("aria-pressed", "true")
      await expect(row).toHaveAttribute("data-mode", "ask")
      await expect(row.getByRole("button", { name: "Use the default" })).toBeVisible()
      await expect(chip).toHaveAccessibleName(/asking first/)
      await shot(page, `new-workshop-grants-${width}`)
      await expectLayout(page, info, `new-workshop-grants-${width}`, { hovered: true })
      await page.keyboard.press("Escape")
      expect((await workshops()).length).toBe(before)

      // Generate with nothing typed is a first send: it makes the workshop, then asks for the turn.
      const asked = provider().bodies.length
      await page.getByRole("button", { name: /^Generate/ }).click()
      await expect(page).toHaveURL(/\/chats\/[^/?]+/, { timeout: 30_000 })
      const chatId = new URL(page.url()).pathname.split("/").at(-1)!
      const made = await workshops()
      expect(made.length).toBe(before + 1)
      expect(made.find((chat) => chat.id === chatId)?.title).toBe(title)
      const grants = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        api.ListWorkshopCapabilities({ chatId: chatId as never })
      )
      const granted = grants.find((c) => c.id === capability && c.target === undefined)!
      expect(granted.mode).toBe("ask")
      expect(granted.chosen).toBe(true)
      await expect.poll(() => provider().bodies.length, { timeout: 30_000 }).toBeGreaterThan(asked)
      await expect(page.locator("[data-workshop-intro]")).toHaveCount(0)
      await shot(page, `new-workshop-made-${width}`)
    })
  }
})

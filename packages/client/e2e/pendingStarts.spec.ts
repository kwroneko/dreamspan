// The Chats page's start cards open a chat not made yet (owner, 2026-11-17: "The chat is created
// when the first message is sent"): New chat opens a pending chat with no characters, New
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
      // A pending chat (DraftChatPage.tsx), named by the title typed, which its URL names.
      await expect(page).toHaveURL(/\/new\/chat\?draft=[^&]+$/)
      await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible()
      await expect(page.locator("[data-empty-chat-intro]")).toBeVisible()
      const box = page.getByLabel("Message", { exact: true })
      await box.fill("A note to keep.")
      await expect(page.getByRole("button", { name: /^Generate/ })).toBeVisible()
      expect((await chats()).length).toBe(before)
      await shot(page, `new-chat-pending-${width}`)
      await expectLayout(page, info, `new-chat-pending-${width}`)

      // A reload keeps the pending chat, its title and what's typed; still nothing is listed.
      await page.waitForTimeout(800)
      await page.reload()
      await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible({ timeout: 30_000 })
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
      // A pending chat under that title, on the saved workshop's page.
      await expect(page).toHaveURL(/\/new\/workshop\?.*draft=[^&]+/, { timeout: 30_000 })
      const pendingUrl = page.url()
      await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible()
      await expect(page.locator("[data-center-header]").first().getByText("new", { exact: true })).toBeVisible()
      // The saved workshop's composer: Guidance, Generate, and the strip's chips.
      await expect(page.getByLabel("Message", { exact: true })).toBeVisible()
      await expect(page.getByRole("switch", { name: "Guidance" })).toBeVisible()
      await expect(page.getByTestId("composer-controls").getByRole("button", { name: /^Generate/ })).toBeVisible()
      await expect(page.getByRole("button", { name: /^Model: / })).toBeVisible()
      await expect(page.getByRole("button", { name: /^Prompt preset: / })).toBeVisible()
      const chip = page.getByRole("button", { name: /^What the assistant may do: / })
      await expect(chip).toBeVisible()
      // The chips every chat kind has come first, in the same places; the workshop's own after them (owner, 2026-11-25).
      const strip = page.getByRole("group", { name: "Next reply", exact: true }).getByRole("button")
      const names = await strip.evaluateAll((buttons) => buttons.map((b) => b.getAttribute("aria-label") ?? ""))
      const at = (pattern: RegExp) => names.findIndex((name) => pattern.test(name))
      expect(at(/^Model: /)).toBeGreaterThanOrEqual(0)
      expect(at(/^Model: /)).toBeLessThan(at(/^Prompt preset: /))
      expect(at(/^Prompt preset: /)).toBeLessThan(at(/^What the assistant may do: /))
      // The subagents' models chip, where it shows, sits right after Model: another model selector.
      if (at(/^Subagents/) >= 0) expect(at(/^Subagents/)).toBe(at(/^Model: /) + 1)
      expect((await workshops()).length).toBe(before)
      await shot(page, `new-workshop-pending-${width}`)
      await expectLayout(page, info, `new-workshop-pending-${width}`)

      // A reload keeps the pending page and its title; still nothing is made.
      await page.waitForTimeout(800)
      await page.reload()
      await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible({ timeout: 30_000 })
      expect(page.url()).toBe(pendingUrl)
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
      await page
        .getByTestId("composer-controls")
        .getByRole("button", { name: /^Generate/ })
        .click()
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
      await shot(page, `new-workshop-made-${width}`)
    })

    test(`New workshop with a card is the saved workshop's page, and the first send moves nothing, at ${width}`, async ({
      page
    }, info) => {
      test.setTimeout(120_000)
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" })
      await page.addInitScript(() => localStorage.setItem("dreamspan.theme", "dark"))
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const name = `Quill ${width}`
      const greeting = `Quill sharpens a pen at ${width}.`
      const imported = await page.request.post(`${server().url}/library/import?name=quill.json`, {
        data: Buffer.from(
          JSON.stringify({
            spec: "chara_card_v2",
            spec_version: "2.0",
            data: { name, description: "A cardmaker who writes tidy cards.", first_mes: greeting }
          })
        ),
        headers: { origin: server().url, "content-type": "application/octet-stream" }
      })
      expect(imported.status()).toBe(200)
      const card = await asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.ListCards()).then((cards) =>
        cards.find((c) => c.name === name)!
      )
      const workshops = async () => (await chats()).filter((chat) => chat.kind === "workshop")
      const before = (await workshops()).length
      await page.goto(`${server().url}/new/workshop?workshopCard=${card.entityId}`)
      // A pending chat (spec/WORKSHOP-CARDS.md §3): the card's greeting is its first message, its
      // header, composer and strip the saved workshop's, with "new" and the kind's badge.
      await expect(page).toHaveURL(/\/new\/workshop\?.*draft=[^&]+/, { timeout: 30_000 })
      const first = page.getByRole("article").first()
      await expect(first).toContainText(greeting)
      const header = page.locator("[data-center-header]").first()
      await expect(header.getByText("new", { exact: true })).toBeVisible()
      await expect(header.getByText("Workshop", { exact: true })).toHaveCount(2)
      // What needs a started chat stays in place, disabled, saying why.
      if (width > 640) await expect(header.getByRole("button", { name: "Pin this branch" })).toBeDisabled()
      const box = page.getByLabel("Message", { exact: true })
      await expect(box).toBeVisible()
      expect((await workshops()).length).toBe(before)
      const places = async () => ({
        header: await header.boundingBox(),
        greeting: await first.boundingBox(),
        composer: await page.getByTestId("composer-box").boundingBox(),
        strip: await page
          .getByRole("group", { name: "Next reply" })
          .or(page.locator('[aria-label="Next reply"]'))
          .first()
          .boundingBox(),
        controls: await page.getByTestId("composer-controls").getByRole("button").count(),
        chips: await page
          .locator('[aria-label="Next reply"]')
          .first()
          .getByRole("button")
          .allInnerTexts()
          .then((texts) => texts.map((text) => text.replace(/[0-9.]+k?/g, "#")))
      })
      await page.waitForTimeout(300)
      const pending = await places()
      await shot(page, `new-workshop-card-${width}`)
      await expectLayout(page, info, `new-workshop-card-${width}`)

      // The first send starts it in place: the greeting is its first message, and nothing moved.
      await box.fill("Write me a card about a lighthouse.")
      await page.getByRole("button", { name: /^Send/ }).click()
      await expect(page).toHaveURL(/\/chats\/[^/?]+/, { timeout: 30_000 })
      const chatId = new URL(page.url()).pathname.split("/").at(-1)!
      await expect(page.getByRole("article").filter({ hasText: "Write me a card about a lighthouse." })).toHaveCount(1)
      // Its answer is in: the strip is as it rests.
      await expect(page.getByRole("article")).toHaveCount(3, { timeout: 60_000 })
      await expect(page.getByTestId("composer-controls").getByRole("button", { name: /^Generate/ })).toBeVisible()
      await page.waitForTimeout(500)
      await expect.poll(places, { timeout: 30_000 }).toEqual(pending)
      const made = await workshops()
      expect(made.map((chat) => chat.id)).toContain(chatId)
      expect(made.find((chat) => chat.id === chatId)?.title).toBe("Workshop")
      await shot(page, `new-workshop-card-sent-${width}`)
    })
  }
})

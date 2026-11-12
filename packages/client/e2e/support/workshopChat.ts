// Workshop chats in the browser (spec/WORKSHOP.md W2): made from the Chats page's Workshop card, a
// message sent, the assistant reading the library through its tools (the steps show), a reload,
// the badge in the chat lists and the header, the accent, the capability chip's popover, and a
// story chat that looks as it did. Run by workshop.spec.ts and, with LAYOUT_AUDIT_WORKSHOP_ONLY=1,
// by layoutAudit.spec.ts. Synthetic data and a scripted loopback provider only.
import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { expectLayout } from "./layoutAudit.ts"
import { openPanel } from "./panel.ts"
import { asUser } from "./rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./server.ts"
import { nextReply } from "./strip.ts"
import { startWorkshopProvider, WORKSHOP_ANSWER } from "./workshopProvider.ts"

const shots = process.env.SCREENSHOT_DIR

/** The accent the chat's main column paints with. */
const accentOf = (page: Page) =>
  page
    .locator("[data-chat-main]")
    .first()
    .evaluate((element) => getComputedStyle(element).getPropertyValue("--color-accent").trim())

export function workshopChatTests() {
  test.describe("workshop chat", () => {
    const server = serverPerFile(withAdmin)
    let provider: Awaited<ReturnType<typeof startWorkshopProvider>>
    test.beforeAll(async () => {
      provider = await startWorkshopProvider()
      await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        Effect.gen(function* () {
          yield* api.SetDisplayPrefs({ prefs: { steps: "expanded" } })
          const connection = yield* api.CreateConnection({
            kind: "openai-chat",
            settings: {
              name: "Synthetic workshop",
              baseUrl: provider.baseUrl,
              compat: {},
              cacheTtlS: null,
              maxConcurrent: null,
              presetOverrideRefId: null
            }
          })
          const model = yield* api.AddUserModel({ connectionId: connection.id, key: "workshop-small", overrides: {} })
          yield* api.SetGenerationDefaults({
            defaults: { model: { connection: connection.id, model: model.id }, preset: null }
          })
        })
      )
    })
    test.afterAll(async () => {
      await provider.stop()
    })

    for (const width of [1440, 390])
      for (const theme of ["light", "dark"] as const)
        test(`made, used and reloaded at ${width} ${theme}`, async ({ page }, info) => {
          test.setTimeout(180_000)
          const story = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
            Effect.gen(function* () {
              const chat = yield* api.CreateChat({ title: `Harbor story ${width} ${theme}` })
              yield* api.SendMessage({
                chatId: chat.id,
                parentSlotId: null,
                branch: false,
                content: "Synthetic story."
              })
              return chat
            })
          )
          const title = `Tidy up ${width} ${theme}`
          await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
          await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
          await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
          await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
          const shot = async (name: string) => {
            if (shots) {
              mkdirSync(shots, { recursive: true })
              await page.waitForTimeout(200)
              await page.screenshot({ path: resolve(shots, `workshop-${name}-${width}-${theme}.png`) })
            }
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
          }

          // The Chats page: a chat without characters, then the Workshop card.
          await page.goto(`${server().url}/chats`)
          const card = page.locator("form").filter({ has: page.getByLabel("Title of the new workshop") })
          await expect(page.getByLabel("Title of the new chat", { exact: true })).toBeVisible()
          await expect(card).toBeVisible()
          await expect(page.getByText("Workshop", { exact: true }).first()).toBeVisible()
          await card.scrollIntoViewIfNeeded()
          await shot("chats-page")
          await expectLayout(page, info, `workshop-chats-page-${width}-${theme}`)
          await page.getByLabel("Title of the new workshop").fill(title)
          await page.getByRole("button", { name: "New workshop", exact: true }).click()
          await expect(page).toHaveURL(/\/chats\/[^/?]+/)
          const url = new URL(page.url())
          const workshopId = url.pathname.split("/")[2]!

          // The workshop: its badge, its accent, its greeting, the chip in place of who replies.
          const main = page.locator("[data-chat-main]")
          await expect(page.locator('[data-chat-kind="workshop"]').first()).toBeVisible()
          await expect(main.locator('[data-kind-badge="workshop"]').first()).toBeVisible()
          await expect(page.getByTestId("composer")).toBeVisible()
          const workshopAccent = await accentOf(page)
          expect(workshopAccent).toBe(
          await expect(page.getByRole("button", { name: "New workshop", exact: true })).toHaveAccessibleDescription(
            "Opens a workshop. The assistant can read your library."
          )
            await page.evaluate(() =>
              getComputedStyle(document.documentElement).getPropertyValue("--accent-workshop").trim()
            )
          )
          const chip = nextReply(page).getByRole("button", { name: /^What the assistant may do: / })
          await expect(chip).toHaveText(/Can: 1/)
          await expect(
            nextReply(page).getByRole("button", { name: /replies now$|^Reply now$|^No one to reply$/ })
          ).toHaveCount(0)
          await expect(nextReply(page).getByRole("button", { name: /^Next: / })).toHaveCount(0)
          await chip.click()
          const popover = page.getByRole("dialog", { name: "What the assistant may do" })
          await expect(popover.locator('[data-capability="library.read"]')).toContainText("Read your library")
          await expect(popover.locator('[data-capability="library.read"]')).toContainText("Always allowed")
          await expect(popover.getByText("You can’t change these yet.")).toBeVisible()
          await shot("capabilities")
          await expectLayout(page, info, `workshop-capabilities-${width}-${theme}`, { scope: '[role="dialog"]' })
          await page.keyboard.press("Escape")
          await expect(popover).toHaveCount(0)

          // A message; the assistant looks in the library and answers, its steps shown.
          await page.getByLabel("Message", { exact: true }).fill("What cards do I have?")
          await page.getByRole("button", { name: /^Send( as .+)?$/ }).click()
          const reply = page.getByRole("article").filter({ hasText: WORKSHOP_ANSWER })
          await expect(reply).toBeVisible({ timeout: 30_000 })
          const steps = reply.locator("[data-steps-panel]")
          await expect(steps).toHaveAttribute("data-steps-panel", "done")
          await expect(reply.locator("[data-steps-badge]")).toHaveText(/^2 steps/)
          await reply.locator("[data-steps-badge]").click()
          const rows = steps.locator('[data-step="tool"]')
          await expect(rows).toHaveCount(2)
          await expect(rows.nth(0)).toContainText("Looked in your library")
          await expect(rows.nth(1)).toContainText("Read a card")
          await expect(rows.nth(1)).toContainText("Assistant")
          expect(provider.toolResults().join("\n")).toContain("Assistant")
          await shot("reply")
          await expectLayout(page, info, `workshop-reply-${width}-${theme}`, { scope: "article:last-of-type" })

          // The run's request names the workshop's instructions.
          await steps.getByRole("link", { name: "Open the run" }).click()
          await expect(page.getByText("Workshop instructions").first()).toBeVisible()
          await page.goBack()

          // This chat leaves out the story's settings; the URL alone brings the workshop back.
          const settings = await openPanel(page, "This chat")
          await expect(settings.getByRole("switch", { name: "Tools", exact: true })).toHaveCount(0)
          await expect(settings.getByRole("region", { name: "Summaries" })).toHaveCount(0)
          await expect(settings.getByRole("region", { name: "Who replies" })).toHaveCount(0)
          await shot("this-chat")
          await expectLayout(page, info, `workshop-this-chat-${width}-${theme}`, { scope: '[role="tabpanel"]' })
          await page.goto(`${server().url}/chats/${workshopId}`)
          await expect(page.locator('[data-chat-kind="workshop"]').first()).toBeVisible()
          await expect(page.getByRole("article").filter({ hasText: WORKSHOP_ANSWER })).toBeVisible()
          await expect(main.locator('[data-kind-badge="workshop"]').first()).toBeVisible()
          await shot("reloaded")
          await expectLayout(page, info, `workshop-chat-${width}-${theme}`)

          // The chat lists: the workshop's row has the badge, the story's doesn't.
          if (width === 1440) {
            const rows = page.locator("[data-fork-row]")
            await expect(rows.filter({ hasText: title }).locator('[data-kind-badge="workshop"]')).toBeVisible()
            await expect(rows.filter({ hasText: story.title }).locator("[data-kind-badge]")).toHaveCount(0)
          }
          await page.goto(`${server().url}/chats`)
          const list = page.getByRole("list", { name: "Chats" })
          await expect(
            list.getByRole("listitem").filter({ hasText: title }).locator('[data-kind-badge="workshop"]')
          ).toBeVisible()
          await expect(
            list.getByRole("listitem").filter({ hasText: story.title }).locator("[data-kind-badge]")
          ).toHaveCount(0)
          await shot("list")
          await expectLayout(page, info, `workshop-list-${width}-${theme}`, { scope: '[aria-label="Chats"]' })

          // A story chat is as it was: no kind, its own accent, Reply now and Tools in place.
          await page.goto(`${server().url}/chats/${story.id}`)
          await expect(page.getByTestId("composer")).toBeVisible()
          await expect(page.locator("[data-chat-kind]")).toHaveCount(0)
          await expect(main.locator("[data-kind-badge]")).toHaveCount(0)
          expect(await accentOf(page)).not.toBe(workshopAccent)
          await shot("story")
          await expect(nextReply(page).getByRole("button", { name: /^What the assistant may do/ })).toHaveCount(0)
          await expect(
            nextReply(page).getByRole("button", { name: /replies now$|^Reply now$|^No one to reply$/ })
          ).toHaveCount(1)
          const storySettings = await openPanel(page, "This chat")
          await expect(storySettings.getByRole("switch", { name: "Tools", exact: true })).toBeVisible()
          await expect(storySettings.getByRole("region", { name: "Summaries" })).toBeVisible()
        })
  })
}
          await expect(settings.getByRole("switch", { name: "Card swap", exact: true })).toBeVisible()

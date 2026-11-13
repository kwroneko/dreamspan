// The workshop beside a story (spec/WORKSHOP.md §4, W9) in the browser: "Talk about this chat" in
// the story's ⋯ menu, the Workshop tab showing the workshop's own messages and composer, the
// assistant reading the story through read_story, the story left as it was, a reload and a second
// tab showing the same workshop, an unknown one falling back, and a deleted one leaving the empty
// state. Run by workshopSideChat.spec.ts and, with LAYOUT_AUDIT_WORKSHOP_ONLY=1, by
// layoutAudit.spec.ts. Synthetic data and a scripted loopback provider only.
import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import type { ChatId } from "@rp/shared/chat.ts"
import { expectLayout } from "./layoutAudit.ts"
import { showActions } from "./message.ts"
import { asUser } from "./rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./server.ts"
import { startWorkshopProvider, STORY_REPLY } from "./workshopProvider.ts"

export const SIDE_ANSWER = "The ledger story so far: three ships are listed, and the harbor bell rang twice."
const STORY_LINE = "The ledger lists three ships."
/** The side chat reads the story, then answers. */
const SIDE_CALLS = [{ name: "read_story", arguments: {} }]

const shots = process.env.SCREENSHOT_DIR

/** The Workshop tab's panel: beside the chat, or a phone's sheet. */
export const sidePanel = (page: Page) => page.getByRole("tabpanel", { name: "Workshop" })

/** Sets up the scripted provider as the account's default model. */
export const useSideChatProvider = (
  server: () => Parameters<typeof asUser>[0],
  options: Parameters<typeof startWorkshopProvider>[0] = {}
) => {
  const state: { provider: Awaited<ReturnType<typeof startWorkshopProvider>> | null } = { provider: null }
  test.beforeAll(async () => {
    const provider = await startWorkshopProvider({ calls: SIDE_CALLS, perTask: true, answer: SIDE_ANSWER, ...options })
    state.provider = provider
    await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
      Effect.gen(function* () {
        yield* api.SetDisplayPrefs({ prefs: { steps: "expanded" } })
        const connection = yield* api.CreateConnection({
          kind: "openai-chat",
          settings: {
            name: "Synthetic side chat",
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
    await state.provider?.stop()
  })
  return () => state.provider!
}

export function workshopSideChatEffectsTests() {
  test.describe("workshop side-chat changes", () => {
    const server = serverPerFile(withAdmin)
    const opening = "I'll make a synthetic keeper."
    const provider = useSideChatProvider(server, {
      calls: [
        { name: "send_message", arguments: { message: opening } },
        { name: "create_card", arguments: { name: "Side keeper", description: "A synthetic keeper." } }
      ]
    })
    for (const width of [1440, 390])
      for (const theme of ["light", "dark"] as const)
        test(`approval, regenerate warning and undo at ${width} ${theme}`, async ({ page }, info) => {
          test.setTimeout(120_000)
          const story = await makeStory(server, `Side changes ${width} ${theme}`)
          const workshop = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
            Effect.gen(function* () {
              const chat = yield* api.CreateWorkshop({ attachTo: story.id })
              yield* api.SetWorkshopGrant({ chatId: chat.id, capability: "library.write", mode: "ask" })
              return chat
            })
          )
          await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
          await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
          await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
          await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
          await page.goto(`${server().url}/chats/${story.id}?panel=workshop&workshop=${workshop.id}`)
          const side = sidePanel(page).locator(`[data-side-chat="${workshop.id}"]`)
          await side.getByLabel("Message", { exact: true }).fill("Make a synthetic keeper.")
          await side.getByRole("button", { name: /^Send( as .+)?$/ }).click()
          const approval = side.locator("[data-approval]")
          await expect(approval).toContainText("Side keeper", { timeout: 30_000 })
          await expectLayout(page, info, `side-change-approval-${width}-${theme}`, { scope: "[data-approval]" })
          await approval.getByRole("button", { name: "Allow", exact: true }).click()
          const answer = side.getByRole("article").filter({ hasText: SIDE_ANSWER })
          await expect(answer).toHaveCount(1)
          const badge = answer.locator("[data-steps-badge]")
          if ((await badge.getAttribute("aria-pressed")) !== "true") await badge.click()
          const changed = side.locator('[data-effect-kind="library.create"]')
          await expect(changed.getByRole("button", { name: "Undo", exact: true })).toBeVisible()
          await expectLayout(page, info, `side-change-undo-${width}-${theme}`, { scope: "[data-side-chat]" })
          const first = side.getByRole("article").filter({ hasText: opening })
          await showActions(first)
          await first.getByRole("button", { name: "Generate another version", exact: true }).click()
          const warning = page.getByRole("dialog", { name: "This reply changed things outside the chat" })
          await expect(warning).toContainText("Side keeper")
          await expectLayout(page, info, `side-change-warning-${width}-${theme}`, { scope: '[role="dialog"]' })
          const before = provider().bodies.length
          await warning.getByRole("button", { name: "Cancel", exact: true }).click()
          expect(provider().bodies.length).toBe(before)
          await changed.getByRole("button", { name: "Undo", exact: true }).click()
          await expect(changed).toContainText("Undone")
          const effects = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
            api.ListRolloutEffects({ chatId: workshop.id })
          )
          expect(effects).toHaveLength(1)
          expect(effects[0]!.undoneAt).not.toBeNull()
          const other = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
            api.CreateWorkshop({ attachTo: story.id })
          )
          const permissions = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
            api.ListWorkshopCapabilities({ chatId: other.id })
          )
          expect(permissions.find((c) => c.id === "library.write")!.mode).toBe("allow")
        })
  })
}

/** A story with one user message and the model's reply. */
export const makeStory = (server: () => Parameters<typeof asUser>[0], title: string) =>
  asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title })
      const human = yield* api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: STORY_LINE })
      if (human._tag !== "Posted") return yield* Effect.die("unexpected queue")
      yield* api.Generate({ chatId: chat.id, parentSlotId: human.entry.slotId, branch: false })
      return chat
    })
  )

/** The accent an element paints with. */
const accentOf = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((element) => getComputedStyle(element).getPropertyValue("--color-accent").trim())

export function workshopSideChatTests() {
  test.describe("workshop beside a story", () => {
    const server = serverPerFile(withAdmin)
    const provider = useSideChatProvider(server)

    for (const width of [1440, 390])
      for (const theme of ["light", "dark"] as const)
        test(`talked about, reloaded and fallen back at ${width} ${theme}`, async ({ page, context }, info) => {
          test.setTimeout(180_000)
          const title = `Ledger ${width} ${theme}`
          const story = await makeStory(server, title)
          await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
          await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
          await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
          await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
          const shot = async (name: string) => {
            if (shots) {
              mkdirSync(shots, { recursive: true })
              await page.waitForTimeout(200)
              await page.screenshot({ path: resolve(shots, `side-chat-${name}-${width}-${theme}.png`) })
            }
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
          }
          const panelScope = width === 390 ? '[role="dialog"]' : 'aside[aria-label="Chat panel"]'

          await page.goto(`${server().url}/chats/${story.id}`)
          await expect(page.getByRole("article").filter({ hasText: STORY_REPLY })).toHaveCount(1, { timeout: 30_000 })
          await expectLayout(page, info, `story-messages-${width}-${theme}`, { scope: '[data-testid="messages"]' })
          const storyArticles = await page.getByTestId("messages").getByRole("article").count()

          // The ⋯ menu's way in, explained beside it.
          await page.getByRole("button", { name: "Chat actions", exact: true }).click()
          const item = page.getByRole("menuitem", { name: "Talk about this chat", exact: true })
          await item.hover()
          await expect(item).toHaveAccessibleDescription(
            "Opens a workshop beside this chat to talk about it out of character"
          )
          await item.click()
          await expect(page).toHaveURL(/[?&]panel=workshop(&|$)/)
          await expect(page).toHaveURL(/[?&]workshop=[^&]+/)
          const workshopId = new URL(page.url()).searchParams.get("workshop")!
          const panel = sidePanel(page)
          const side = panel.locator(`[data-side-chat="${workshopId}"]`)
          await expect(side).toBeVisible()
          await expect(side).toHaveAttribute("data-chat-kind", "workshop")
          await expect(side.locator('[data-kind-badge="workshop"]')).toBeVisible()
          await expect(side.getByRole("button", { name: `Workshop: About ${title}`, exact: true })).toBeVisible()
          // The workshop's accent inside, the story's outside.
          const storyAccent = await accentOf(page, "[data-chat-main]")
          const sideAccent = await accentOf(page, `[data-side-chat="${workshopId}"]`)
          expect(sideAccent).not.toBe(storyAccent)
          await shot("opened")
          await expectLayout(page, info, `side-chat-opened-${width}-${theme}`, { scope: panelScope })

          // A message in the side chat: the assistant reads the story through its tool.
          const before = provider().bodies.length
          await side.getByLabel("Message", { exact: true }).fill("What has happened so far?")
          await side.getByRole("button", { name: /^Send( as .+)?$/ }).click()
          const answer = side.getByRole("article").filter({ hasText: SIDE_ANSWER })
          await expect(answer).toHaveCount(1, { timeout: 60_000 })
          // Text arrives before the final event, which folds live steps. Open only after it settles.
          await expect(answer.locator("[data-steps-panel]")).toHaveAttribute("data-steps-panel", "done")
          await expect(answer.locator("[data-steps-badge]")).toHaveText(/^1 step/)
          const fold = answer.locator("[data-steps-panel] button[aria-expanded]").first()
          await expect(fold).toBeVisible()
          if ((await fold.getAttribute("aria-expanded")) === "false") await fold.click()
          await expect(answer.locator('[data-step="tool"]').first()).toContainText("Read the story", {
            timeout: 10_000
          })
          const sent = provider().bodies.slice(before)
          expect(sent.some((body) => body.tools?.some((tool) => tool.function.name === "read_story"))).toBe(true)
          expect(JSON.stringify(sent.at(-1)!.messages)).toContain(STORY_LINE)
          await shot("answered")
          await expectLayout(page, info, `side-chat-answered-${width}-${theme}`, { scope: panelScope })

          // One visible permission, naming only this story. Both revocations take effect
          // through the chip rather than relying on a direct test RPC to set the grant.
          const permissions = side.getByRole("button", { name: /^What the assistant may do:/ })
          await permissions.click()
          const row = page.locator('[data-capability="chats.read"]:visible')
          await expect(row).toHaveCount(1)
          await expect(row).toContainText("Read this story")
          await expect(row).toContainText(title)
          await expect(row).toHaveAttribute("data-mode", "allow")
          await expectLayout(page, info, `side-chat-permission-${width}-${theme}`, { scope: "[data-capabilities]" })
          await row.getByRole("button", { name: "Ask first", exact: true }).click()
          await expect(row).toHaveAttribute("data-mode", "ask")
          await page.keyboard.press("Escape")
          await side.getByLabel("Message", { exact: true }).fill("Read again, asking me first.")
          await side.getByRole("button", { name: /^Send( as .+)?$/ }).click()
          const allow = side.getByRole("button", { name: "Allow", exact: true })
          await expect(allow).toBeVisible({ timeout: 30_000 })
          await expectLayout(page, info, `side-chat-approval-${width}-${theme}`, { scope: panelScope })
          await allow.click()
          await expect(side.getByRole("article").filter({ hasText: SIDE_ANSWER })).toHaveCount(2)
          await permissions.click()
          await row.getByRole("button", { name: "Off", exact: true }).click()
          await expect(row).toHaveAttribute("data-mode", "off")
          await page.keyboard.press("Escape")
          const offStart = provider().bodies.length
          await side.getByLabel("Message", { exact: true }).fill("Answer without reading the story.")
          await side.getByRole("button", { name: /^Send( as .+)?$/ }).click()
          await expect(side.getByRole("article").filter({ hasText: SIDE_ANSWER })).toHaveCount(3)
          expect(
            provider()
              .bodies.slice(offStart)
              .every((body) => !body.tools?.some((tool) => tool.function.name === "read_story"))
          ).toBe(true)

          // The story is as it was: nothing of the side chat in it.
          if (width === 390) await page.keyboard.press("Escape")
          await expect(page.getByTestId("messages").getByRole("article")).toHaveCount(storyArticles)
          await expect(page.getByTestId("messages").getByText(SIDE_ANSWER)).toHaveCount(0)
          const storyPath = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
            api.ReadPath({ chatId: story.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 50 })
          )
          expect(JSON.stringify(storyPath.entries)).not.toContain(SIDE_ANSWER)

          // The URL brings the same workshop back, in a reload and in a second tab.
          await page.goto(`${server().url}/chats/${story.id}?panel=workshop&workshop=${workshopId}`)
          await expect(sidePanel(page).getByRole("article").filter({ hasText: SIDE_ANSWER })).toHaveCount(3)
          if (width === 1440 && theme === "light") {
            const second = await context.newPage()
            await second.setViewportSize({ width, height: 900 })
            await second.goto(page.url())
            await expect(
              sidePanel(second).locator(`[data-side-chat="${workshopId}"]`).getByRole("article").filter({
                hasText: SIDE_ANSWER
              })
            ).toHaveCount(3)
            await second.close()
          }

          // A workshop that isn't beside this story: said so, and the newest is shown.
          await page.goto(`${server().url}/chats/${story.id}?panel=workshop&workshop=${story.id}`)
          await expect(page.getByText("That workshop isn't beside this chat any more.").first()).toBeVisible()
          await expect(sidePanel(page).locator(`[data-side-chat="${workshopId}"]`)).toBeVisible()
          await expect(page).not.toHaveURL(/[?&]workshop=/)

          // Deleted: the tab offers to start another.
          await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
            api.DeleteChat({ chatId: workshopId as ChatId })
          )
          await page.goto(`${server().url}/chats/${story.id}?panel=workshop&workshop=${workshopId}`)
          await expect(page.getByText("That workshop isn't beside this chat any more.").first()).toBeVisible()
          const empty = sidePanel(page).locator("[data-side-chat-empty]")
          await expect(empty).toBeVisible()
          const startButton = empty.getByRole("button", { name: "Start a workshop", exact: true })
          await expect(startButton).toHaveAccessibleDescription(
            "Starts a new workshop beside this chat, to talk about it out of character."
          )
          await shot("empty")
          await expectLayout(page, info, `side-chat-empty-${width}-${theme}`, { scope: panelScope })
          // Stale choices of the removed workshop must not leak into the replacement.
          await page.goto(`${page.url()}&side.fork=${story.currentForkId}&side.messageDialog=old&side.stepEdit=old`)
          await startButton.click()
          await expect(sidePanel(page).locator("[data-side-chat]")).toBeVisible()
          await expect(page).toHaveURL(/[?&]workshop=[^&]+/)
          expect(new URL(page.url()).searchParams.get("workshop")).not.toBe(workshopId)
          await expect(page).not.toHaveURL(/side\.(fork|messageDialog|stepEdit)=/)
        })
  })
}

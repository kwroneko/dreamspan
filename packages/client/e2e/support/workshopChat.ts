// Workshop chats in the browser (spec/WORKSHOP.md W2): made from the Chats page's Workshop card, a
// message sent, the assistant reading the library through its tools (the steps show), a reload,
// the badge in the chat lists and the header, the accent, the capability chip's popover, and a
// story chat that looks as it did. Run by workshop.spec.ts and, with LAYOUT_AUDIT_WORKSHOP_ONLY=1,
// by layoutAudit.spec.ts. Synthetic data and a scripted loopback provider only.
import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import type { ChatId } from "@rp/shared/chat.ts"
import { expectLayout } from "./layoutAudit.ts"
import { closePanel, openPanel } from "./panel.ts"
import { asUser } from "./rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./server.ts"
import { nextReply } from "./strip.ts"
import {
  startWorkshopProvider,
  STORY_REPLY,
  WORKSHOP_ANSWER,
  WORKSHOP_FIRST,
  WORKSHOP_SECOND
} from "./workshopProvider.ts"
import { messageMenu, showActions } from "./message.ts"

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
          const model = yield* api.AddUserModel({
            connectionId: connection.id,
            key: "workshop-small",
            overrides: { context: 32768, settings: { samplers: { openai_max_context: 32768 } } }
          })
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
          await page.addInitScript(() => {
            localStorage.setItem("rp.notifications.system", "on")
            const notices: Array<{ title: string; body: string | undefined }> = []
            Object.assign(window, { workshopNotices: notices })
            Object.defineProperty(window, "Notification", {
              value: class {
                static permission = "granted"
                onclick: (() => void) | null = null
                constructor(title: string, options: NotificationOptions) {
                  notices.push({ title, body: options.body })
                }
                close() {}
              }
            })
          })
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
          await expect(page.getByRole("button", { name: "New workshop", exact: true })).toHaveAccessibleDescription(
            "Opens a workshop. The assistant can read and change your library and set up chats."
          )
          await card.scrollIntoViewIfNeeded()
          await shot("chats-page")
          await expectLayout(page, info, `workshop-chats-page-${width}-${theme}`)
          // Keep the existing cards usable when a translation takes much more room.
          const headings = page.locator("section h2")
          const originalHeadings = await headings.allTextContents()
          await headings.evaluateAll((elements) => {
            for (const heading of elements)
              heading.textContent = `${heading.textContent} — Ein ausführlicher übersetzter Titel für diesen Arbeitsbereich`
          })
          await page
            .getByLabel("Title of the new chat", { exact: true })
            .fill("A long synthetic title for a chat without characters and a very distant harbor")
          await page
            .getByLabel("Title of the new workshop")
            .fill("A long synthetic title for a workshop about cards, presets and lorebooks")
          for (const label of ["Title of the new chat", "Title of the new workshop"]) {
            await page
              .locator("section")
              .filter({ has: page.getByLabel(label, { exact: true }) })
              .last()
              .scrollIntoViewIfNeeded()
            await expectLayout(page, info, `workshop-start-cards-long-${label}-${width}-${theme}`)
          }
          await headings.evaluateAll((elements, originals) => {
            elements.forEach((heading, index) => {
              heading.textContent = originals[index]!
            })
          }, originalHeadings)
          await page.getByLabel("Title of the new workshop").fill(title)
          await page.getByRole("button", { name: "New workshop", exact: true }).click()
          await expect(page).toHaveURL(/\/chats\/[^/?]+/)
          const url = new URL(page.url())
          const workshopId = url.pathname.split("/")[2]! as ChatId

          // The workshop: its badge, its accent, its greeting, the chip in place of who replies.
          const main = page.locator("[data-chat-main]")
          await expect(page.locator('[data-chat-kind="workshop"]').first()).toBeVisible()
          await expect(page).toHaveTitle(`Workshop · ${title} · rp-harness`)
          await expect(main.locator('[data-kind-badge="workshop"]').first()).toBeVisible()
          await expect(page.getByTestId("composer")).toBeVisible()
          const workshopAccent = await accentOf(page)
          expect(workshopAccent).toBe(
            await page.evaluate(() =>
              getComputedStyle(document.documentElement).getPropertyValue("--accent-workshop").trim()
            )
          )
          const contrast = await main.evaluate((element) => {
            const style = getComputedStyle(element)
            const canvas = document.createElement("canvas")
            const context = canvas.getContext("2d")!
            const luminance = (token: string) => {
              context.fillStyle = style.getPropertyValue(token).trim()
              context.fillRect(0, 0, 1, 1)
              const [r, g, b] = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map((value) => {
                const c = value / 255
                return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
              })
              return r! * 0.2126 + g! * 0.7152 + b! * 0.0722
            }
            const ratio = (a: string, b: string) => {
              const x = luminance(a),
                y = luminance(b)
              return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
            }
            return {
              onAccent: ratio("--accent-contrast", "--color-accent"),
              text: ["--canvas", "--surface", "--surface-raised"].map((bg) => ratio("--color-accent", bg)),
              focus: ["--canvas", "--surface", "--surface-raised"].map((bg) => ratio("--color-focus", bg))
            }
          })
          expect(contrast.onAccent).toBeGreaterThanOrEqual(4.5)
          for (const ratio of contrast.text) expect(ratio).toBeGreaterThanOrEqual(4.5)
          for (const ratio of contrast.focus) expect(ratio).toBeGreaterThanOrEqual(3)
          await info.attach("workshop-contrast", { body: JSON.stringify(contrast), contentType: "application/json" })
          if (theme === "dark") {
            await page.evaluate(() => document.documentElement.removeAttribute("data-theme"))
            expect(await accentOf(page)).toBe(workshopAccent)
            await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"))
          }
          const chip = nextReply(page).getByRole("button", { name: /^What the assistant may do: / })
          await expect(chip).toHaveText(/Can: 5 · Asks: 3/)
          await expect(
            nextReply(page).getByRole("button", { name: /replies now$|^Reply now$|^No one to reply$/ })
          ).toHaveCount(0)
          await expect(nextReply(page).getByRole("button", { name: /^Next: / })).toHaveCount(0)
          await chip.click()
          const popover = page.getByRole("dialog", { name: "What the assistant may do" })
          await expect(popover.locator('[data-capability="library.read"]')).toContainText("Read your library")
          await expect(popover.locator('[data-capability="library.read"]')).toContainText("Always allowed")
          for (const [id, label] of [
            ["library.write", "Create and edit library items"],
            ["chats.setup", "Set up chats"],
            ["chats.rewrite", "Rewrite chats"],
            ["settings", "Change your settings"]
          ]) {
            const row = popover.locator(`[data-capability="${id}"]`)
            await expect(row).toContainText(label!)
            // Off, Ask first and Allowed, with Allowed the default (WORKSHOP §10 Q1, still Open).
            await expect(row.getByRole("button", { name: "Allowed", exact: true })).toHaveAttribute(
              "aria-pressed",
              "true"
            )
            await expect(row.getByRole("button", { name: "Ask first", exact: true })).toHaveAttribute(
              "aria-pressed",
              "false"
            )
            await expect(row.getByRole("button", { name: "Off", exact: true })).toBeVisible()
          }
          for (const id of ["chats.read", "generate", "skills.card"]) {
            await expect(
              popover.locator(`[data-capability="${id}"]`).getByRole("button", { name: "Ask first", exact: true })
            ).toHaveAttribute("aria-pressed", "true")
          }
          await expect(popover.locator("[data-capability]")).toHaveCount(8)
          await expect(popover.getByText("These hold for this workshop only.")).toBeVisible()
          await shot("capabilities")
          await expectLayout(page, info, `workshop-capabilities-${width}-${theme}`, { scope: '[role="dialog"]' })
          await page.keyboard.press("Escape")
          await expect(popover).toHaveCount(0)

          // A message; the assistant looks in the library and answers, its steps shown.
          // A background tab gets a system notice whose plain text carries the kind too.
          await page.evaluate(() =>
            Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" })
          )
          provider.hold(1)
          const offeredAt = provider.bodies.length
          await page.getByLabel("Message", { exact: true }).fill("What cards do I have?")
          await page.getByRole("button", { name: /^Send( as .+)?$/ }).click()
          const stopped = page.getByRole("article").last()
          await expect(stopped.locator('[data-step-status="done"]')).toHaveCount(1)
          await expect.poll(() => provider.heldCount()).toBeGreaterThan(0)
          await stopped.getByRole("button", { name: "Stop", exact: true }).click()
          await expect(stopped.getByText("stopped", { exact: true })).toBeVisible()
          await expectLayout(page, info, `workshop-stopped-${width}-${theme}`, { scope: "article:last-of-type" })
          if (width === 390) await stopped.getByText("stopped", { exact: true }).click()
          else await showActions(stopped)
          const beforeResume = provider.bodies.length
          const resume = stopped.getByRole("button", { name: "Resume", exact: true })
          if (await resume.isVisible()) await resume.click()
          else await messageMenu(stopped, /^Resume/)
          await expect.poll(() => provider.bodies.length).toBeGreaterThan(beforeResume)
          expect(provider.bodies[beforeResume]!.tools).toEqual(provider.bodies[offeredAt]!.tools)
          expect(provider.bodies[beforeResume]!.messages.at(-1)?.role).toBe("tool")
          provider.release()
          const reply = page.getByRole("article").filter({ hasText: WORKSHOP_ANSWER }).last()
          await expect(reply).toBeVisible({ timeout: 30_000 })
          await expect
            .poll(() =>
              page.evaluate(() =>
                (window as unknown as { workshopNotices: Array<{ body: string }> }).workshopNotices.map(
                  (notice) => notice.body
                )
              )
            )
            .toContain(`Workshop · ${title}`)
          await page.evaluate(() => Reflect.deleteProperty(document, "visibilityState"))
          const steps = reply.locator("[data-steps-panel]")
          await expect(steps).toHaveAttribute("data-steps-panel", "done")
          await expect(reply.locator("[data-steps-badge]")).toHaveText(/^2 steps/)
          await reply.locator("[data-steps-badge]").click()
          const rows = steps.locator('[data-step="tool"]')
          await expect(rows).toHaveCount(2)
          await expect(rows.nth(0)).toContainText("Read a preset")
          for (const [text, label] of [
            [WORKSHOP_FIRST, "Looked in your library"],
            [WORKSHOP_SECOND, "Read a card"]
          ]) {
            const message = page.getByRole("article").filter({ hasText: text! }).last()
            await expect(message).toBeVisible()
            await expect(message.locator("[data-steps-badge]")).toHaveText(/^1 step/)
            await message.locator("[data-steps-badge]").click()
            await expect(message.locator('[data-step="tool"]')).toHaveCount(1)
            await expect(message.locator('[data-step="tool"]')).toContainText(label!)
          }
          await expect(rows.nth(1)).toContainText("Created the card Mara Quill")
          // The change it made, with Undo and Open under its step (W4).
          await expect(rows.nth(1).getByRole("button", { name: "Undo", exact: true })).toHaveCount(1)
          await expect(rows.nth(1).getByRole("link", { name: "Open", exact: true })).toHaveCount(1)
          const created = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
            api.ListRolloutEffects({ chatId: workshopId })
          )
          expect(created).toHaveLength(1)
          expect(created[0]!.title).toBe("Created the card Mara Quill")
          expect(provider.toolResults().join("\n")).toContain("Assistant")
          await shot("reply")
          await expectLayout(page, info, `workshop-reply-${width}-${theme}`, { scope: "article:last-of-type" })

          // The run's request names the workshop's instructions.
          await steps.getByRole("link", { name: "Open the run" }).click()
          await expect(page.getByText("Workshop instructions").first()).toBeVisible()
          await expect(page.getByText("First request", { exact: true })).toHaveCount(0)
          await expectLayout(page, info, `workshop-run-${width}-${theme}`)
          await page.goBack()

          // The next turn retains the whole run; its inspector links the previous one.
          await page.getByLabel("Message", { exact: true }).fill("Carry on from that work.")
          await page.getByRole("button", { name: /^Send( as .+)?$/ }).click()
          await expect(page.getByRole("article").filter({ hasText: WORKSHOP_ANSWER })).toHaveCount(2)
          const lastVersion = () =>
            asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
              Effect.gen(function* () {
                const chat = yield* api.GetChat({ chatId: workshopId })
                const path = yield* api.ReadPath({
                  chatId: workshopId,
                  leafSlotId: chat.activeLeafSlotId,
                  range: { _tag: "Bottom" },
                  limit: 100
                })
                return path.entries.at(-1)!.version
              })
            )
          const secondVersion = (await lastVersion()).id
          await page.goto(`${server().url}/chats/${workshopId}/context/${secondVersion}`)
          await expect(
            page.getByText("The previous run was resumed or edited, so this request was put together again.")
          ).toBeVisible()
          await page.goto(`${server().url}/chats/${workshopId}`)
          const beforeCarry = provider.bodies.length
          await page.getByLabel("Message", { exact: true }).fill("Keep going from this turn.")
          await page.getByRole("button", { name: /^Send( as .+)?$/ }).click()
          await expect.poll(() => provider.bodies.length).toBeGreaterThan(beforeCarry)
          // Older messages can leave the phone's virtualized DOM as this reply grows.
          await expect
            .poll(async () => {
              const version = await lastVersion()
              return (
                version.id !== secondVersion && version.content === WORKSHOP_ANSWER && version.status === "complete"
              )
            })
            .toBe(true)
          const thirdVersion = (await lastVersion()).id
          await page.goto(`${server().url}/chats/${workshopId}/context/${thirdVersion}`)
          await expect(page.getByRole("link", { name: "Carried on from the previous turn’s run" })).toBeVisible()
          await expectLayout(page, info, `workshop-carried-request-${width}-${theme}`)
          await page.goto(`${server().url}/chats/${workshopId}`)

          // Keep the base branch's step-edit coverage after checking ordinary continuity.
          const cardMessage = page.getByRole("article").filter({ hasText: WORKSHOP_SECOND }).last()
          if (!(await cardMessage.getByRole("link", { name: "Open the run" }).isVisible()))
            await cardMessage.locator("[data-steps-badge]").click()
          await cardMessage.getByRole("link", { name: "Open the run" }).click()
          const result = page.getByRole("region", { name: "Result of read_card", exact: true }).first()
          await result.getByRole("button", { name: "Edit", exact: true }).click()
          const edited = "Synthetic edited card result."
          await result.locator('.cm-content[aria-label="Edit Result of read_card"]').fill(edited)
          await expectLayout(page, info, `workshop-step-edit-${width}-${theme}`, { scope: '[aria-label="Steps"]' })
          const beforeEditEffects = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
            api.ListRolloutEffects({ chatId: workshopId })
          )
          const beforeEdit = provider.bodies.length
          await result.getByRole("button", { name: "Resume", exact: true }).click()
          // The card it created still stands: carrying on from an earlier step warns first.
          const warning = page.getByRole("dialog", { name: "This reply changed things outside the chat" })
          await expect(warning).toContainText("Created the card Mara Quill")
          await warning.getByRole("button", { name: "Keep them and make a new version", exact: true }).click()
          await expect(page).toHaveURL(new RegExp(`/chats/${workshopId}\\?`))
          await expect.poll(() => provider.bodies.length).toBeGreaterThan(beforeEdit)
          await expect(page.getByRole("article").filter({ hasText: WORKSHOP_ANSWER }).last()).toBeVisible()
          expect(provider.bodies[beforeEdit]!.messages.at(-1)?.content).toBe(edited)
          expect(provider.bodies[beforeEdit]!.tools).toEqual(provider.bodies[offeredAt]!.tools)
          // The earlier answer can remain visible while the resumed run is still making its
          // change. Wait for that committed effect before asserting its receipt.
          await expect
            .poll(
              async () =>
                (
                  await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
                    api.ListRolloutEffects({ chatId: workshopId })
                  )
                ).length
            )
            .toBe(beforeEditEffects.length + 1)
          const afterEdit = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
            api.ListRolloutEffects({ chatId: workshopId })
          )
          expect(afterEdit).toHaveLength(beforeEditEffects.length + 1)
          for (const original of beforeEditEffects)
            expect(afterEdit.find((effect) => effect.rolloutId === original.rolloutId)).toEqual(original)

          // This chat leaves out the story's settings; the URL alone brings the workshop back.
          const settings = await openPanel(page, "This chat")
          await expect(settings.locator('[data-kind-badge="workshop"]')).toBeVisible()
          if (width === 390)
            await expect(page.getByRole("dialog", { name: `Workshop · ${title}`, exact: true })).toBeVisible()
          await expect(settings.getByRole("switch", { name: "Tools", exact: true })).toHaveCount(0)
          await expect(settings.getByRole("region", { name: "Summaries" })).toHaveCount(0)
          await expect(settings.getByRole("region", { name: "Who replies" })).toHaveCount(0)
          await expect(settings.getByRole("switch", { name: "Card swap", exact: true })).toBeVisible()
          await shot("this-chat")
          await expectLayout(page, info, `workshop-this-chat-${width}-${theme}`, {
            scope: width === 390 ? '[role="dialog"]' : 'aside[aria-label="Chat panel"]'
          })
          await page.goto(`${server().url}/chats/${workshopId}`)
          await expect(page.locator('[data-chat-kind="workshop"]').first()).toBeVisible()
          await expect(page.getByRole("article").filter({ hasText: WORKSHOP_ANSWER }).last()).toBeVisible()
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
          await closePanel(page)
          await page.getByLabel("Message", { exact: true }).fill("What happens by the harbor?")
          await page.getByRole("button", { name: /^Send( as .+)?$/ }).click()
          await expect(page.getByRole("article").filter({ hasText: STORY_REPLY })).toBeVisible()

          // A deleted workshop keeps its marker in the bin and restores with its kind intact.
          await asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.DeleteChat({ chatId: workshopId }))
          await page.goto(`${server().url}/bin`)
          const binned = page.getByRole("listitem", { name: title, exact: true })
          await expect(binned.locator('[data-kind-badge="workshop"]')).toBeVisible()
          await expectLayout(page, info, `workshop-bin-${width}-${theme}`, { scope: `li[aria-label="${title}"]` })
          await binned.getByRole("button", { name: "Restore", exact: true }).click()
          await page.goto(`${server().url}/chats/${workshopId}`)
          await expect(main.locator('[data-kind-badge="workshop"]').first()).toBeVisible()
        })
  })
}

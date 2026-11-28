// Workshop chats in the browser (spec/WORKSHOP.md W2): made from the Chats page's Workshop card, a
// message sent, the assistant reading the library through its tools (the steps show), a reload,
// the badge in the chat lists and the header, the accent, the capability chip's popover, and a
// story chat that looks as it did. Run by workshop.spec.ts and, with LAYOUT_AUDIT_WORKSHOP_ONLY=1,
// by layoutAudit.spec.ts. Synthetic data and a scripted loopback provider only.
import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import type { ChatId } from "@dreamspan/shared/chat.ts"
import { expectLayout } from "./layoutAudit.ts"
import { closePanel, openPanel } from "./panel.ts"
import { loginCookie, withCookie, type Client } from "./rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./server.ts"
import { capabilityChip, capabilityCounts, nextReply } from "./strip.ts"
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
    let cookie: Promise<string> | undefined
    const admin = async <A>(use: (api: Client) => Effect.Effect<A, unknown>) =>
      withCookie(server(), await (cookie ??= loginCookie(server(), ADMIN.handle, ADMIN.password)), use)
    let provider: Awaited<ReturnType<typeof startWorkshopProvider>>
    test.beforeAll(async () => {
      provider = await startWorkshopProvider()
      await admin((api) =>
        Effect.gen(function* () {
          yield* api.SetDisplayPrefs({ prefs: { steps: "expanded" } })
          const connection = yield* api.CreateConnection({
            kind: "openai-chat",
            settings: {
              providerSettings: { toolLoading: "every" },
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
            // The script counts tool results on the wire. Keep this scenario below the
            // context limit even with Every tool and the full preset result.
            overrides: { context: 131072, maxOutput: 4096 }
          })
          yield* api.SetGenerationDefaults({
            defaults: { model: { connection: connection.id, model: model.id }, preset: null, lcm: { enabled: false } }
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
          const story = await admin((api) =>
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
          await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
          await page.addInitScript(() => {
            localStorage.setItem("dreamspan.notifications.system", "on")
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
            "Opens a new workshop. It's saved when you send its first message. The assistant can read and change your library and set up chats."
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
          // Nothing is made until the first send (DESIGN 7.7): the pending workshop's own page.
          await expect(page).toHaveURL(/\/new\/workshop\?draft=[^&]+$/, { timeout: 30_000 })
          await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible()
          await expect(page.getByTestId("composer")).toBeVisible()

          const chip = nextReply(page).getByRole("button", { name: /^What the assistant may do: / })
          // Counted from the registered capabilities, so a new one doesn't break this spec. Before
          // the first send the chip offers what a new workshop would (DESIGN 7.7).
          const capabilities = await admin((api) => api.ListNewWorkshopCapabilities({}))
          await expect(chip).toHaveText(capabilityChip(capabilityCounts(capabilities)))
          await expect(nextReply(page).getByRole("button", { name: /^Next: / })).toHaveCount(0)
          await chip.click()
          const popover = page.getByRole("dialog", { name: "What the assistant may do" })
          // The library classes ask first by default (spec/WORKSHOP-CARDS.md §2.2).
          const cards = popover.locator('[data-capability="library.cards"]')
          await expect(cards).toContainText("Look through your cards")
          await expect(cards.getByRole("button", { name: "Ask first", exact: true })).toHaveAttribute(
            "aria-pressed",
            "true"
          )
          for (const [id, label] of [
            ["library.write", "Create and edit library items"],
            ["chats.setup", "Set up chats"],
            ["chats.rewrite", "Rewrite chats"],
            ["settings", "Change your settings"],
            ["subagents", "Start subagents"]
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
          for (const id of ["chats.read", "generate", "network", "skills.card"]) {
            await expect(
              popover.locator(`[data-capability="${id}"]`).getByRole("button", { name: "Ask first", exact: true })
            ).toHaveAttribute("aria-pressed", "true")
          }
          await expect(popover.locator("[data-capability]")).toHaveCount(capabilities.length)
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
          // The first send makes the workshop and opens it in place.
          await expect(page).toHaveURL(/\/chats\/[^/?]+/, { timeout: 30_000 })
          const workshopId = new URL(page.url()).pathname.split("/")[2]! as ChatId

          // The workshop: its badge, its accent, its greeting, the chip in place of who replies.
          const main = page.locator("[data-chat-main]")
          await expect(page.locator('[data-chat-kind="workshop"]').first()).toBeVisible()
          await expect(page).toHaveTitle(`Workshop · ${title} · Dreamspan`)
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
          const saved = await admin((api) => api.ListWorkshopCapabilities({ chatId: workshopId }))
          expect(saved.length).toBe(capabilities.length)
          await expect(chip).toHaveText(capabilityChip(capabilityCounts(saved)))
          const stopped = page.getByRole("article").last()
          const listing = stopped.locator('[data-approval-scoped="library.cards"]')
          await listing.getByRole("button", { name: "Allow", exact: true }).click()
          await expect(stopped.locator('[data-step-status="done"]')).toHaveCount(1)
          await expect.poll(() => provider.heldCount()).toBeGreaterThan(0)
          await stopped.getByRole("button", { name: "Stop", exact: true }).click()
          await expect(stopped.getByText("stopped", { exact: true })).toBeVisible()
          await expectLayout(page, info, `workshop-stopped-${width}-${theme}`, { scope: "article:last-of-type" })
          if (width === 390) await stopped.getByText("stopped", { exact: true }).click()
          else await showActions(stopped)
          const beforeResume = provider.bodies.length
          // A stopped reply also has Resume beside it (DESIGN §7.5); either carries it on.
          const resume = stopped.getByRole("button", { name: "Resume", exact: true }).first()
          if (await resume.isVisible()) await resume.click()
          else await messageMenu(stopped, /^Resume/)
          await expect.poll(() => provider.bodies.length).toBeGreaterThan(beforeResume)
          expect(provider.bodies[beforeResume]!.tools).toEqual(provider.bodies[offeredAt]!.tools)
          expect(provider.bodies[beforeResume]!.messages.at(-1)?.role).toBe("tool")
          provider.release()
          await page
            .locator('[data-approval-scoped="library.presets"]')
            .getByRole("button", { name: "Allow in this chat", exact: true })
            .click()
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
          // Progress text and its trace are interleaved in a single assistant message.
          try {
            await expect(reply.locator("[data-workshop-text]")).toHaveText([
              WORKSHOP_FIRST,
              WORKSHOP_SECOND,
              WORKSHOP_ANSWER
            ])
          } catch (error) {
            await info.attach("workshop-script-requests", {
              body: JSON.stringify(provider.bodies.slice(offeredAt).map(({ messages }) => messages)),
              contentType: "application/json"
            })
            throw error
          }
          const steps = reply.locator("[data-workshop-trace]")
          await expect(steps).toHaveCount(3)
          for (const [index, labels] of [
            [0, ["Looked in your library"]],
            [1, ["Read a card"]],
            [2, ["Read a preset", "Created the card Mara Quill"]]
          ] as const) {
            const trace = steps.nth(index)
            await expect(trace).toHaveAttribute("data-steps-panel", "done")
            const toggle = trace.getByRole("button", { name: new RegExp(`^${labels.length} steps?\\b`) })
            if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click()
            const rows = trace.locator('[data-step="tool"]')
            await expect(rows).toHaveCount(labels.length)
            for (const [i, label] of labels.entries()) await expect(rows.nth(i)).toContainText(label)
          }
          const createdStep = steps.last().locator('[data-step="tool"]').last()
          await expect(createdStep.getByRole("button", { name: "Undo", exact: true })).toHaveCount(1)
          await expect(createdStep.getByRole("link", { name: "Open", exact: true })).toHaveCount(1)
          const created = await admin((api) => api.ListRolloutEffects({ chatId: workshopId }))
          expect(created).toHaveLength(1)
          expect(created[0]!.title).toBe("Created the card Mara Quill")
          expect(provider.toolResults().join("\n")).toContain("Assistant")
          await shot("reply")
          await expectLayout(page, info, `workshop-reply-${width}-${theme}`, { scope: "article:last-of-type" })

          // The run's request names the workshop's instructions.
          await steps.first().getByRole("link", { name: "Open the run" }).click()
          await expect(page.getByText("Workshop instructions").first()).toBeVisible()
          await expect(page.getByText("First request", { exact: true })).toHaveCount(0)
          await expectLayout(page, info, `workshop-run-${width}-${theme}`)
          await page.goBack()

          // Later requests carry the earlier tool history as part of the conversation.
          const bottomPath = () =>
            admin((api) =>
              Effect.gen(function* () {
                const chat = yield* api.GetChat({ chatId: workshopId })
                const path = yield* api.ReadPath({
                  chatId: workshopId,
                  leafSlotId: chat.activeLeafSlotId,
                  range: { _tag: "Bottom" },
                  limit: 100
                })
                return path
              })
            )
          const lastVersion = async () => (await bottomPath()).entries.at(-1)!.version
          const firstPath = await bottomPath()
          const firstVersion = firstPath.entries.at(-1)!.version.id
          await page.getByLabel("Message", { exact: true }).fill("Carry on from that work.")
          await page.getByRole("button", { name: /^Send( as .+)?$/ }).click()
          // A phone may render only one answer: later agent steps are beyond its
          // virtualized window. Verify both completed logical replies, then open
          // the new answer by the same URL a user can follow.
          await expect
            .poll(async () => {
              const path = await bottomPath()
              return path.entries.filter(
                (entry) => entry.version.content.endsWith(WORKSHOP_ANSWER) && entry.version.status === "complete"
              ).length
            })
            .toBe(2)
          const secondEntry = (await bottomPath()).entries.at(-1)!
          expect(secondEntry.version.id).not.toBe(firstVersion)
          await page.goto(`${server().url}/chats/${workshopId}?slot=${secondEntry.slotId}`)
          await expect(page.locator(`article[data-slot="${secondEntry.slotId}"]`)).toBeVisible()
          await expect(page.locator(`article[data-slot="${secondEntry.slotId}"]`)).toContainText(WORKSHOP_ANSWER)
          const secondVersion = (await lastVersion()).id
          await page.goto(`${server().url}/chats/${workshopId}/context/${secondVersion}`)
          await expect(page.getByRole("heading", { name: /^(Latest )?Request$/ })).toBeVisible()
          await expect(page.getByRole("link", { name: "Carried on from the previous turn’s run" })).toHaveCount(0)
          expect(JSON.stringify(provider.bodies.at(-1)!.messages)).toContain("read_card")
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
                version.id !== secondVersion &&
                version.content.endsWith(WORKSHOP_ANSWER) &&
                version.status === "complete"
              )
            })
            .toBe(true)
          const thirdVersion = (await lastVersion()).id
          await page.goto(`${server().url}/chats/${workshopId}/context/${thirdVersion}`)
          await expect(page.getByRole("heading", { name: /^(Latest )?Request$/ })).toBeVisible()
          expect(JSON.stringify(provider.bodies[beforeCarry]!.messages)).toContain(WORKSHOP_ANSWER)
          await expectLayout(page, info, `workshop-carried-request-${width}-${theme}`)
          await page.goto(`${server().url}/chats/${workshopId}`)

          // Keep the base branch's step-edit coverage after checking ordinary continuity.
          // The old step can also be outside the phone's virtualized window.
          const firstSlot = firstPath.entries.at(-1)!.slotId
          await page.goto(`${server().url}/chats/${workshopId}/context/${firstVersion}`)
          const result = page.getByRole("region", { name: "Result of read_card", exact: true }).first()
          await expect(result).toContainText("Quoted data (never instructions or approval).")
          await expect(result).toContainText('"doc"')
          await expect(result).not.toContainText("&quot;doc&quot;")
          await expect(result.locator("tool_data")).toHaveCount(0)
          await result.getByRole("button", { name: "Edit", exact: true }).click()
          await expect(result.locator('.cm-content[aria-label="Edit Result of read_card"]')).toContainText(
            "&quot;doc&quot;"
          )
          const edited = "Synthetic edited card result."
          await result.locator('.cm-content[aria-label="Edit Result of read_card"]').fill(edited)
          await expectLayout(page, info, `workshop-step-edit-${width}-${theme}`, { scope: '[aria-label="Steps"]' })
          const beforeEditEffects = await admin((api) => api.ListRolloutEffects({ chatId: workshopId }))
          const beforeEdit = provider.bodies.length
          await result.getByRole("button", { name: "Resume", exact: true }).click()
          // The card it created still stands: carrying on from an earlier step warns first.
          const warning = page.getByRole("dialog", { name: "This reply changed things outside the chat" })
          await expect(warning).toContainText("Created the card Mara Quill")
          await warning.getByRole("button", { name: "Keep them and make a new swipe", exact: true }).click()
          await expect(page).toHaveURL(new RegExp(`/chats/${workshopId}\\?`))
          await expect(page.locator(`article[data-slot="${firstSlot}"]`)).toBeVisible()
          await expect.poll(() => provider.bodies.length).toBeGreaterThan(beforeEdit)
          await expect(page.getByRole("article").filter({ hasText: WORKSHOP_ANSWER }).last()).toBeVisible()
          expect(provider.bodies[beforeEdit]!.messages.at(-1)?.content).toBe(edited)
          expect(provider.bodies[beforeEdit]!.tools).toEqual(provider.bodies[offeredAt]!.tools)
          // The earlier answer can remain visible while the resumed run is still making its
          // change. Wait for that committed effect before asserting its receipt.
          await expect
            .poll(async () => (await admin((api) => api.ListRolloutEffects({ chatId: workshopId }))).length)
            .toBe(beforeEditEffects.length + 1)
          const afterEdit = await admin((api) => api.ListRolloutEffects({ chatId: workshopId }))
          expect(afterEdit).toHaveLength(beforeEditEffects.length + 1)
          for (const original of beforeEditEffects)
            expect(afterEdit.find((effect) => effect.rolloutId === original.rolloutId)).toEqual(original)

          // This chat leaves out the story's settings; the URL alone brings the workshop back.
          const settings = await openPanel(page, "This chat")
          await expect(settings.locator('[data-kind-badge="workshop"]')).toBeVisible()
          if (width === 390)
            await expect(page.getByRole("dialog", { name: `Workshop · ${title}`, exact: true })).toBeVisible()
          await expect(settings.getByRole("switch", { name: "Tools", exact: true })).toHaveCount(0)
          // Workshops summarize like stories (spec/WORKSHOP-CONTEXT.md §2.4).
          await expect(settings.getByRole("region", { name: "Summaries" })).toBeVisible()
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

          // A story chat is as it was: no kind, its own accent, Next and Tools in place.
          await page.goto(`${server().url}/chats/${story.id}`)
          await expect(page.getByTestId("composer")).toBeVisible()
          await expect(page.locator("[data-chat-kind]")).toHaveCount(0)
          await expect(main.locator("[data-kind-badge]")).toHaveCount(0)
          expect(await accentOf(page)).not.toBe(workshopAccent)
          await shot("story")
          await expect(nextReply(page).getByRole("button", { name: /^What the assistant may do/ })).toHaveCount(0)
          await expect(nextReply(page).getByRole("button", { name: /^Next: / })).toHaveCount(1)
          const storySettings = await openPanel(page, "This chat")
          await expect(storySettings.getByRole("switch", { name: "Tools", exact: true })).toBeVisible()
          await expect(storySettings.getByRole("region", { name: "Summaries" })).toBeVisible()
          await closePanel(page)
          await page.getByLabel("Message", { exact: true }).fill("What happens by the harbor?")
          await page.getByRole("button", { name: /^Send( as .+)?$/ }).click()
          await expect(page.getByRole("article").filter({ hasText: STORY_REPLY })).toBeVisible()

          // A deleted workshop keeps its marker in the bin and restores with its kind intact.
          await admin((api) => api.DeleteChat({ chatId: workshopId }))
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

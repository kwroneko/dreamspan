// Workshop permissions, approvals and undo in the browser (spec/WORKSHOP.md W4): the chip's Off /
// Ask first / Allowed choices, a call that asks first (what it will do, from its real arguments),
// a reload while it waits, Allow and Allow in this workshop, the regenerate warning (Cancel, then
// Undo them), Undo from a step and from the Changes tab, an undo refused after an edit by hand, and
// Off taking the tool out of the request. Run by workshopApprovals.spec.ts and, with
// LAYOUT_AUDIT_WORKSHOP_ONLY=1, by layoutAudit.spec.ts. Synthetic data and a scripted loopback
// provider only.
import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, type Locator, test } from "@playwright/test"
import { Effect } from "effect"
import type { RefId } from "@dreamspan/shared/library.ts"
import { textField } from "@dreamspan/shared/editing.ts"
import { expectLayout } from "./layoutAudit.ts"
import { openPanel } from "./panel.ts"
import { asUser, type Client } from "./rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./server.ts"
import { showActions } from "./message.ts"
import { capabilityChip, capabilityCounts, nextReply } from "./strip.ts"
import { startWorkshopProvider, WORKSHOP_ANSWER, WORKSHOP_FIRST } from "./workshopProvider.ts"

const shots = process.env.SCREENSHOT_DIR
const CREATED = "Created the card Mara Quill"
const DESCRIPTION =
  "A synthetic lighthouse keeper. " + "x".repeat(4100) + " <script>hostile_tail()</script> FULL_ARGUMENT_END"

export function workshopApprovalTests() {
  test.describe("workshop approvals", () => {
    const server = serverPerFile(withAdmin)
    let provider: Awaited<ReturnType<typeof startWorkshopProvider>>
    const admin = <A>(use: (client: Client) => Effect.Effect<A, unknown>) =>
      asUser(server(), ADMIN.handle, ADMIN.password, use)
    test.beforeAll(async () => {
      // Each task: a first message, then the card made in the answer (two messages of one run).
      provider = await startWorkshopProvider({
        perTask: true,
        calls: [
          { name: "send_message", arguments: { message: WORKSHOP_FIRST } },
          { name: "create_card", arguments: { name: "Mara Quill", description: DESCRIPTION } }
        ]
      })
      await admin((api) =>
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
        test(`asked, answered and undone at ${width} ${theme}`, async ({ page }, info) => {
          test.setTimeout(240_000)
          const workshop = await admin((api) => api.CreateWorkshop({ title: `Approvals ${width} ${theme}` }))
          await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
          await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
          await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
          await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
          const shot = async (name: string) => {
            if (shots) {
              mkdirSync(shots, { recursive: true })
              await page.waitForTimeout(200)
              await page.screenshot({ path: resolve(shots, `workshop-approvals-${name}-${width}-${theme}.png`) })
            }
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
          }
          const effects = () => admin((api) => api.ListRolloutEffects({ chatId: workshop.id }))
          const chip = nextReply(page).getByRole("button", { name: /^What the assistant may do: / })
          const choose = async (capability: string, mode: "Off" | "Ask first" | "Allowed", chipText: RegExp) => {
            await chip.click()
            const popover = page.getByRole("dialog", { name: "What the assistant may do" })
            const row = popover.locator(`[data-capability="${capability}"]`)
            await row.getByRole("button", { name: mode, exact: true }).click()
            await expect(row.getByRole("button", { name: mode, exact: true })).toHaveAttribute("aria-pressed", "true")
            await expect(chip).toHaveText(chipText)
            return popover
          }
          const send = async (text: string) => {
            await page.getByLabel("Message", { exact: true }).fill(text)
            await page.getByRole("button", { name: /^Send( as .+)?$/ }).click()
          }
          const asking = (reply: Locator) => reply.locator("[data-approval]")
          // A finished reply's steps are folded; its header badge opens them.
          const openSteps = async (reply: Locator) => {
            const badge = reply.locator("[data-steps-badge]")
            if ((await badge.getAttribute("aria-pressed")) !== "true") await badge.click()
            await expect(reply.locator('[data-step="tool"]').first()).toBeVisible()
          }

          await page.goto(`${server().url}/chats/${workshop.id}`)
          await expect(page.getByTestId("composer")).toBeVisible()
          // The defaults, counted from the registered capabilities; library.write is allowed by default.
          const base = capabilityCounts(await admin((api) => api.ListWorkshopCapabilities({ chatId: workshop.id })))
          expect(base.off).toBe(0)
          const initial = capabilityChip(base)
          const askFirst = capabilityChip({ can: base.can - 1, asks: base.asks + 1 })
          await expect(chip).toHaveText(initial)

          // Ask first: chosen in the chip, it says so there.
          const popover = await choose("library.write", "Ask first", askFirst)
          await expect(
            popover.locator('[data-capability="library.write"]').getByRole("button", { name: "Use the default" })
          ).toBeVisible()
          await shot("chip")
          await expectLayout(page, info, `workshop-approvals-chip-${width}-${theme}`, { scope: '[role="dialog"]' })
          await page.keyboard.press("Escape")

          // The call waits, saying what it will do from its real arguments; no request is held open.
          await send("Make me a lighthouse keeper.")
          const first = page.getByRole("article").last()
          const asked = asking(first)
          await expect(asked).toBeVisible({ timeout: 30_000 })
          await expect(asked).toContainText("Create the card “Mara Quill”")
          await expect(asked).toContainText("Asks first: Create and edit library items")
          await expect(asked).toContainText("A synthetic lighthouse keeper.")
          await expect(asked.locator("summary")).toContainText("cut short; show all")
          await expect(asked.getByText(DESCRIPTION, { exact: true })).toBeHidden()
          await asked.locator("summary").click()
          await expect(asked.getByText(DESCRIPTION, { exact: true })).toBeVisible()
          await expect(asked.locator("script")).toHaveCount(0)
          await asked.locator("summary").click()
          await expect(first.locator('[data-step-status="waiting"]')).toHaveCount(1)
          await expect(first.locator("[data-steps-badge]")).toHaveText("Waiting for you")
          await expect(asked.getByRole("button", { name: "Allow", exact: true })).toHaveAccessibleDescription(
            "Lets the assistant do this once."
          )
          const requests = provider.bodies.length
          await shot("asking")
          await expectLayout(page, info, `workshop-approvals-asking-${width}-${theme}`, {
            scope: "article:last-of-type"
          })

          // A reload while it waits shows the same question.
          await page.reload()
          const reloaded = asking(page.getByRole("article").last())
          await expect(reloaded).toContainText("Create the card “Mara Quill”")
          expect(provider.bodies.length).toBe(requests)

          // Allow: this once. The reply finishes; the change has Undo and Open under its step.
          await reloaded.getByRole("button", { name: "Allow", exact: true }).click()
          const done = page.getByRole("article").filter({ hasText: WORKSHOP_ANSWER })
          await expect(done).toHaveCount(1, { timeout: 30_000 })
          await expect(chip).toHaveText(askFirst)
          expect(await effects()).toHaveLength(1)

          // The next one asks again; Allow in this workshop also allows it from now on.
          await send("Make another one.")
          const second = page.getByRole("article").last()
          await expect(asking(second)).toBeVisible({ timeout: 30_000 })
          await asking(second).getByRole("button", { name: "Allow in this workshop", exact: true }).click()
          await expect(page.getByRole("article").filter({ hasText: WORKSHOP_ANSWER })).toHaveCount(2, {
            timeout: 30_000
          })
          await expect(chip).toHaveText(initial)
          expect(await effects()).toHaveLength(2)
          const latest = page.getByRole("article").last()
          await openSteps(latest)
          // The change is under the step of the message that made it (the answer), once.
          const created = latest.locator('[data-step="tool"]').nth(0)
          await expect(page.locator("[data-effect]")).toHaveCount(1)
          await expect(created.locator("[data-effect]")).toContainText(CREATED)
          await expect(created.getByRole("button", { name: "Undo", exact: true })).toBeVisible()
          await expect(created.getByRole("link", { name: "Open", exact: true })).toBeVisible()
          await shot("reply")
          await expectLayout(page, info, `workshop-approvals-reply-${width}-${theme}`, {
            scope: "article:last-of-type"
          })

          // A new version of the answer keeps its own call, so it doesn't warn. A new version of
          // the run's first message does: the answer's change after it stands, and may be made
          // again. Cancel leaves everything as it was.
          const opening = page.getByRole("article").filter({ hasText: WORKSHOP_FIRST }).last()
          const regenerate = async () => {
            await showActions(opening)
            await opening
              .getByRole("group", { name: "Swipes", exact: true })
              .getByRole("button", { name: "Generate another swipe", exact: true })
              .click()
          }
          const before = provider.bodies.length
          await regenerate()
          const warning = page.getByRole("dialog", { name: "This reply changed things outside the chat" })
          await expect(warning).toContainText(CREATED)
          await expect(warning).toContainText(
            "A new swipe keeps this reply’s own steps and changes and undoes none of these, but the assistant may make them again."
          )
          await shot("warning")
          await expectLayout(page, info, `workshop-approvals-warning-${width}-${theme}`, { scope: '[role="dialog"]' })
          await warning.getByRole("button", { name: "Cancel", exact: true }).click()
          await expect(warning).toHaveCount(0)
          expect(provider.bodies.length).toBe(before)

          // Undo them, then make a new version: the card is undone, and the run carries on from
          // the new first message without asking (allowed in this workshop now).
          await regenerate()
          await warning.getByRole("button", { name: "Undo them, then make a new swipe", exact: true }).click()
          await expect.poll(async () => (await effects()).filter((e) => e.undoneAt !== null).length).toBe(1)
          await expect.poll(async () => (await effects()).length, { timeout: 30_000 }).toBe(3)
          await expect(page.getByRole("article").last().getByText(WORKSHOP_ANSWER)).toBeVisible({ timeout: 30_000 })

          // An edit by hand to the first card: its undo is refused, with the reason and Open.
          const oldest = (await effects()).at(-1)!
          await admin((api) =>
            Effect.gen(function* () {
              const refId = oldest.undo!.refId as RefId
              const field = textField(["description"])
              const opened = yield* api.OpenEditor({ refId })
              const draft = yield* api.SaveEditorDraft({
                refId,
                field,
                content: "Edited by hand.",
                draftId: null,
                expectedRowVersion: null,
                expectedSession: null,
                baseRevisionId: opened.ref.headRevisionId
              })
              yield* api.CommitEditorDrafts({
                refId,
                expectedRowVersion: opened.ref.rowVersion,
                fields: [{ field, draftId: draft.id, expectedRowVersion: draft.rowVersion }],
                message: null
              })
            })
          )
          const changes = await openPanel(page, "Changes")
          const rows = changes.locator("[data-effect]")
          await expect(rows).toHaveCount(3)
          await expect(rows.nth(1)).toContainText("Undone")
          const refused = rows.nth(2)
          await refused.getByRole("button", { name: "Undo", exact: true }).click()
          await expect(refused.getByRole("alert")).toContainText(
            "Changed since; open its history before undoing this change."
          )
          await expect(refused.getByRole("link", { name: "Open", exact: true })).toHaveAttribute(
            "href",
            `/library/${oldest.undo!.refId as string}`
          )
          // The newest from the Changes tab: it's undone, and its step row says so too.
          await rows.nth(0).getByRole("button", { name: "Undo", exact: true }).click()
          await expect(rows.nth(0)).toContainText("Undone")
          await shot("changes")
          await expectLayout(page, info, `workshop-approvals-changes-${width}-${theme}`, {
            scope: width === 390 ? '[role="dialog"]' : 'aside[aria-label="Chat panel"]'
          })
          await page.goto(`${server().url}/chats/${workshop.id}`)
          await openSteps(page.getByRole("article").last())
          await expect(page.getByRole("article").last().locator("[data-effect]").first()).toContainText("Undone")

          // Off: the tool isn't in the next request at all, and nothing more is made.
          const off = await choose(
            "library.write",
            "Off",
            capabilityChip({ can: base.can - 1, asks: base.asks, off: 1 })
          )
          await page.keyboard.press("Escape")
          await expect(off).toHaveCount(0)
          const offAt = provider.bodies.length
          await send("One more, please.")
          await expect.poll(() => provider.bodies.length, { timeout: 30_000 }).toBeGreaterThan(offAt)
          const offered = provider.bodies[offAt]!.tools?.map((tool) => tool.function.name) ?? []
          expect(offered).toContain("list_library")
          expect(offered).not.toContain("create_card")
          // The run finishes (earlier messages may have scrolled out of the rendered list).
          await expect(page.getByRole("article").last().getByText(WORKSHOP_ANSWER)).toBeVisible({ timeout: 30_000 })
          await expect(page.getByRole("article").last().locator('[data-step-status="waiting"]')).toHaveCount(0)
          expect(await effects()).toHaveLength(3)
        })
  })
}

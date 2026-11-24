// The workshop's Changes tab grouped by reply (spec/WORKSHOP.md §3.6) in the browser: two replies
// that each made several changes show as two groups, newest first; "Revert all of this reply" takes
// one reply's changes back newest first, and stops at one changed by hand, saying which it left
// and why; single Undo still works. Run by workshopChanges.spec.ts and, with
// LAYOUT_AUDIT_WORKSHOP_ONLY=1, by layoutAudit.spec.ts. Synthetic data and a scripted loopback
// provider only.
import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import type { RefId } from "@dreamspan/shared/library.ts"
import { textField } from "@dreamspan/shared/editing.ts"
import { expectLayout } from "./layoutAudit.ts"
import { openPanel } from "./panel.ts"
import { asUser, type Client } from "./rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./server.ts"
import { startWorkshopProvider, WORKSHOP_ANSWER } from "./workshopProvider.ts"

const shots = process.env.SCREENSHOT_DIR

export function workshopChangesTests() {
  test.describe("workshop changes by reply", () => {
    const server = serverPerFile(withAdmin)
    let provider: Awaited<ReturnType<typeof startWorkshopProvider>>
    const admin = <A>(use: (client: Client) => Effect.Effect<A, unknown>) =>
      asUser(server(), ADMIN.handle, ADMIN.password, use)
    test.beforeAll(async () => {
      // Each task makes two cards: one reply, two changes.
      provider = await startWorkshopProvider({
        perTask: true,
        calls: [
          { name: "create_card", arguments: { name: "Keeper A", description: "A synthetic keeper." } },
          { name: "create_card", arguments: { name: "Keeper B", description: "Another synthetic keeper." } }
        ]
      })
      await admin((api) =>
        Effect.gen(function* () {
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
        test(`grouped by reply and undone together at ${width} ${theme}`, async ({ page }, info) => {
          test.setTimeout(180_000)
          const workshop = await admin((api) => api.CreateWorkshop({ title: `Changes ${width} ${theme}` }))
          await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
          await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
          await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
          await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
          const shot = async (name: string) => {
            if (shots) {
              mkdirSync(shots, { recursive: true })
              await page.waitForTimeout(200)
              await page.screenshot({ path: resolve(shots, `workshop-changes-${name}-${width}-${theme}.png`) })
            }
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
          }
          const effects = () => admin((api) => api.ListRolloutEffects({ chatId: workshop.id }))
          const send = async (text: string, replies: number) => {
            await page.getByLabel("Message", { exact: true }).fill(text)
            await page.getByRole("button", { name: /^Send( as .+)?$/ }).click()
            await expect(page.getByRole("article").filter({ hasText: WORKSHOP_ANSWER })).toHaveCount(replies, {
              timeout: 30_000
            })
          }
          await page.goto(`${server().url}/chats/${workshop.id}`)
          await expect(page.getByTestId("composer")).toBeVisible()
          await send("Make two keepers.", 1)
          await send("Two more, please.", 2)
          await expect.poll(async () => (await effects()).length).toBe(4)

          // An edit by hand to the newer reply's first card: undoing that reply stops there.
          const listed = await effects()
          const newerRollout = listed[0]!.rolloutId
          const handEdited = listed.filter((e) => e.rolloutId === newerRollout).at(-1)!
          await admin((api) =>
            Effect.gen(function* () {
              const refId = handEdited.undo!.refId as RefId
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
          const groups = changes.locator("[data-reply-changes]")
          await expect(groups).toHaveCount(2)
          await expect(groups.nth(0)).toHaveAttribute("data-reply-changes", newerRollout)
          await expect(groups.nth(0)).toContainText("2 changes")
          await expect(groups.nth(0).locator("[data-effect]")).toHaveCount(2)
          await expect(groups.nth(1).locator("[data-effect]")).toHaveCount(2)
          const undoAll = (n: number) =>
            groups.nth(n).getByRole("button", { name: "Revert all of this reply", exact: true })
          await expect(undoAll(0)).toHaveAccessibleDescription(
            "Takes back everything this reply changed, newest first: edits are reverted, keeping later edits, and new items go to the bin. It stops at a change that can’t be taken back."
          )
          await shot("grouped")
          await expectLayout(page, info, `workshop-changes-grouped-${width}-${theme}`, {
            scope: width === 390 ? '[role="dialog"]' : 'aside[aria-label="Chat panel"]'
          })

          // The older reply: both undone, newest first.
          await undoAll(1).click()
          await expect(groups.nth(1).locator("[data-undo-all-report]")).toHaveText("Took back 2 changes.")
          await expect(groups.nth(1).locator("[data-effect]").filter({ hasText: "Undone" })).toHaveCount(2)
          await expect(undoAll(1)).toHaveCount(0)

          // The newer reply: its newest change is undone, the hand-edited one is refused and why.
          await undoAll(0).click()
          const report = groups.nth(0).locator("[data-undo-all-report]")
          await expect(report).toContainText("Took back 1 change.")
          await expect(report).toContainText(`Not taken back: ${handEdited.title}.`)
          await expect(report).toContainText("Changed since")
          await shot("refused")
          await expectLayout(page, info, `workshop-changes-refused-${width}-${theme}`, {
            scope: width === 390 ? '[role="dialog"]' : 'aside[aria-label="Chat panel"]'
          })
          const after = await effects()
          expect(after.filter((e) => e.undoneAt !== null)).toHaveLength(3)
          expect(after.find((e) => e.toolCallId === handEdited.toolCallId)!.undoneAt).toBeNull()
          // Single Undo still asks before binning the edited card, and Cancel leaves it in place.
          const standing = groups.nth(0).locator(`[data-effect="${handEdited.rolloutId}:${handEdited.toolCallId}:0"]`)
          await standing.getByRole("button", { name: "Undo", exact: true }).click()
          const confirm = page.getByRole("alertdialog", { name: "Move it to the bin?" })
          await expect(confirm).toContainText("It was changed since")
          await confirm.getByRole("button", { name: "Cancel", exact: true }).click()
          expect((await effects()).find((e) => e.toolCallId === handEdited.toolCallId)!.undoneAt).toBeNull()
        })
  })
}

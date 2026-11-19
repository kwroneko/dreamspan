// One browser profile, with the editors and workshop open in separate tabs. Synthetic only.
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import type { PresetDoc } from "@dreamspan/shared/docs/preset.ts"
import { textField } from "@dreamspan/shared/editing.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./server.ts"
import { loginCookie, withCookie, type Client } from "./rpc.ts"
import { startWorkshopProvider, WORKSHOP_ANSWER } from "./workshopProvider.ts"
import { expectTextBox, replaceEditorText, textBoxValue } from "./textbox.ts"
import { saveButton, saveCluster } from "./saveRevision.ts"
import { expectLayout } from "./layoutAudit.ts"

export function workshopDocumentTests() {
  test.describe("workshop library drafts", () => {
    const server = serverPerFile(withAdmin)
    let cookie: Promise<string> | undefined
    const admin = async <A>(use: (api: Client) => Effect.Effect<A, unknown>) =>
      withCookie(server(), await (cookie ??= loginCookie(server(), ADMIN.handle, ADMIN.password)), use)
    for (const width of [1440, 390])
      for (const theme of ["light", "dark"] as const)
        test(`preset and lorebook drafts survive workshop edits at ${width} ${theme}`, async ({
          page,
          context
        }, info) => {
          test.setTimeout(180_000)
          await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
          await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
          await context.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
          await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
          const suffix = `${width} ${theme}`
          const preset = await admin((api) => api.CreatePreset({ label: `Draft preset ${suffix}` }))
          const book = await admin((api) => api.CreateLorebook({ label: `Draft book ${suffix}` }))
          const longPrompt = "Synthetic long prompt. ".repeat(240) + "Review the final instruction too."
          const lastReviewId = `last-review-${"x".repeat(180)}`
          const provider = await startWorkshopProvider({
            calls: [
              {
                name: "edit_preset",
                arguments: {
                  preset: preset.id,
                  changes: [
                    { prompt: "main", text: "Workshop saved prompt." },
                    { add: { identifier: "long-review", name: "Long review", content: longPrompt } },
                    {
                      add: { identifier: lastReviewId, name: "Last review", content: "A separate final instruction." }
                    }
                  ]
                }
              },
              {
                name: "edit_lorebook",
                arguments: {
                  lorebook: book.id,
                  changes: [
                    { settings: { description: "Workshop saved description." } },
                    { add: { uid: 1, comment: "Harbor", content: "The harbor lamp is blue." } }
                  ]
                }
              }
            ]
          })
          try {
            const workshop = await admin((api) =>
              Effect.gen(function* () {
                const connection = yield* api.CreateConnection({
                  kind: "openai-chat",
                  settings: {
                    name: `Synthetic ${suffix}`,
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
                  overrides: { context: 131072, settings: { samplers: { openai_max_context: 131072 } } }
                })
                yield* api.SetGenerationDefaults({
                  defaults: { model: { connection: connection.id, model: model.id }, preset: null }
                })
                const chat = yield* api.CreateWorkshop({ title: `Draft edits ${suffix}` })
                yield* api.SetWorkshopGrant({ chatId: chat.id, capability: "library.write", mode: "ask" })
                return chat
              })
            )
            const presetTab = await context.newPage()
            const bookTab = await context.newPage()
            for (const tab of [presetTab, bookTab]) {
              await tab.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
              await tab.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
            }
            await presetTab.goto(`${server().url}/library/${preset.id}`)
            const prompt = presetTab.getByRole("textbox", { name: "Prompt: Main Prompt", exact: true })
            await expect(prompt).toBeVisible()
            await replaceEditorText(prompt, "My unfinished prompt.")
            await bookTab.goto(`${server().url}/library/${book.id}`)
            await bookTab.getByText(/^Book settings/).click()
            const description = bookTab.getByRole("textbox", { name: /^Lorebook description/ })
            await replaceEditorText(description, "My unfinished book description.")
            for (const [ref, field, value] of [
              [preset, textField(["prompts", "identifier=main", "content"]), "My unfinished prompt."],
              [book, textField(["description"]), "My unfinished book description."]
            ] as const) {
              await expect
                .poll(
                  async () =>
                    (await admin((api) => api.OpenEditor({ refId: ref.id }))).drafts.find((d) => d.key.field === field)
                      ?.content
                )
                .toBe(value)
            }
            await page.goto(`${server().url}/chats/${workshop.id}`)
            await page.getByLabel("Message", { exact: true }).fill("Update my preset and lorebook.")
            await page.getByRole("button", { name: /^Send( as .+)?$/ }).click()
            for (const [kind, label, text] of [
              ["preset", preset.label, "Workshop saved prompt."],
              ["lorebook", book.label, "The harbor lamp is blue."]
            ] as const) {
              const approval = page.locator("[data-approval]")
              await expect(approval).toContainText(`Edit the ${kind} “${label}”`, { timeout: 30_000 })
              await expect(approval).toContainText(text)
              await expect(approval).toContainText("stays disabled or unapproved")
              if (kind === "preset") {
                await expect(approval.getByRole("definition").first()).toContainText("3 prompts")
                await expect(approval.locator(`[data-approval-change='prompts["${lastReviewId}"]']`)).toContainText(
                  "A separate final instruction."
                )
                const full = approval.locator("[data-approval-change='prompts[\"long-review\"]']")
                const summary = full.locator("summary")
                await expect(summary).toContainText("Full change")
                await expect(full.getByRole("textbox")).toHaveCount(0)
                await summary.click()
                await expect
                  .poll(() => textBoxValue(full.getByRole("textbox").last()))
                  .toContain("Review the final instruction too.")
                await expectLayout(page, info, `document-approval-expanded-${width}-${theme}`, {
                  scope: "[data-approval]"
                })
                await summary.click()
              }
              await approval.evaluate((element) => element.scrollIntoView({ block: "start" }))
              await expectLayout(page, info, `document-approval-${kind}-${width}-${theme}`, {
                scope: "[data-approval]"
              })
              await approval.getByRole("button", { name: "Allow", exact: true }).click()
            }
            await expect(page.getByRole("article").last()).toContainText(WORKSHOP_ANSWER, { timeout: 30_000 })
            const saved = await admin((api) => api.OpenEditor({ refId: preset.id }))
            expect((saved.doc as unknown as PresetDoc).prompts.find((p) => p.identifier === "main")!.content).toBe(
              "Workshop saved prompt."
            )
            expect((await admin((api) => api.OpenEditor({ refId: book.id }))).doc.description).toBe(
              "Workshop saved description."
            )
            for (const [tab, box, ref, mine, latest] of [
              [presetTab, prompt, preset, "My unfinished prompt.", "Workshop saved prompt."],
              [bookTab, description, book, "My unfinished book description.", "Workshop saved description."]
            ] as const) {
              await tab.bringToFront()
              await expectTextBox(box, mine)
              await expectLayout(tab, info, `document-draft-${ref.kind}-${width}-${theme}`, { scope: "main" })
              await saveButton(tab).click()
              const conflict = tab.getByRole("dialog", { name: "Changed meanwhile" })
              const failed = saveCluster(tab).and(tab.locator('[data-save-state="failed"]'))
              await expect(conflict.or(failed).first()).toBeVisible()
              if (!(await conflict.isVisible())) await saveButton(tab).click()
              await expect(conflict).toContainText("Saved version")
              await expect(conflict).toContainText(latest)
              await expectLayout(tab, info, `document-conflict-${ref.kind}-${width}-${theme}`, {
                scope: '[role="dialog"]'
              })
              await conflict.getByRole("button", { name: "Cancel", exact: true }).click()
              await expectTextBox(box, mine)
              expect(
                (await admin((api) => api.OpenEditor({ refId: ref.id }))).drafts.some((d) => d.content === mine)
              ).toBe(true)
            }
          } finally {
            await provider.stop()
          }
        })
  })
}

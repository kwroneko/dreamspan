import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { asUser } from "./rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./server.ts"
import { startWorkshopProvider } from "./workshopProvider.ts"
import { level1 } from "./summaries.ts"
import { expectLayout } from "./layoutAudit.ts"

export function workshopRewriteTests() {
  test.describe("workshop history provenance", () => {
    const server = serverPerFile(withAdmin)
    for (const width of [1440, 390])
      for (const theme of ["light", "dark"] as const)
        test(`rewrite approval and history link ${width} ${theme}`, async ({ page }, info) => {
          test.setTimeout(180000)
          const admin = <A>(run: (api: import("./rpc.ts").Client) => Effect.Effect<A, unknown>) =>
            asUser(server(), ADMIN.handle, ADMIN.password, run)
          const fixture = await admin((api) =>
            Effect.gen(function* () {
              const chat = yield* api.CreateChat({ title: `Rewrite story ${width} ${theme}` })
              const posted = yield* api.SendMessage({
                chatId: chat.id,
                parentSlotId: null,
                branch: false,
                content: "Aria meets the gardener."
              })
              if (posted._tag !== "Posted") throw new Error("queued")
              let parent = posted.entry.slotId
              for (let n = 2; n <= 40; n++) {
                const next = yield* api.SendMessage({
                  chatId: chat.id,
                  parentSlotId: parent,
                  branch: false,
                  content: `Aria meets gardener ${n}.`
                })
                if (next._tag !== "Posted") throw new Error("queued")
                parent = next.entry.slotId
              }
              return { chat, entry: posted.entry }
            })
          )
          await level1(server().dataDir, fixture.chat.id, [fixture.entry], "Aria recalls the garden.")
          const provider = await startWorkshopProvider({
            perTask: true,
            calls: [
              {
                name: "rewrite_chat",
                arguments: {
                  chat: fixture.chat.id,
                  title: "Rename the gardener",
                  pairs: [{ find: "Aria", replace: "Ari", in: ["messages", "summaries"] }]
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
                    name: "Synthetic rewriting",
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
                yield* api.SetDisplayPrefs({ prefs: { steps: "expanded" } })
                const workshop = yield* api.CreateWorkshop({ title: `Setup ${width} ${theme}` })
                yield* api.SetWorkshopGrant({ chatId: workshop.id, capability: "chats.rewrite", mode: "ask" })
                return workshop
              })
            )
            await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
            await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
            await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
            await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
            await page.goto(`${server().url}/chats/${workshop.id}`)
            await page.getByLabel("Message", { exact: true }).fill("Rename Aria in the story and its summaries.")
            await page.getByRole("button", { name: /^Send( as .+)?$/ }).click()
            const approval = page.locator("[data-approval]")
            await expect(approval).toContainText(`Rewrite “${fixture.chat.title}”`)
            await expect(approval).toContainText("40 messages, 1 summaries")
            await expect(approval).toContainText("At most 10,000 texts or bindings")
            await expect(approval.locator("[data-approval-change]")).toHaveCount(41)
            await expect(approval.locator(".cm-content")).toHaveCount(0)
            await approval.locator("[data-approval-change]").first().locator("summary").click()
            await expect(approval.locator("[data-approval-change]").first()).toContainText("Aria")
            await approval.locator("[data-approval-change]").nth(3).locator("summary").click()
            await expect(approval.locator("[data-approval-change]").nth(3)).toContainText("gardener 4")
            await expectLayout(page, info, `rewrite-approval-${width}-${theme}`)
            await approval.getByRole("button", { name: "Allow", exact: true }).click()
            await expect(approval).toHaveCount(0)
            await expect
              .poll(
                async () =>
                  (
                    await admin((api) =>
                      api.ListHistoryEdits({ chatId: fixture.chat.id, forkId: fixture.chat.currentForkId! })
                    )
                  ).length
              )
              .toBe(1)
            await page.goto(`${server().url}/chats/${fixture.chat.id}?panel=activity`)
            await expect(page.locator('[data-activity="edit"]')).toContainText("No model request")
            await expectLayout(page, info, `rewrite-activity-${width}-${theme}`)
            await page.goto(`${server().url}/chats/${fixture.chat.id}?panel=history`)
            const link = page.getByRole("link", { name: workshop.title, exact: true })
            await expect(link).toBeVisible()
            await expect(link.locator("..").locator("..")).toContainText("Made in the workshop")
            await expectLayout(page, info, `rewrite-history-${width}-${theme}`)
            await page.reload()
            await expect(link).toBeVisible()
            await link.click()
            await expect(page).toHaveURL(new RegExp(`/chats/${workshop.id}.*slot=`))
            await page.goto(`${server().url}/chats/${fixture.chat.id}?panel=history`)
            await page.getByRole("button", { name: "Undo all", exact: true }).click()
            await expect(page.getByRole("button", { name: "Undo all", exact: true })).toBeDisabled()
            await expectLayout(page, info, `rewrite-history-undone-${width}-${theme}`)
          } finally {
            await provider.stop()
          }
        })
  })
}

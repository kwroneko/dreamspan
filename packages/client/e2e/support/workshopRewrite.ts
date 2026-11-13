import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { asUser } from "./rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./server.ts"
import { startWorkshopProvider } from "./workshopProvider.ts"
import { level1 } from "./summaries.ts"
import { expectLayout } from "./layoutAudit.ts"
import { openPanel } from "./panel.ts"

export function workshopRewriteTests() {
  sideWriteTests()
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

/** Approval follows the answering tab too; two branch sentinels make redirection visible. */
function sideWriteTests() {
  test.describe("side workshop rewrite target", () => {
    const server = serverPerFile(withAdmin)
    for (const width of [1440, 390])
      for (const theme of ["light", "dark"] as const)
        test(`older branch approval and Undo ${width} ${theme}`, async ({ page }, info) => {
          test.setTimeout(180000)
          const admin = <A>(run: (api: import("./rpc.ts").Client) => Effect.Effect<A, unknown>) =>
            asUser(server(), ADMIN.handle, ADMIN.password, run)
          const fixture = await admin((api) =>
            Effect.gen(function* () {
              const chat = yield* api.CreateChat({ title: `Tab target ${width} ${theme}` })
              const sent = yield* api.SendMessage({
                chatId: chat.id,
                parentSlotId: null,
                branch: false,
                content: "OLDER sentinel"
              })
              if (sent._tag !== "Posted") throw new Error("queued")
              const original = sent.entry.forkId!
              const fork = yield* api.CreateFork({
                chatId: chat.id,
                fromForkId: original,
                atSlotId: sent.entry.slotId,
                name: "Newer branch"
              })
              const path = yield* api.ReadPath({
                chatId: chat.id,
                forkId: fork.fork.id,
                leafSlotId: null,
                range: { _tag: "Bottom" },
                limit: 10
              })
              const slot = path.entries[0]!
              yield* api.EditVersion({
                slotId: sent.entry.slotId,
                forkId: fork.fork.id,
                sourceVersionId: slot.version.id,
                expectedRowVersion: slot.rowVersion,
                content: "NEWER sentinel"
              })
              return { chat, original, newer: fork.fork.id }
            })
          )
          const provider = await startWorkshopProvider({
            perTask: true,
            calls: [
              {
                name: "rewrite_messages",
                arguments: {
                  chat: fixture.chat.id,
                  title: "Edit older branch",
                  messages: [{ message: 1, text: "CHANGED older sentinel" }]
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
                    name: "Synthetic tab writer",
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
                  overrides: { context: 65536 }
                })
                yield* api.SetGenerationDefaults({
                  defaults: { model: { connection: connection.id, model: model.id }, preset: null }
                })
                yield* api.SetDisplayPrefs({ prefs: { steps: "expanded" } })
                const side = yield* api.CreateWorkshop({ attachTo: fixture.chat.id })
                yield* api.SetWorkshopGrant({ chatId: side.id, capability: "chats.rewrite", mode: "ask" })
                return side
              })
            )
            await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
            await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
            await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
            await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
            const url = (fork: string) =>
              `${server().url}/chats/${fixture.chat.id}?fork=${fork}&panel=workshop&workshop=${workshop.id}`
            await page.goto(url(fixture.original))
            const side = page.locator(`[data-side-chat="${workshop.id}"]`)
            await side.getByLabel("Message", { exact: true }).fill("Change the first message here.")
            await side.getByRole("button", { name: /^Send( as .+)?$/ }).click()
            const approval = side.locator("[data-approval]")
            await expect(approval).toContainText(fixture.original)
            await expect(approval).toContainText("messages 1–1")
            await expect(approval).toContainText("OLDER sentinel")
            await expect(approval).not.toContainText("NEWER sentinel")
            await expectLayout(page, info, `side-write-approval-${width}-${theme}`, { scope: "[data-approval]" })
            await page.goto(url(fixture.newer))
            await expect(approval).toBeVisible()
            await approval.getByRole("button", { name: "Allow", exact: true }).click()
            await expect(approval).toContainText("The story tab moved")
            await page.goto(url(fixture.original))
            await expect(approval).toBeVisible()
            await approval.getByRole("button", { name: "Allow", exact: true }).click()
            await expect(approval).toHaveCount(0)
            await page.goto(`${server().url}/chats/${workshop.id}`)
            await openPanel(page, "Changes")
            const effect = page.locator('[data-effect-kind="changeset.apply"]')
            await expect(effect).toContainText(fixture.original)
            await expectLayout(page, info, `side-write-effect-${width}-${theme}`)
            const read = (forkId: typeof fixture.original) =>
              admin((api) =>
                api.ReadPath({
                  chatId: fixture.chat.id,
                  forkId,
                  leafSlotId: null,
                  range: { _tag: "Bottom" },
                  limit: 10
                })
              )
            expect((await read(fixture.original)).entries[0]!.version.content).toBe("CHANGED older sentinel")
            expect((await read(fixture.newer)).entries[0]!.version.content).toBe("NEWER sentinel")
            await effect.getByRole("button", { name: "Undo", exact: true }).click()
            await expect(effect).toContainText("Undone")
            expect((await read(fixture.original)).entries[0]!.version.content).toBe("OLDER sentinel")
            expect((await read(fixture.newer)).entries[0]!.version.content).toBe("NEWER sentinel")
          } finally {
            await provider.stop()
          }
        })
  })
}

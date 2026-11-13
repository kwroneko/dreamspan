import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { expectLayout } from "./layoutAudit.ts"
import { openPanel, closePanel, openSummarySettings } from "./panel.ts"
import { asUser } from "./rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./server.ts"
import { startSummaryWorkshopProvider, WORKSHOP_DONE, WORKSHOP_MEMORY } from "./workshopSummaryProvider.ts"

/** Real summary inference against a loopback script, including the request actually sent. */
export function workshopSummaryTests() {
  test.describe("workshop transcript summaries", () => {
    const server = serverPerFile(withAdmin)
    const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
    let provider: Awaited<ReturnType<typeof startSummaryWorkshopProvider>>
    test.beforeAll(async () => {
      provider = await startSummaryWorkshopProvider()
      await admin((api) =>
        Effect.gen(function* () {
          const connection = yield* api.CreateConnection({
            kind: "openai-chat",
            settings: {
              name: "Synthetic workshop",
              baseUrl: provider.url + "/v1",
              compat: {},
              cacheTtlS: null,
              maxConcurrent: null,
              presetOverrideRefId: null
            }
          })
          const model = yield* api.AddUserModel({
            connectionId: connection.id,
            key: "workshop-small",
            overrides: { context: 128_000, maxOutput: 4096 }
          })
          yield* api.CreateCard({
            label: "Synthetic keeper",
            name: "Synthetic keeper",
            description: "RAW LOOKUP " + Array.from({ length: 420 }, (_, i) => `word${i}`).join(" ")
          })
          yield* api.SetGenerationDefaults({
            defaults: { model: { connection: connection.id, model: model.id }, preset: null, lcm: { enabled: false } }
          })
        })
      )
    })
    test.afterAll(async () => {
      await provider.close()
    })
    for (const width of [1440, 390])
      for (const theme of ["light", "dark"] as const)
        test(`layer, cost copy and inspector at ${width} ${theme}`, async ({ page }, info) => {
          test.setTimeout(180_000)
          await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
          await page.emulateMedia({ colorScheme: theme })
          await page.addInitScript((theme) => localStorage.setItem("rp.theme", theme), theme)
          await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
          const chat = await admin((api) =>
            Effect.gen(function* () {
              const chat = yield* api.CreateWorkshop({ title: `Summary workshop ${width} ${theme}` })
              return chat
            })
          )
          // One session per task (logins are rate limited): send, generate, wait for the reply.
          const run = () => {
            provider.begin()
            return admin((api) =>
              Effect.gen(function* () {
                const path = api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 20 })
                const current = (yield* path).entries.at(-1)!
                const sent = yield* api.SendMessage({
                  chatId: chat.id,
                  parentSlotId: current.slotId,
                  branch: false,
                  content: "List, read and edit the synthetic keeper."
                })
                if (sent._tag !== "Posted") return yield* Effect.die("Unexpected queue")
                const reply = yield* api.Generate({ chatId: chat.id, parentSlotId: sent.entry.slotId, branch: false })
                if (reply._tag !== "Posted") return yield* Effect.die("Unexpected queue")
                for (let i = 0; i < 240; i++) {
                  if ((yield* path).entries.at(-1)?.version.content === WORKSHOP_DONE) return reply.entry.version.id
                  yield* Effect.sleep("250 millis")
                }
                return yield* Effect.die("The reply did not finish")
              })
            )
          }
          for (let i = 0; i < 3; i++) await run()
          const before = JSON.stringify(provider.requests().at(-1)!.body!.messages).length
          await page.goto(`${server().url}/chats/${chat.id}`)
          const summaries = await openPanel(page, "Summaries")
          await expect(summaries.getByRole("button", { name: "Enable summaries", exact: true })).toHaveCount(0)
          const settings = await openSummarySettings(page)
          await expect(settings).toContainText("When on, they use this chat’s summary model and add token costs")
          await expect(settings.getByRole("button", { name: "The current preset", exact: true })).toHaveCount(0)
          await expect(settings.getByRole("switch", { name: "Include notes in summary requests" })).toHaveCount(0)
          await expect(settings).toContainText("This workshop’s messages and tool steps only.")
          await settings.getByText("Advanced", { exact: true }).click()
          const set = async (field: import("@playwright/test").Locator, value: string) => {
            await field.fill(value)
            await field.press("Enter")
            await expect(field).toHaveValue(value)
          }
          await set(settings.getByRole("textbox", { name: "Chunk size", exact: true }), "500")
          await set(settings.getByRole("textbox", { name: "Summary length", exact: true }), "150")
          const recent = settings.getByRole("group", { name: "Recent messages kept as written", exact: true })
          // The live values, entered in the visible fields: the maximum below the old target
          // lowers it (and says so), then the target is set.
          await set(recent.getByRole("textbox", { name: "Maximum", exact: true }), "2200")
          await expect(recent.getByRole("status")).toContainText("Target lowered to")
          await set(recent.getByRole("textbox", { name: "Target", exact: true }), "1000")
          await expect(settings).toContainText("Chunk size now: 500 tokens.")
          await expect
            .poll(
              async () => {
                const view = await admin((api) => api.GetLcmSettings({ chatId: chat.id, leafSlotId: null }))
                return [view.resolved.recentTarget, view.resolved.recentMax, view.fit.length]
              },
              { intervals: [500] }
            )
            .toEqual([1000, 2200, 0])
          await expectLayout(page, info, `workshop-summary-settings-${width}-${theme}`, {
            scope: '[aria-label="Summary settings"]'
          })
          await closePanel(page)
          const from = provider.requests().length
          const version = await run()
          const sent = provider
            .requests()
            .slice(from)
            .filter((r) => Array.isArray(r.body?.tools) && r.body.tools.length)
          expect(JSON.stringify(sent[0]!.body!.messages)).toContain(WORKSHOP_MEMORY)
          expect(JSON.stringify(sent[0]!.body!.messages)).not.toContain("RAW LOOKUP")
          expect(JSON.stringify(sent[0]!.body!.messages).length).toBeLessThan(before)
          await page.goto(`${server().url}/chats/${chat.id}`)
          const layer = (await openPanel(page, "Summaries")).getByRole("region", { name: "Run summaries" })
          await expect(layer).toBeVisible()
          await layer
            .getByText(/Summary of earlier steps/)
            .first()
            .click()
          await expect(layer).toContainText(WORKSHOP_MEMORY)
          await expectLayout(page, info, `workshop-summary-layer-${width}-${theme}`, {
            scope: '[aria-label="Run summaries"]'
          })
          await closePanel(page)
          await page.goto(`${server().url}/chats/${chat.id}/context/${version}`)
          await expect(page.getByText(WORKSHOP_MEMORY, { exact: false }).first()).toBeVisible()
          const context = await admin((api) => api.GetRunContext({ versionId: version }))
          expect(context.messages.some((m) => m.sources.some((source) => source.kind === "summary"))).toBeTruthy()
          const steps = page.getByRole("region", { name: "Steps", exact: true })
          await expect(steps.getByText(/Summarized transcript/).first()).toBeVisible()
          await expect(steps.getByRole("region", { name: /^Result of read_card/ }).first()).toBeVisible()
          await expectLayout(page, info, `workshop-summary-inspector-${width}-${theme}`, {
            scope: '[aria-label="Steps"]'
          })
        })
  })
}

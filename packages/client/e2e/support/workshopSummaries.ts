import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { fixtureSql } from "../../../server/test/support/lcmFixtures.ts"
import { expectLayout } from "./layoutAudit.ts"
import { openPanel, closePanel, openSummarySettings } from "./panel.ts"
import { asUser } from "./rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./server.ts"
import { startWorkshopProvider, WORKSHOP_ANSWER } from "./workshopProvider.ts"

/** Browser fixture: compaction itself is exercised by the real-provider server tests. */
export function workshopSummaryTests() {
  test.describe("workshop transcript summaries", () => {
    const server = serverPerFile(withAdmin)
    const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
    let provider: Awaited<ReturnType<typeof startWorkshopProvider>>
    test.beforeAll(async () => {
      provider = await startWorkshopProvider()
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
          const model = yield* api.AddUserModel({
            connectionId: connection.id,
            key: "workshop-small",
            overrides: { context: 128_000, maxOutput: 4096 }
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
        test(`layer, cost copy and inspector at ${width} ${theme}`, async ({ page }, info) => {
          test.setTimeout(120_000)
          await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
          await page.emulateMedia({ colorScheme: theme })
          await page.addInitScript((theme) => localStorage.setItem("rp.theme", theme), theme)
          await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
          const chat = await admin((api) =>
            Effect.gen(function* () {
              const chat = yield* api.CreateWorkshop({ title: `Summary workshop ${width} ${theme}` })
              const sent = yield* api.SendMessage({
                chatId: chat.id,
                parentSlotId: chat.activeLeafSlotId,
                branch: false,
                content: "Work with the synthetic library."
              })
              if (sent._tag !== "Posted") return yield* Effect.die("Unexpected queue")
              yield* api.Generate({ chatId: chat.id, parentSlotId: sent.entry.slotId, branch: false })
              return chat
            })
          )
          const path = () =>
            admin((api) => api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 20 }))
          await expect
            .poll(async () => (await path()).entries.at(-1)?.version.content, { timeout: 60_000 })
            .toBe(WORKSHOP_ANSWER)
          const version = (await path()).entries.at(-1)!.version.id
          const [rows] = await Effect.runPromise(
            fixtureSql(
              server().dataDir,
              [
                {
                  sql: "SELECT p.rollout_id,p.transcript_json FROM versions v JOIN rollout_payloads p ON p.rollout_id=v.rollout_id WHERE v.id=?",
                  params: [version]
                }
              ],
              { readOnly: true }
            )
          )
          const transcript = JSON.parse(String(rows![0]!.transcript_json)) as Array<unknown>
          transcript.push({
            role: "rpCompaction",
            id: "synthetic-summary",
            from: 1,
            through: 3,
            content: "The assistant read the synthetic library. Original calls and results remain available.",
            timestamp: 1
          })
          await Effect.runPromise(
            fixtureSql(server().dataDir, [
              {
                sql: "UPDATE rollout_payloads SET transcript_json=? WHERE rollout_id=?",
                params: [JSON.stringify(transcript), String(rows![0]!.rollout_id)]
              }
            ])
          )
          await page.goto(`${server().url}/chats/${chat.id}`)
          const summaries = await openPanel(page, "Summaries")
          await expect(summaries.getByRole("button", { name: "Enable summaries", exact: true })).toHaveCount(0)
          const layer = summaries.getByRole("region", { name: "Run summaries" })
          await expect(layer).toBeVisible()
          await layer.getByText("Summary of earlier steps 1", { exact: true }).click()
          await expect(layer).toContainText("The assistant read the synthetic library.")
          await expectLayout(page, info, `workshop-summary-layer-${width}-${theme}`, {
            scope: '[aria-label="Run summaries"]'
          })
          const settings = await openSummarySettings(page)
          await expect(settings).toContainText("When on, they use this chat’s summary model and add token costs")
          await expect(settings.getByRole("button", { name: "The current preset", exact: true })).toHaveCount(0)
          await expect(settings.getByRole("switch", { name: "Include notes in summary requests" })).toHaveCount(0)
          await expect(settings).toContainText("This workshop’s messages and tool steps only.")
          await expectLayout(page, info, `workshop-summary-settings-${width}-${theme}`, {
            scope: '[aria-label="Summary settings"]'
          })
          await closePanel(page)
          await page.goto(`${server().url}/chats/${chat.id}/context/${version}`)
          const steps = page.getByRole("region", { name: "Steps", exact: true })
          await expect(steps.getByText(/Summarized transcript 1–2/)).toBeVisible()
          await expect(steps.getByRole("region", { name: "Tool call: list_library" })).toBeVisible()
          await expect(steps.getByRole("region", { name: /^Result of list_library/ })).toBeVisible()
          await expectLayout(page, info, `workshop-summary-inspector-${width}-${theme}`, {
            scope: '[aria-label="Steps"]'
          })
        })
  })
}

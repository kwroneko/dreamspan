// Agent replies in the browser (spec/AGENTIC.md §5, §6): a scripted provider that calls
// search_chat twice and then answers. A plain reply shows no steps; the Tools setting
// enables agent replies; the next reply's steps stream open as "Working…", folding
// during the run sticks as the user's preference, and when the reply arrives they fold to
// "2 steps · N s", with the same badge in the header, which opens them again (read from the
// transcript). The run inspector shows the tools offered and every request; the Activity tab lists
// a summary with its tokens and cost. Layout audit on each surface, at 1440 and 390, light and dark.
import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import type { SlotId } from "@dreamspan/shared/chat.ts"
import { uuidv7 } from "@dreamspan/shared/id.ts"
import { fixtureSql } from "../../server/test/support/lcmFixtures.ts"
import { AGENT_REPLY, PLAIN_REPLY, startAgentProvider, THINKING } from "./support/agentProvider.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { closePanel, openPanel } from "./support/panel.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const shots = process.env.SCREENSHOT_DIR
let provider: Awaited<ReturnType<typeof startAgentProvider>>
test.beforeAll(async () => {
  provider = await startAgentProvider()
})
test.afterAll(async () => {
  await provider.stop()
})

const prefs = () =>
  asUser(server(), ADMIN.handle, ADMIN.password, (api) => Effect.map(api.GetDisplayPrefs({}), (p) => p.steps))

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`agent steps, run inspector, Activity and Tools at ${width} ${theme}`, async ({ page }, info) => {
      test.setTimeout(180_000)
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const shot = async (name: string) => {
        if (shots) {
          mkdirSync(shots, { recursive: true })
          await page.waitForTimeout(200)
          await page.screenshot({ path: resolve(shots, `${name}-${width}-${theme}.png`), animations: "disabled" })
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      }
      const fixture = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        Effect.gen(function* () {
          yield* api.SetDisplayPrefs({ prefs: { steps: "expanded" } })
          const user = yield* api.Whoami()
          const connection = yield* api.CreateConnection({
            kind: "openai-chat",
            settings: {
              name: "Synthetic agent",
              baseUrl: provider.baseUrl,
              compat: {},
              cacheTtlS: null,
              maxConcurrent: null,
              presetOverrideRefId: null
            }
          })
          const model = yield* api.AddUserModel({ connectionId: connection.id, key: "agent-small", overrides: {} })
          yield* api.SetGenerationDefaults({
            defaults: { model: { connection: connection.id, model: model.id }, preset: null }
          })
          const chat = yield* api.CreateChat({ title: `Agent ${width} ${theme}` })
          const sent = yield* api.SendMessage({
            chatId: chat.id,
            parentSlotId: null,
            branch: false,
            content: "Is the bridge still standing?"
          })
          if (sent._tag !== "Posted") return yield* Effect.die("unexpected queue")
          return { user, connection, chat }
        })
      )
      const replyButton = () => page.getByRole("button", { name: /^(Reply$|Generate(?! another))/ }).last()
      await page.goto(`${server().url}/chats/${fixture.chat.id}`)

      // A plain reply: no steps, no badge.
      await replyButton().click()
      const plain = page.getByRole("article").filter({ hasText: PLAIN_REPLY })
      await expect(plain).toBeVisible()
      await expect(plain.locator("[data-steps-panel]")).toHaveCount(0)
      await expect(plain.locator("[data-steps-badge]")).toHaveCount(0)

      // Tools, in This chat, with the allowed list.
      const settings = await openPanel(page, "This chat")
      await settings.getByRole("switch", { name: "Tools", exact: true }).click()
      await expect(settings.getByRole("switch", { name: "Tools", exact: true })).toBeChecked()
      const tools = settings.getByRole("group", { name: "Allowed tools" })
      await expect(tools.getByRole("checkbox", { name: "Search the chat's earlier messages" })).toBeChecked()
      await shot("reply-mode")
      await expectLayout(page, info, `reply-mode-${width}-${theme}`, { scope: '[aria-label="Tools"]' })
      if (width === 390) await closePanel(page)

      // The next message's reply is the agent's.
      const leaf = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        Effect.gen(function* () {
          const path = yield* api.ReadPath({
            chatId: fixture.chat.id,
            leafSlotId: null,
            range: { _tag: "Bottom" },
            limit: 10
          })
          const last = path.entries.at(-1)!.slotId as SlotId
          const sent = yield* api.SendMessage({
            chatId: fixture.chat.id,
            parentSlotId: last,
            branch: false,
            content: "And the lantern?"
          })
          if (sent._tag !== "Posted") return yield* Effect.die("unexpected queue")
          return sent.entry.slotId
        })
      )
      expect(leaf).toBeTruthy()
      await expect(page.getByTestId("messages").getByText("And the lantern?")).toBeVisible()
      provider.hold()
      await replyButton().click()
      const reply = page.getByRole("article").last()
      const panel = reply.locator("[data-steps-panel]")
      const toggle = panel.getByRole("button", { name: /Working…/ })
      await expect(toggle).toBeVisible()
      await expect(toggle).toHaveAttribute("aria-expanded", "true")
      const rows = panel.locator('[data-step="tool"]')
      await expect(rows).toHaveCount(2)
      await expect(panel.locator('[data-step-status="done"]')).toHaveCount(2)
      await expect(panel.locator('[data-step="thinking"]')).toContainText(THINKING.slice(0, 30))
      await expect(rows.first()).toContainText("Searched the chat")
      await expect(rows.first()).toContainText("“bridge”")
      await expect(reply.locator("[data-steps-badge]")).toHaveText(/2 steps/)
      await shot("steps-running")
      await expectLayout(page, info, `steps-running-${width}-${theme}`, { scope: "article:last-of-type" })

      // The header badge is another way to fold the running steps, and saves the same preference.
      await reply.locator("[data-steps-badge]").click()
      await expect(toggle).toHaveAttribute("aria-expanded", "false")
      await expect.configure({ soft: true }).poll(prefs).toBe("collapsed")
      await reply.locator("[data-steps-badge]").click()
      await expect(toggle).toHaveAttribute("aria-expanded", "true")
      await expect.poll(prefs).toBe("expanded")

      // Folding during the run sticks; opening again puts it back.
      await toggle.click()
      await expect(toggle).toHaveAttribute("aria-expanded", "false")
      await expect.poll(prefs).toBe("collapsed")
      await toggle.click()
      await expect(toggle).toHaveAttribute("aria-expanded", "true")
      await expect.poll(prefs).toBe("expanded")

      // A second tab and a reload join mid-run with the same version's complete steps.
      const other = await page.context().newPage()
      await other.goto(`${server().url}/chats/${fixture.chat.id}`)
      const otherPanel = other.getByRole("article").last().locator("[data-steps-panel]")
      await expect(otherPanel).toHaveAttribute("data-steps-panel", "running")
      await expect(otherPanel.locator('[data-step="tool"]')).toHaveCount(2)
      await page.reload()
      await expect(toggle).toHaveAttribute("aria-expanded", "true")
      await expect(rows).toHaveCount(2)

      // The reply arrives: the steps fold to their count and time.
      provider.release()
      await expect(reply).toContainText(AGENT_REPLY)
      await expect(panel).toHaveAttribute("data-steps-panel", "done")
      await expect(otherPanel).toHaveAttribute("data-steps-panel", "done")
      await other.close()
      const done = panel.getByRole("button", { name: /^2 steps · / })
      await expect(done).toHaveAttribute("aria-expanded", "false")
      const badge = reply.locator("[data-steps-badge]")
      await expect(badge).toHaveText(/^2 steps · (?:\d+ min(?: \d+ s)?|\d+ s)$/)
      // The badge opens them, read from the transcript.
      await badge.click()
      await expect(done).toHaveAttribute("aria-expanded", "true")
      await expect(badge).toHaveAttribute("aria-pressed", "true")
      await expect(panel.locator('[data-step="tool"]')).toHaveCount(2)
      await panel.locator('[data-step="tool"]').first().getByRole("button").click()
      await expect(panel.locator("pre").first()).toBeVisible()
      await shot("steps-done")
      await expectLayout(page, info, `steps-done-${width}-${theme}`, { scope: "article:last-of-type" })

      // The run inspector: the tools offered and every request after the first.
      await panel.getByRole("link", { name: "Open the run" }).click()
      const tools2 = page.getByRole("region", { name: "Tools offered" })
      await expect(tools2.getByRole("region", { name: "search_chat" })).toBeVisible()
      const steps = page.getByRole("region", { name: "Steps", exact: true })
      await expect(steps.getByText("Request 3", { exact: true })).toBeVisible()
      await expect(steps.getByText("The tools above were offered.", { exact: true })).toHaveCount(3)
      await expect(steps.getByRole("region", { name: "Tool call: search_chat" }).first()).toContainText('"bridge"')
      await expect(steps.getByRole("region", { name: /^Result of search_chat/ }).first()).toBeVisible()
      // The reply went through the send tool (spec/REPLY-CONTRACT.md §3.1).
      await expect(steps.getByRole("region", { name: "Tool call: send_message" }).last()).toContainText(AGENT_REPLY)
      await steps.scrollIntoViewIfNeeded()
      await shot("run-inspector")
      await expectLayout(page, info, `run-inspector-${width}-${theme}`, { scope: '[aria-label="Steps"]' })
      await page.goBack()

      // Activity: a summary written for this chat, with its tokens and cost.
      const rollout = uuidv7(),
        summary = uuidv7(),
        revision = uuidv7(),
        revisedRollout = uuidv7(),
        revisedRevision = uuidv7()
      const entries = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        Effect.map(
          api.ReadPath({ chatId: fixture.chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 10 }),
          (p) => p.entries
        )
      )
      await Effect.runPromise(
        fixtureSql(server().dataDir, [
          {
            sql: "INSERT INTO rollouts(id,chat_id,kind,status,role,request_class,created_at,updated_at,started_at,completed_at) VALUES(?,?,'summarize','completed','summarizer','background',1000,3500,1000,3500)",
            params: [rollout, fixture.chat.id]
          },
          {
            sql: "INSERT INTO summary_revisions(id,summary_id,content,rollout_id,token_count,origin,created_at) VALUES(?,?,?,?,20,'generated',3500)",
            params: [revision, summary, "The traveler asks about the bridge.", rollout]
          },
          {
            sql: "INSERT INTO summaries(id,chat_id,level,selected_revision_id,first_slot_id,last_slot_id,slot_count,status,rollout_id,created_at) VALUES(?,?,1,?,?,?,2,'complete',?,3500)",
            params: [summary, fixture.chat.id, revision, entries[0]!.slotId, entries[1]!.slotId, rollout]
          },
          ...entries.slice(0, 2).map((entry, index) => ({
            sql: "INSERT INTO summary_inputs(summary_id,ordinal,slot_id,version_id,amend_count) VALUES(?,?,?,?,0)",
            params: [summary, index, entry.slotId, entry.version.id]
          })),
          { sql: "UPDATE summaries SET sealed=1 WHERE id=?", params: [summary] },
          {
            sql: "INSERT INTO rollouts(id,chat_id,kind,status,role,request_class,created_at,updated_at,started_at,completed_at) VALUES(?,?,'summarize','completed','summarizer','background',4000,5000,4000,5000)",
            params: [revisedRollout, fixture.chat.id]
          },
          {
            sql: "INSERT INTO summary_revisions(id,summary_id,content,rollout_id,token_count,origin,created_at) VALUES(?,?,?,?,20,'generated',5000)",
            params: [revisedRevision, summary, "A revised bridge summary.", revisedRollout]
          },
          {
            sql: "INSERT INTO llm_requests(id,owner_user_id,connection_id,chat_id,rollout_id,purpose,api,provider,model_key,status,started_at,ended_at,input_uncached,cache_read,output,usage_source,cost,cost_currency,cost_formula) VALUES(?,?,?,?,?,'summarize','openai','synthetic','revision-summarizer','complete',4000,5000,80,0,20,'reported',0.025,'USD','reported')",
            params: [uuidv7(), fixture.user.id, fixture.connection.id, fixture.chat.id, revisedRollout]
          },
          {
            sql: "INSERT INTO llm_requests(id,owner_user_id,connection_id,chat_id,rollout_id,purpose,api,provider,model_key,status,started_at,ended_at,input_uncached,cache_read,cache_write,output,usage_source,cost,cost_currency,cost_formula) VALUES(?,?,?,?,?,'summarize','openai','synthetic','synthetic-summarizer','complete',1000,3500,120,30,NULL,40,'reported',0.0123,'USD','reported')",
            params: [uuidv7(), fixture.user.id, fixture.connection.id, fixture.chat.id, rollout]
          }
        ])
      )
      const activity = await openPanel(page, "Activity")
      const row = activity.locator('[data-activity="summarize"]').last()
      await expect(row).toContainText("Summarizing messages")
      await expect(row).toContainText("synthetic-summarizer")
      await expect(row).toContainText("0.0123 USD")
      await expect(row).toContainText("Input150")
      await expect(row.getByRole("link", { name: "Open request" })).toBeVisible()
      // The agent's reply is reached from its message, not listed here.
      await expect(activity.locator('[data-activity="generation"]')).toHaveCount(0)
      await shot("activity")
      await expectLayout(page, info, `activity-${width}-${theme}`, { scope: '[aria-label="Activity"]' })
      // A later generated revision links to its own request, even when another revision is selected.
      const revised = activity.locator('[data-activity="summarize"]').first()
      await expect(revised).toContainText("revision-summarizer")
      await revised.getByRole("link", { name: "Open request" }).click()
      await expect(page.locator('[aria-label="Summary generation details"]')).toContainText("revision-summarizer")
      await expectLayout(page, info, `activity-request-${width}-${theme}`, {
        scope: '[aria-label="Summary generation details"]'
      })
    })
  }

import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { uuidv7 } from "@rp/shared/id.ts"
import { fixtureSql } from "../../server/test/support/lcmFixtures.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { openPanel } from "./support/panel.ts"
import { level1 } from "./support/summaries.ts"

const server = serverPerFile(withAdmin)
for (const scheme of ["light", "dark"] as const)
  for (const width of [1440, 390]) {
    test(`summary Details show stored model, usage, unknowns and the captured request at ${width} (${scheme})`, async ({
      page
    }) => {
      test.setTimeout(120_000)
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: scheme })
      const fixture = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        Effect.gen(function* () {
          const user = yield* api.Whoami()
          const connection = yield* api.CreateConnection({
            kind: "openai-chat",
            settings: {
              name: "Summary fixture",
              baseUrl: "http://127.0.0.1:1/v1",
              compat: {},
              cacheTtlS: null,
              maxConcurrent: null,
              presetOverrideRefId: null
            }
          })
          const chat = yield* api.CreateChat({ title: `Summary details ${width}` })
          let parent = null as import("@rp/shared/chat.ts").SlotId | null
          for (let i = 0; i < 4; i++) {
            const sent = yield* api.SendMessage({
              chatId: chat.id,
              parentSlotId: parent,
              branch: false,
              content: `Synthetic story ${i}`
            })
            if (sent._tag !== "Posted") throw new Error("expected posted")
            parent = sent.entry.slotId
          }
          const path = yield* api.ReadPath({
            chatId: chat.id,
            leafSlotId: parent,
            range: { _tag: "Bottom" },
            limit: 10
          })
          return { user, connection, chat, entries: path.entries }
        })
      )
      const id = uuidv7(),
        revision = uuidv7(),
        rollout = uuidv7(),
        job = uuidv7()
      const wire = {
        display: {
          model: {
            connection: "Historical model server",
            model: "synthetic-summarizer",
            kind: "openai-chat",
            breakpoints: "none"
          },
          preset: { label: null, scope: "builtin" },
          issues: []
        },
        messages: [
          { role: "system", content: "Summarize this synthetic story.", inputs: [] },
          { role: "user", content: "A keeper saves a ledger from the flood.", inputs: [] }
        ],
        samplers: {}
      }
      await Effect.runPromise(
        fixtureSql(server().dataDir, [
          {
            sql: "INSERT INTO rollouts(id,chat_id,fork_id,kind,status,role,request_class,created_at,updated_at,started_at,completed_at) VALUES(?,?,?,'summarize','completed','summarizer','background',1000,3500,1000,3500)",
            params: [rollout, fixture.chat.id, fixture.chat.currentForkId]
          },
          {
            sql: "INSERT INTO rollout_payloads(rollout_id,sent_context_json) VALUES(?,?)",
            params: [rollout, JSON.stringify(wire)]
          },
          {
            sql: "INSERT INTO summary_revisions(id,summary_id,content,token_count,origin,created_at) VALUES(?,?,?,20,'generated',3500)",
            params: [revision, id, "The keeper saved the ledger."]
          },
          {
            sql: "INSERT INTO summaries(id,chat_id,level,selected_revision_id,first_slot_id,last_slot_id,slot_count,status,rollout_id,created_at) VALUES(?,?,1,?,?,?,2,'complete',?,3500)",
            params: [id, fixture.chat.id, revision, fixture.entries[0]!.slotId, fixture.entries[1]!.slotId, rollout]
          },
          ...fixture.entries.slice(0, 2).map((entry, index) => ({
            sql: "INSERT INTO summary_inputs(summary_id,ordinal,slot_id,version_id,amend_count) VALUES(?,?,?,?,0)",
            params: [id, index, entry.slotId, entry.version.id]
          })),
          { sql: "UPDATE summaries SET sealed=1 WHERE id=?", params: [id] },
          {
            sql: "INSERT INTO summarization_jobs(id,chat_id,fork_id,level,first_slot_id,last_slot_id,status,target_token_count,result_summary_id,rollout_id,attempts,created_at,updated_at) VALUES(?,?,?,1,?,?,'complete',600,?,?,1,1000,3500)",
            params: [
              job,
              fixture.chat.id,
              fixture.chat.currentForkId,
              fixture.entries[0]!.slotId,
              fixture.entries[1]!.slotId,
              id,
              rollout
            ]
          },
          {
            sql: "INSERT INTO llm_requests(id,owner_user_id,connection_id,chat_id,rollout_id,purpose,api,provider,model_key,status,started_at,ended_at,input_uncached,cache_read,cache_write,output,usage_source,cost,cost_currency,cost_formula) VALUES(?,?,?,?,?,'summarize','openai','synthetic','synthetic-summarizer','complete',1000,3500,120,30,NULL,40,'reported',0.0123,'USD','reported')",
            params: [uuidv7(), fixture.user.id, fixture.connection.id, fixture.chat.id, rollout]
          }
        ])
      )
      const unknown = await level1(
        server().dataDir,
        fixture.chat.id,
        fixture.entries.slice(2, 3),
        "An older summary without recorded usage."
      )
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/chats/${fixture.chat.id}`)
      await openPanel(page, "Summaries")
      const row = page.locator(`[data-summary="${id}"]`)
      await row.getByRole("button", { name: /^Details of the summary/ }).click()
      const details = page.getByRole("dialog", { name: "How it was written" })
      await expect(details.getByText("synthetic-summarizer", { exact: true })).toBeVisible()
      await expect(
        details.getByText(/Input: 120.*Cache read: 30.*Cache write: Unknown.*Output: 40 tokens/)
      ).toBeVisible()
      await expect(details.getByText(/Cost:.*0.012/)).toBeVisible()
      await expect(details.getByText("2.5 s", { exact: true })).toBeVisible()
      // The stored purpose and status in words (owner, 2026-11-02), not "(summarize, complete)".
      await expect(details.getByText(/^Summarizing messages? [\d–]+, finished$/)).toBeVisible()
      await expect(details.getByText(/stored as/)).toHaveCount(0)
      if (process.env.SCREENSHOT_DIR)
        await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/summary-details-${width}-${scheme}.png` })
      await details.getByRole("link", { name: "Open request in inspector" }).click()
      await expect(page.getByRole("heading", { name: "Summary request inspector" })).toBeVisible()
      await expect(page.getByText("A keeper saves a ledger from the flood.", { exact: true })).toBeVisible()
      // The inspector page says the same words, and the stored values beside them for debugging.
      await expect(page.getByText(/^Summarizing messages, finished \(stored as summarize, complete\)$/)).toBeVisible()
      if (process.env.SCREENSHOT_DIR)
        await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/summary-request-${width}-${scheme}.png` })
      await page.getByRole("link", { name: "Back to the summary" }).click()
      const old = page.locator(`[data-summary="${unknown.id}"]`)
      await old.getByRole("button", { name: /^Details of the summary/ }).click()
      const oldDetails = page.getByRole("dialog", { name: "How it was written" })
      await expect(oldDetails.getByText("Tokens: Unknown. Cost: Unknown. No request usage was recorded.")).toBeVisible()
      await expect(oldDetails.getByText("The request itself wasn't kept.")).toBeVisible()
      await expect(oldDetails.getByRole("link", { name: "Open request in inspector" })).toHaveCount(0)
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    })
  }

import { assert, it } from "@effect/vitest"
import { PAIRS_8K } from "./support/lcmHarness.ts"
import { NewVersion } from "@dreamspan/shared/chat.ts"
import { Effect } from "effect"
import { Reader, Writer } from "../src/db/Database.ts"
import { client, posted } from "./support/config.ts"
import { lcmServer } from "./support/lcmHarness.ts"
import { completionChunks, sse, startMockProvider } from "./support/mockProvider.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { completeFixture, fixtureSql } from "./support/lcmFixtures.ts"
import type { ContextSnapshot } from "../src/assembler/types.ts"

for (const mode of ["direct", "tool", "refused", "partial", "gap"] as const) {
  const style = mode === "tool" ? "tool" : "direct"
  const server = lcmServer()
  const config = server.config
  it.live(
    `${mode} summaries run after the reply, share its cached prefix and use the ledger`,
    () =>
      Effect.gen(function* () {
        let summaries = 0
        const mock = yield* Effect.acquireRelease(
          Effect.promise(() =>
            startMockProvider((req, res) => {
              const messages = req.body?.messages as Array<{ role: string; content: string }>
              if (
                messages.at(-1)?.content?.includes("summary_tool") ||
                messages.at(-1)?.content?.includes("Return only the summary")
              ) {
                summaries++
                if (mode === "refused" || (mode === "gap" && summaries <= 3)) {
                  sse(res, [
                    {
                      id: "refusal",
                      object: "chat.completion.chunk",
                      model: "synthetic",
                      choices: [
                        {
                          index: 0,
                          delta: { role: "assistant", content: "A synthetic rejected draft." },
                          finish_reason: "content_filter"
                        }
                      ]
                    }
                  ])
                } else if (mode === "partial") {
                  res.writeHead(200, { "content-type": "text/event-stream" })
                  res.write(
                    `data: ${JSON.stringify(completionChunks(["The synthetic travelers remembered the bridge."], {})[0])}\n\n`
                  )
                  setTimeout(() => res.destroy(), 25)
                } else if (style === "tool") {
                  sse(res, [
                    {
                      id: "tool-1",
                      object: "chat.completion.chunk",
                      model: "synthetic",
                      choices: [
                        {
                          index: 0,
                          delta: {
                            role: "assistant",
                            tool_calls: [
                              {
                                index: 0,
                                id: "call_summary",
                                type: "function",
                                function: {
                                  name: "summary_tool",
                                  arguments: JSON.stringify({
                                    command: "create",
                                    file_text: "The synthetic travelers remembered the bridge.",
                                    finalize: true
                                  })
                                }
                              }
                            ]
                          },
                          finish_reason: null
                        }
                      ]
                    },
                    {
                      id: "tool-1",
                      object: "chat.completion.chunk",
                      model: "synthetic",
                      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }]
                    }
                  ])
                } else
                  sse(
                    res,
                    completionChunks(["The synthetic travelers remembered the bridge."], {
                      prompt_tokens: 100,
                      completion_tokens: 12,
                      prompt_tokens_details: { cached_tokens: 70 }
                    })
                  )
              } else
                sse(
                  res,
                  completionChunks(["A synthetic reply."], {
                    prompt_tokens: 100,
                    completion_tokens: 5,
                    prompt_tokens_details: { cached_tokens: 70 }
                  })
                )
            })
          ),
          (m) => Effect.promise(() => m.close())
        )
        const api = yield* client(),
          writer = yield* Writer,
          reader = yield* Reader,
          user = yield* api.Whoami()
        const { chat, events } = yield* generateReply(api, {
          connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1`, cacheTtlS: 300 },
          model: { context: 8192, maxOutput: 512, tools: true },
          preset: {
            openai_max_context: 8192,
            openai_max_tokens: 512,
            prompts: [
              {
                identifier: "main",
                name: "Main",
                role: "system",
                system_prompt: true,
                content: "Fixed instruction. {{random::" + Array.from({ length: 1000 }, (_, i) => i).join("::") + "}}"
              }
            ]
          }
        })
        yield* Effect.sleep(350)
        yield* writer.AddStateEvent({
          userId: user.id,
          chatId: chat.id,
          slotId: null,
          versionId: null,
          scope: null,
          data: { key: "lcm.settings", value: { enabled: true, style, leafInput: 500, leafTarget: 100, ...PAIRS_8K } }
        })
        const path = yield* reader.GetPath({ userId: user.id, chatId: chat.id, leafSlotId: null, limit: 100 })
        yield* completeFixture(
          config.dataDir,
          writer,
          user.id,
          chat.id,
          path.entries.slice(0, 2).map((e) => ({ slotId: e.slotId, versionId: e.version.id, amendCount: 0 }))
        )
        let leaf = path.entries.at(-1)!.slotId
        // 5.2k raw tokens: above the eager trigger, below the maximum. Editing does not wake it.
        for (let n = 0; n < 20; n++) {
          const added = yield* writer.AppendMessage({
            userId: user.id,
            chatId: chat.id,
            parentSlotId: leaf,
            branch: false,
            commitDraft: null,
            version: new NewVersion({
              speakerEntityId: null,
              writer: "human",
              content: `Synthetic ${n}. ` + "A bridge over water. ".repeat(50),
              macroMode: "verbatim",
              status: "complete",
              origin: "user_written"
            })
          })
          leaf = added.slotId
        }
        yield* Effect.sleep(350)
        assert.strictEqual(summaries, 0)
        yield* server.startPoolAfterReply()
        const reply = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: leaf, branch: false }))
        yield* eventually(() => finished(events, reply.entry.version.id) !== undefined, 60_000)
        assert.strictEqual(finished(events, reply.entry.version.id)!.status, "complete")
        yield* eventually(() => summaries > 0, 60_000)
        if (mode === "refused") {
          let failed = false
          for (let n = 0; n < 200; n++) {
            const [rows] = yield* fixtureSql(config.dataDir, [
              {
                sql: "SELECT count(*) AS n FROM summarization_jobs WHERE chat_id=? AND status='failed'",
                params: [chat.id]
              }
            ])
            if (Number(rows![0]!.n) > 0) {
              failed = true
              break
            }
            yield* Effect.sleep(100)
          }
          assert.isTrue(failed)
          assert.isAtLeast(summaries, 3)
          const [rows] = yield* fixtureSql(config.dataDir, [
            {
              sql: "SELECT count(*) AS n FROM summaries s JOIN llm_requests q ON q.rollout_id=s.rollout_id WHERE s.chat_id=? AND s.status<>'failed'",
              params: [chat.id]
            }
          ])
          assert.strictEqual(Number(rows![0]!.n), 0)
          // The end of the retries is a failed summary with its cause and an empty revision, not a lost range.
          const [failedRows] = yield* fixtureSql(config.dataDir, [
            {
              sql: "SELECT s.error_json,s.status,r.content,r.origin FROM summaries s JOIN summary_revisions r ON r.id=s.selected_revision_id WHERE s.chat_id=? AND s.status='failed'",
              params: [chat.id]
            }
          ])
          assert.lengthOf(failedRows!, 1)
          assert.strictEqual(failedRows![0]!.status, "failed")
          assert.strictEqual(failedRows![0]!.content, "")
          assert.deepInclude(JSON.parse(failedRows![0]!.error_json as string), { class: "refused", kind: "hard" })
          const unchanged = yield* reader.AssembleContext({
            userId: user.id,
            chatId: chat.id,
            slotId: reply.entry.slotId,
            versionId: reply.entry.version.id,
            now: 1,
            timeZone: "UTC",
            frozen: null
          })
          assert.isTrue(
            (JSON.parse(unchanged.snapshot) as ContextSnapshot).request.messages.some((m) =>
              m.content.includes("Synthetic 0.")
            ),
            "failed summary keeps originals while they fit"
          )
          return
        }
        let summaryRows: Array<Record<string, unknown>> = []
        for (let n = 0; n < 200; n++) {
          const [rows] = yield* fixtureSql(config.dataDir, [
            {
              sql: "SELECT s.id,s.status AS summary_status,s.batch_id,r.request_class,r.status,p.context_snapshot_json AS snapshot FROM summaries s JOIN rollouts r ON r.id=s.rollout_id JOIN rollout_payloads p ON p.rollout_id=r.id WHERE s.chat_id=? AND s.status<>'failed'",
              params: [chat.id]
            }
          ])
          summaryRows = rows!
          if (summaryRows.length) break
          yield* Effect.sleep(100)
        }
        assert.isAbove(summaryRows.length, 0)
        assert.strictEqual(summaryRows[0]!.summary_status, mode === "partial" ? "truncated" : "complete")
        if (mode === "partial") assert.isAtLeast(summaries, 3)
        if (mode === "gap") {
          for (let n = 0; n < 200; n++) {
            const [rows] = yield* fixtureSql(config.dataDir, [
              {
                sql: "SELECT count(*) AS n FROM summarization_jobs WHERE chat_id=? AND status IN ('pending','processing')",
                params: [chat.id]
              }
            ])
            if (Number(rows![0]!.n) === 0) break
            yield* Effect.sleep(100)
          }
          const paid = summaries
          assert.isAbove(paid, 3)
          for (let n = 0; n < 3; n++) {
            const retried = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: leaf, branch: true }))
            yield* eventually(() => finished(events, retried.entry.version.id) !== undefined, 60_000)
            yield* Effect.sleep(650)
            assert.strictEqual(summaries, paid, "replanning after a failed gap must not buy the completed ranges again")
          }
          return
        }
        const summarySnapshot = JSON.parse(summaryRows[0]!.snapshot as string) as ContextSnapshot
        const [live] = yield* fixtureSql(config.dataDir, [
          {
            sql: "SELECT p.context_snapshot_json AS snapshot FROM versions v JOIN rollout_payloads p ON p.rollout_id=v.rollout_id WHERE v.id=?",
            params: [reply.entry.version.id]
          }
        ])
        const liveSnapshot = JSON.parse(live![0]!.snapshot as string) as ContextSnapshot
        const boundary = liveSnapshot.request.breakpoints.find((b) => b.reason === "summary")!.message
        const requests = mock.requests().map((r) => r.body!)
        const summaryRequest = requests.find((r) =>
          (r.messages as Array<{ content: string }>)
            .at(-1)
            ?.content?.includes(style === "tool" ? "summary_tool" : "Return only the summary")
        )!
        const liveRequest = requests
          .filter((r) => !(r.messages as Array<{ content: string }>).at(-1)?.content?.includes("summary"))
          .at(-1)!
        assert.deepStrictEqual(
          (summaryRequest.messages as unknown[]).slice(0, boundary + 1),
          (liveRequest.messages as unknown[]).slice(0, boundary + 1),
          "same wire prefix through the layer"
        )
        assert.strictEqual((summaryRequest.messages as Array<{ role: string }>).at(-1)!.role, "user")
        assert.isFalse(summarySnapshot.request.breakpoints.some((b) => b.reason === "history"))
        assert.strictEqual(summaryRows[0]!.status, "completed")
        assert.strictEqual(summaryRows[0]!.request_class, "idle")
        const [ledger] = yield* fixtureSql(config.dataDir, [
          { sql: "SELECT count(*) AS n FROM llm_requests WHERE chat_id=? AND purpose='summarize'", params: [chat.id] }
        ])
        assert.isAbove(Number(ledger![0]!.n), 0)
      }).pipe(Effect.provide(server.layer)),
    120_000
  )
}

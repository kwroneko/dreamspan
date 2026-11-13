import { assert, it } from "@effect/vitest"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type { AssistantMessage } from "@earendil-works/pi-ai"
import type { ChatEvent } from "@rp/shared/chatApi.ts"
import { Effect, Stream } from "effect"
import { Reader, Writer } from "../src/db/Database.ts"
import { ExecutionRegistry } from "../src/execution.ts"
import { Summarizer } from "../src/lcm/Summarizer.ts"
import { activeRunSummaries } from "../src/agent/compaction.ts"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"
import { completionChunks, sse, startMockProvider } from "./support/mockProvider.ts"
import { eventually, finished } from "./support/generation.ts"

it.live(
  "resumes 5,000 original steps from a 200k model on 32k, compacts before sending, and edits a summarized step",
  () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((req, res) => {
            if (req.body?.model === "synthetic-wide") {
              res.writeHead(400, { "content-type": "application/json" })
              res.end(JSON.stringify({ error: { message: "Synthetic parked request." } }))
              return
            }
            sse(
              res,
              completionChunks(
                [
                  req.body?.model === "synthetic-summary"
                    ? "Read synthetic library entries; no changes were made. Original calls remain available through read_run."
                    : "Resumed after compaction."
                ],
                {}
              )
            )
          })
        ),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client(),
        reader = yield* Reader,
        writer = yield* Writer,
        execution = yield* ExecutionRegistry
      const me = yield* api.Whoami()
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: "Synthetic scale",
          baseUrl: `${mock.url}/v1`,
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        }
      })
      const wide = yield* api.AddUserModel({
        connectionId: connection.id,
        key: "synthetic-wide",
        overrides: { context: 200_000, maxOutput: 50_000 }
      })
      const small = yield* api.AddUserModel({
        connectionId: connection.id,
        key: "synthetic-small",
        overrides: { context: 32_768, maxOutput: 8192 }
      })
      const summary = yield* api.AddUserModel({
        connectionId: connection.id,
        key: "synthetic-summary",
        overrides: { context: 32_768, maxOutput: 2048 }
      })
      yield* api.ChangeGenerationDefaults({ change: { model: { connection: connection.id, model: wide.id } } })
      const planner = execution.orchestrationModes.get("workshop")!
      yield* execution.orchestrationModes.register({
        ...planner,
        plan: (input) => ({ ...planner.plan(input), contract: "final_text", tools: ["read_card", "read_run"] })
      })
      const chat = yield* api.CreateWorkshop({})
      yield* writer.AddStateEvent({
        userId: me.id,
        chatId: chat.id,
        slotId: null,
        versionId: null,
        scope: "summarizer",
        data: { key: "model.binding", value: { connection: connection.id, model: summary.id } }
      })
      const events: Array<ChatEvent> = []
      yield* api.SubscribeChat({ chatId: chat.id }).pipe(
        Stream.runForEach((batch) => Effect.sync(() => events.push(...batch))),
        Effect.forkScoped
      )
      yield* eventually(() => events.length > 0)
      const sent = yield* posted(
        api.SendMessage({
          chatId: chat.id,
          parentSlotId: chat.activeLeafSlotId,
          branch: false,
          content: "A long synthetic card-editing workshop."
        })
      )
      const reply = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: sent.entry.slotId, branch: false }))
      yield* eventually(() => finished(events, reply.entry.version.id)?.status === "failed")
      const stored = yield* reader.RolloutMaterial({ userId: me.id, versionId: reply.entry.version.id })
      const messages: Array<AgentMessage> = [{ role: "rpRequest", timestamp: 0 }]
      for (let n = 0; n < 5000; n++) {
        const turn: AssistantMessage = {
          role: "assistant",
          content: [{ type: "toolCall", id: `scale-${n}`, name: "read_card", arguments: { card: `Synthetic ${n}` } }],
          api: "openai-completions",
          provider: "openai",
          model: "synthetic-wide",
          stopReason: "toolUse",
          timestamp: n,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
          }
        }
        messages.push(turn, {
          role: "toolResult",
          toolCallId: `scale-${n}`,
          toolName: "read_card",
          content: [
            {
              type: "text",
              text: `Original result ${n}; keeper card id synthetic-${n}. ` + "Synthetic library detail. ".repeat(12)
            }
          ],
          details: null,
          isError: false,
          timestamp: n
        })
      }
      yield* writer.SaveRolloutTranscript({
        userId: me.id,
        rolloutId: stored.rolloutId,
        transcript: JSON.stringify(messages),
        steps: 5000
      })
      yield* api.ChangeCast({
        chatId: chat.id,
        slotId: reply.entry.slotId,
        change: { _tag: "Model", connection: connection.id, model: small.id }
      })
      const before = performance.now()
      const slot = yield* reader.GetSlot({ userId: me.id, slotId: reply.entry.slotId })
      const resumed = yield* api.ResumeVersion({
        versionId: reply.entry.version.id,
        expectedRowVersion: slot.entry.rowVersion
      })
      yield* eventually(() => finished(events, resumed.version.id)?.status === "complete", 180_000)
      const material = yield* reader.RolloutMaterial({ userId: me.id, versionId: resumed.version.id })
      const kept = JSON.parse(material.transcript!) as Array<AgentMessage>
      assert.isAbove(activeRunSummaries(kept).length, 0)
      assert.lengthOf(
        kept.filter((m) => m.role === "toolResult"),
        5000
      )
      const snapshot = JSON.parse(material.snapshot)
      const count = yield* reader.CountRolloutContext({
        model: JSON.stringify(snapshot.inputs.model),
        request: JSON.stringify(snapshot.request),
        transcript: material.transcript!,
        tools: JSON.stringify(snapshot.agent.tools)
      })
      assert.isBelow(count, 32_768)
      const editedSlot = yield* reader.GetSlot({ userId: me.id, slotId: resumed.slotId })
      const edited = yield* api.ResumeFromStep({
        versionId: resumed.version.id,
        expectedRowVersion: editedSlot.entry.rowVersion,
        step: 1000,
        edit: { kind: "result", text: "Edited synthetic lookup, retain this exact result." }
      })
      yield* eventually(() => finished(events, edited.version.id)?.status === "complete", 180_000)
      const last = mock
        .requests()
        .filter((r) => r.body?.model === "synthetic-small")
        .at(-1)!
      assert.include(JSON.stringify(last.body), "Edited synthetic lookup, retain this exact result.")
      console.info(
        `5,000-step Resume + step edit: ${Math.round(performance.now() - before)} ms; projected input ${count} tokens; ${mock.requests().filter((r) => r.body?.model === "synthetic-summary").length} summary requests.`
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config, undefined, Summarizer.manual)))
  }
)

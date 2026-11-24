import { assert, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type { ChatEvent } from "@dreamspan/shared/chatApi.ts"
import { newCardDoc } from "@dreamspan/shared/editing.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { ExecutionRegistry } from "../src/execution.ts"
import type { ContextSnapshot } from "../src/assembler/types.ts"
import { activeRunSummaries } from "../src/agent/compaction.ts"
import { liveSuffix } from "../src/agent/messages.ts"
import { lcmServer, lcmHarness } from "./support/lcmHarness.ts"
import { client, posted } from "./support/config.ts"
import { generateReply, eventually, finished } from "./support/generation.ts"
import { completionChunks, sse, startMockProvider } from "./support/mockProvider.ts"

const call = (name: string, args: object, id: string) => [
  {
    id: "synthetic",
    object: "chat.completion.chunk",
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }]
        },
        finish_reason: null
      }
    ]
  },
  { id: "synthetic", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }
]
const thresholds = { recentTarget: 1000, recentMax: 2200, leafInput: 500, leafTarget: 150, when: "next-reply" as const }

for (const mode of ["native", "dispatcher", "every"] as const)
  it.live(
    `uses landed summaries on the next workshop request and Regenerate (${mode})`,
    () => {
      const server = lcmServer()
      return Effect.gen(function* () {
        let step = 99,
          turn = 0
        const mock = yield* Effect.acquireRelease(
          Effect.promise(() =>
            startMockProvider((req, res) => {
              if (!req.body) {
                res.writeHead(200, { "content-type": "application/json" })
                res.end(JSON.stringify({ data: [] }))
                return
              }
              if (req.body.model === "synthetic-summary" || !Array.isArray(req.body.tools) || !req.body.tools.length)
                return sse(
                  res,
                  completionChunks(
                    ["SAVED WORKSHOP MEMORY: keeper id remains available; lookups complete; edit confirmed."],
                    {}
                  )
                )
              const script = [
                ...(mode === "every" ? [] : [["tool_search", { query: "select:read_card,edit_card" }]]),
                ["list_library", { kind: "card" }],
                ...Array.from({ length: 5 }, () => [
                  "read_card",
                  { card: "Synthetic keeper", fields: ["description"] }
                ]),
                [
                  "edit_card",
                  { card: "Synthetic keeper", changes: [{ field: "personality", text: `Synthetic edit ${turn}` }] }
                ]
              ] as Array<[string, object]>
              const next = script[step++]
              if (!next) return sse(res, completionChunks(["Work complete."], {}))
              const [name, args] = next
              return sse(
                res,
                call(
                  mode === "dispatcher" && name !== "tool_search" && name !== "list_library" ? "call_tool" : name,
                  mode === "dispatcher" && name !== "tool_search" && name !== "list_library"
                    ? { name, arguments: args }
                    : args,
                  `turn-${turn}-step-${step}`
                )
              )
            })
          ),
          (m) => Effect.promise(() => m.close())
        )
        const api = yield* client(),
          reader = yield* Reader,
          writer = yield* Writer,
          registry = yield* ExecutionRegistry
        const setup = yield* generateReply(api, {
          connection: {
            kind: mode === "native" ? "openrouter" : "openai-chat",
            baseUrl: mock.url + "/v1",
            apiKey: "synthetic-key",
            providerSettings: { toolLoading: mode === "native" ? "auto" : mode }
          },
          modelKey: mode === "native" ? "anthropic/claude-sonnet-4.5" : "synthetic-without-tokenizer",
          model: {
            context: 786432,
            maxOutput: 4096,
            settings: {
              ...(mode === "native" ? { routing: { only: ["anthropic"], allow_fallbacks: false } } : {}),
              samplers: { openai_max_context: 786432, openai_max_tokens: 4096 }
            }
          }
        })
        const user = yield* api.Whoami()
        const summary = yield* api.AddUserModel({
          connectionId: setup.connection.id,
          key: "synthetic-summary",
          overrides: { context: 32768, maxOutput: 2048 }
        })
        const chat = yield* api.CreateWorkshop({})
        yield* writer.AddStateEvent({
          userId: user.id,
          chatId: chat.id,
          slotId: null,
          versionId: null,
          scope: "summarizer",
          data: { key: "model.binding", value: { connection: setup.connection.id, model: summary.id } }
        })
        yield* writer.CreateEntity({
          userId: user.id,
          kind: "card",
          label: "Synthetic keeper",
          subtitle: "",
          schemaVersion: 1,
          origin: "user",
          sourcePath: null,
          doc: {
            ...newCardDoc("Synthetic keeper"),
            description: "RAW OLD LOOKUP " + Array.from({ length: 420 }, (_, i) => `word${i}`).join(" ")
          }
        })
        const attached = yield* api.CreateCard({
          name: "Synthetic attachment",
          label: "Synthetic attachment",
          description: "PINNED CARD FACT: the ledger is blue."
        })
        const planner = registry.orchestrationModes.get("workshop")!
        yield* registry.orchestrationModes.register({
          ...planner,
          plan: (input) => ({
            ...planner.plan(input),
            contract: "final_text",
            tools: ["list_library", "read_card", "edit_card"]
          })
        })
        const events: ChatEvent[] = []
        yield* api.SubscribeChat({ chatId: chat.id }).pipe(
          Stream.runForEach((batch) => Effect.sync(() => events.push(...batch))),
          Effect.forkScoped
        )
        yield* eventually(() => events.length > 0)
        const attachmentOnly = yield* posted(
          api.SendMessage({
            chatId: chat.id,
            parentSlotId: chat.activeLeafSlotId,
            branch: false,
            content: "",
            library: [{ kind: "card", refId: attached.id }]
          })
        )
        let parent = attachmentOnly.entry.slotId
        const run = Effect.fnUntraced(function* () {
          turn++
          step = 0
          const sent = yield* posted(
            api.SendMessage({
              chatId: chat.id,
              parentSlotId: parent,
              branch: false,
              content: `Synthetic task ${turn}: list, read and edit the keeper.`
            })
          )
          const reply = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: sent.entry.slotId, branch: false }))
          yield* eventually(() => finished(events, reply.entry.version.id) !== undefined, 60000)
          assert.strictEqual(
            finished(events, reply.entry.version.id)!.status,
            "complete",
            JSON.stringify(finished(events, reply.entry.version.id))
          )
          parent = reply.entry.slotId
          return reply
        })
        for (let i = 0; i < 3; i++) yield* run()
        // The live path edits thresholds by RPC on an existing workshop, after its prefix exists.
        yield* api.ChangeLcmSettings({ chatId: chat.id, change: thresholds })
        // Exercise ordinary between-reply planning, but drive jobs deterministically without a pool.
        const planned = yield* reader.PlanSummaries({
          userId: user.id,
          chatId: chat.id,
          leafSlotId: parent!,
          reason: "reply"
        })
        yield* writer.EnqueueSummaries({
          userId: user.id,
          chatId: chat.id,
          leafSlotId: parent!,
          chunks: planned.chunks,
          requestClass: "interactive"
        })
        for (let i = 0; i < 20; i++) {
          const job = yield* writer.ClaimSummaryJob({ userId: user.id })
          if (!job) break
          yield* server.summarizer().runJob(job)
        }
        assert.isAbove((yield* api.GetLcmState({ chatId: chat.id, leafSlotId: parent! })).layer.length, 0)
        const attachmentInput = mock.requests().some((request) => {
          if (request.body?.model !== "synthetic-summary") return false
          const messages = request.body.messages as Array<{ content?: unknown }>
          return messages.some(
            ({ content }) =>
              typeof content === "string" &&
              content.includes(attachmentOnly.entry.version.id) &&
              content.includes(attached.headRevisionId) &&
              content.includes("PINNED CARD FACT")
          )
        })
        assert.isTrue(attachmentInput, "the attachment-only turn's frozen revision reaches a leaf summary")
        const start = mock.requests().length
        const reply = yield* run()
        const sent = mock
          .requests()
          .slice(start)
          .filter((r) => Array.isArray(r.body?.tools) && r.body.tools.length > 0)
        assert.include(
          JSON.stringify(sent[0]!.body),
          "SAVED WORKSHOP MEMORY",
          "the very next request consumes the landed summary"
        )
        assert.notInclude(JSON.stringify(sent[0]!.body), "RAW OLD LOOKUP", "covered steps are omitted")
        const material = yield* reader.RolloutMaterial({ userId: user.id, versionId: reply.entry.version.id })
        const transcript = JSON.parse(material.transcript!) as AgentMessage[]
        assert.isAbove(
          activeRunSummaries(transcript).length,
          0,
          "in-run compaction honors the small recent maximum on a large model"
        )
        // The recent maximum governs recent text/steps, separately from fixed instructions/tools
        // and the summary layer. Use the same selected local counter as production, never /4.
        const snapshot = JSON.parse(material.snapshot) as ContextSnapshot & {
          agent: { tools: Array<{ deferred?: boolean }> }
        }
        assert.strictEqual(
          snapshot.agent.tools.some((t) => t.deferred),
          mode !== "every",
          "exercise the actual loading mode"
        )
        const lastSummary = activeRunSummaries(transcript).at(-1)!
        const after = liveSuffix(transcript).filter(
          (m) => m.role !== "user" || !JSON.stringify(m.content).includes("Workshop summary")
        )
        const recent = yield* reader.CountRolloutContext({
          model: JSON.stringify(snapshot.inputs.model),
          request: JSON.stringify({ ...snapshot.request, messages: [], prefill: null }),
          transcript: JSON.stringify(after),
          tools: "[]"
        })
        assert.isAtMost(recent, thresholds.recentMax)
        assert.isAbove(lastSummary.through, lastSummary.from)
        for (const req of sent) {
          const messages = req.body!.messages as Array<{
            role: string
            tool_call_id?: string
            tool_calls?: Array<{ id: string }>
          }>
          const calls = new Set<string>()
          for (const m of messages) {
            if (m.role === "tool") assert.isTrue(calls.has(m.tool_call_id!), "tool result has its call")
            for (const c of m.tool_calls ?? []) calls.add(c.id)
          }
        }
        step = 99
        const regenerated = yield* api.Regenerate({
          slotId: reply.entry.slotId,
          expectedRowVersion: reply.entry.rowVersion
        })
        yield* eventually(
          () =>
            events.some(
              (e) =>
                e._tag === "Version" &&
                e.version.id !== reply.entry.version.id &&
                e.version.status === "complete" &&
                e.version.id === regenerated.version.id
            ),
          60000
        )
        assert.isDefined(regenerated)
        assert.include(JSON.stringify(mock.requests().at(-1)!.body), "SAVED WORKSHOP MEMORY")
      }).pipe(Effect.scoped, Effect.provide(server.layer))
    },
    120000
  )

it.live(
  "ordinary RP consumes the same small-threshold summaries in its next sent request",
  () => {
    const server = lcmServer()
    return Effect.gen(function* () {
      const h = yield* lcmHarness(server, {
        messages: 12,
        message: (i) => `RP ORIGINAL ${i}: ` + Array.from({ length: 300 }, (_, n) => `word${n}`).join(" "),
        settings: { ...thresholds, enabled: true },
        summarizer: () => ({ text: "RP SUMMARY MEMORY: the synthetic journey continues." })
      })
      const plan = yield* h.reader.PlanSummaries({
        userId: h.userId,
        chatId: h.chat.id,
        leafSlotId: h.rows.at(-1)!.slotId,
        reason: "reply"
      })
      yield* h.writer.EnqueueSummaries({
        userId: h.userId,
        chatId: h.chat.id,
        leafSlotId: h.rows.at(-1)!.slotId,
        chunks: plan.chunks,
        requestClass: "interactive"
      })
      yield* h.drain
      const leaf = h.rows.at(-1)!.slotId
      assert.isAbove((yield* h.api.GetLcmState({ chatId: h.chat.id, leafSlotId: leaf })).layer.length, 0)
      const events: ChatEvent[] = []
      yield* h.api.SubscribeChat({ chatId: h.chat.id }).pipe(
        Stream.runForEach((batch) => Effect.sync(() => events.push(...batch))),
        Effect.forkScoped
      )
      yield* eventually(() => events.length > 0)
      const start = h.mock.requests().length
      const reply = yield* posted(h.api.Generate({ chatId: h.chat.id, parentSlotId: leaf, branch: false }))
      yield* eventually(() => finished(events, reply.entry.version.id) !== undefined)
      assert.strictEqual(finished(events, reply.entry.version.id)!.status, "complete")
      const sent = h.mock.requests().slice(start).at(-1)!
      assert.include(JSON.stringify(sent.body), "RP SUMMARY MEMORY")
      assert.notInclude(JSON.stringify(sent.body), "RP ORIGINAL 0:")
      const material = yield* h.reader.RolloutMaterial({ userId: h.userId, versionId: reply.entry.version.id })
      const snapshot = JSON.parse(material.snapshot) as ContextSnapshot
      assert.isAtMost(snapshot.lcm!.measure!.recentNow, thresholds.recentMax)
    }).pipe(Effect.scoped, Effect.provide(server.layer))
  },
  60000
)

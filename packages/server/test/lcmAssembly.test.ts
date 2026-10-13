import { assert, it } from "@effect/vitest"
import type { ContextSnapshot } from "../src/assembler/types.ts"
import { NewVersion } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import type { AppendResult } from "../src/db/ops.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { completeFixture, fixtureSql } from "./support/lcmFixtures.ts"
import { anthropicSse, completionChunks, sse, startMockProvider } from "./support/mockProvider.ts"
import { placeBreakpoints } from "../src/assembler/breakpoints.ts"
import { providerRequest as anthropicWire } from "../src/assembler/wire.ts"

it("prioritizes stable history, the layer, and the prefix", () => {
  assert.deepStrictEqual(
    placeBreakpoints([{ kind: "prefix" }, { kind: "summary" }, { kind: "history" }, { kind: "volatile" }]),
    [
      { message: 2, reason: "history" },
      { message: 1, reason: "summary" },
      { message: 0, reason: "prefix" }
    ]
  )
})

for (const [mode, anthropic] of [
  ["st", false],
  ["layouts", false],
  ["st", true]
] as const)
  it.live(
    `the ${mode} layer on ${anthropic ? "Anthropic" : "OpenAI"} is literal, pinned, inspected, and invalidates only its cache suffix`,
    () => {
      const config = testConfig()
      return Effect.gen(function* () {
        const mock = yield* Effect.acquireRelease(
          Effect.promise(() =>
            startMockProvider((_req, res) =>
              anthropic
                ? anthropicSse(res, [
                    {
                      type: "message_start",
                      message: {
                        id: "msg_1",
                        type: "message",
                        role: "assistant",
                        model: "mock-model",
                        content: [],
                        stop_reason: null,
                        usage: { input_tokens: 100, output_tokens: 1 }
                      }
                    },
                    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
                    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Synthetic reply." } },
                    { type: "content_block_stop", index: 0 },
                    {
                      type: "message_delta",
                      delta: { stop_reason: "end_turn", stop_sequence: null },
                      usage: { output_tokens: 4 }
                    },
                    { type: "message_stop" }
                  ])
                : sse(
                    res,
                    completionChunks(["Synthetic reply."], {
                      prompt_tokens: 100,
                      completion_tokens: 4,
                      prompt_tokens_details: { cached_tokens: 50 }
                    })
                  )
            )
          ),
          (m) => Effect.promise(() => m.close())
        )
        const api = yield* client(),
          writer = yield* Writer,
          reader = yield* Reader,
          user = yield* api.Whoami()
        const { chat, events } = yield* generateReply(api, {
          connection: anthropic
            ? { kind: "anthropic", baseUrl: mock.url, apiKey: "sk-ant-synthetic-test", cacheTtlS: 300 }
            : { kind: "openai-chat", baseUrl: `${mock.url}/v1`, cacheTtlS: 300 },
          model: { cacheBreakpoints: "explicit" },
          preset: { use_sysprompt: true }
        })
        if (mode === "layouts")
          yield* writer.AddStateEvent({
            userId: user.id,
            chatId: chat.id,
            slotId: null,
            versionId: null,
            scope: null,
            data: { key: "layout.cards", value: "concat" }
          })
        const path = yield* reader.GetPath({ userId: user.id, chatId: chat.id, leafSlotId: null, limit: 100 })
        const first = path.entries[0]!,
          second = path.entries[1]!
        let summary = yield* completeFixture(
          config.dataDir,
          writer,
          user.id,
          chat.id,
          [first, second].map((e) => ({ slotId: e.slotId, versionId: e.version.id, amendCount: 0 }))
        )
        summary = (yield* api.EditSummary({
          summaryId: summary.id,
          content: "{{incvar::never}} stays literal.",
          expectedRowVersion: summary.rowVersion,
          commitDraft: null
        })).summary
        const sent = yield* posted(
          api.SendMessage({
            chatId: chat.id,
            parentSlotId: path.entries.at(-1)!.slotId,
            branch: false,
            content: "Continue."
          })
        )
        const reply = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: sent.entry.slotId, branch: false }))
        yield* eventually(() => finished(events, reply.entry.version.id) !== undefined)
        const [rows] = yield* fixtureSql(config.dataDir, [
          {
            sql: "SELECT p.context_snapshot_json AS snapshot FROM versions v JOIN rollout_payloads p ON p.rollout_id=v.rollout_id WHERE v.id=?",
            params: [reply.entry.version.id]
          }
        ])
        const json = rows![0]!.snapshot as string,
          snapshot = JSON.parse(json) as ContextSnapshot
        assert.strictEqual(snapshot.assemblerVersion, 10)
        assert.strictEqual(snapshot.lcm!.cursor, second.slotId)
        assert.deepStrictEqual(
          snapshot.lcm!.selected.map((s) => s.id),
          [summary.id]
        )
        assert.isTrue(snapshot.request.messages.some((m) => m.content.includes("{{incvar::never}} stays literal.")))
        assert.isFalse(snapshot.effects.some((e) => e.name === "never"))
        if (mode === "layouts")
          assert.isTrue(
            snapshot.request.messages.some((m) => m.content.includes('<summary level="1" from="1" to="2">'))
          )
        assert.isTrue(snapshot.request.breakpoints.some((b) => b.reason === "summary"))
        const display = yield* api.GetRunContext({ versionId: reply.entry.version.id })
        const sources = display.messages.flatMap((m) => m.sources).filter((s) => s.kind === "summary")
        assert.isTrue(sources.some((s) => s.label === "Summary, level 1, messages 1–2, revision 2"))
        assert.isTrue(sources.every((s) => s.summary?.changed === false))
        assert.isTrue(
          display.messages.some(
            (m) => m.content.includes("{{incvar::never}}") && m.sources.some((s) => s.kind === "summary")
          )
        )
        if (anthropic) {
          const payload = mock.requests().at(-1)!.body as {
            system: Array<{ text: string }>
            messages: Array<{ content: Array<{ text?: string; cache_control?: unknown }> }>
          }
          assert.isFalse(payload.system.some((b) => b.text.includes("{{incvar::never}}")))
          assert.isTrue(
            payload.messages.some((m) =>
              m.content.some((b) => b.text?.includes("{{incvar::never}}") && b.cache_control)
            )
          )
        }
        const wire = anthropicWire(snapshot.request, {
          ...snapshot.inputs.model!,
          api: "anthropic-messages",
          kind: "anthropic",
          cacheBreakpoints: "explicit"
        })
        assert.isFalse(wire.context.systemPrompt?.includes("{{incvar::never}}") ?? false)
        assert.isTrue(wire.breakpoints.length >= 2)
        const warm = yield* reader.CacheWarmth({ userId: user.id, chatId: chat.id })
        assert.isNull(warm?.changed)
        const changed = yield* api.EditSummary({
          summaryId: summary.id,
          content: "The summary was replaced.",
          expectedRowVersion: summary.rowVersion,
          commitDraft: null
        })
        assert.strictEqual(changed.summary.revisionNumber, 3)
        const cold = yield* reader.CacheWarmth({ userId: user.id, chatId: chat.id })
        assert.include(cold!.changed!.reason, "Summary")
        assert.isAbove(cold!.changed!.tokens, 0)
        assert.isTrue(
          (yield* api.GetRunContext({ versionId: reply.entry.version.id })).messages
            .flatMap((m) => m.sources)
            .some((s) => s.summary?.changed)
        )
        const bin = yield* writer.DeleteMessage({ userId: user.id, slotId: first.slotId })
        yield* writer.PurgeBinItem({ userId: user.id, itemId: bin.id })
        const rebuilt = yield* reader.RebuildContext({ userId: user.id, snapshot: json })
        assert.ok(rebuilt._tag === "Rebuilt")
        assert.deepStrictEqual(JSON.parse(rebuilt.snapshot), snapshot)
      }).pipe(Effect.provide(serverLayer(config)))
    },
    { timeout: 120_000 }
  )

it.live(
  "coverage waits for a continuous prefix, prefers freshness over level, and leaves failed ranges raw",
  () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client(),
        writer = yield* Writer,
        reader = yield* Reader,
        user = yield* api.Whoami()
      const chat = yield* writer.CreateChat({
        userId: user.id,
        kind: "rp",
        status: "active",
        title: "Coverage",
        participants: [],
        greeting: null
      })
      const entries: Array<AppendResult> = []
      let tip: import("@rp/shared/chat.ts").SlotId | null = null
      for (const content of ["a", "b", "c", "target"]) {
        const entry: import("../src/db/ops.ts").AppendResult = yield* writer.AppendMessage({
          userId: user.id,
          chatId: chat.id,
          parentSlotId: tip,
          branch: false,
          version: new NewVersion({
            speakerEntityId: null,
            writer: "human",
            content,
            status: "complete",
            origin: "user_written",
            macroMode: "verbatim"
          }),
          commitDraft: null
        })
        entries.push(entry)
        tip = entry.slotId
      }
      const inputs = (start: number, end: number) =>
        entries.slice(start, end).map((e) => ({ slotId: e.slotId, versionId: e.version.id, amendCount: 0 }))
      const assemble = () =>
        reader
          .AssembleContext({
            userId: user.id,
            chatId: chat.id,
            slotId: entries[3]!.slotId,
            versionId: entries[3]!.version.id,
            now: 1,
            timeZone: "UTC",
            frozen: null
          })
          .pipe(Effect.map(({ snapshot }) => JSON.parse(snapshot) as ContextSnapshot))
      for (const position of [
        { slotId: entries[0]!.slotId, versionId: null, scope: null },
        { slotId: null, versionId: entries[0]!.version.id, scope: null },
        { slotId: null, versionId: null, scope: "narrator" as const }
      ]) {
        const error = yield* writer
          .AddStateEvent({
            userId: user.id,
            chatId: chat.id,
            ...position,
            data: { key: "lcm.settings", value: { enabled: false } }
          })
          .pipe(Effect.flip)
        assert.strictEqual(error._tag, "NotFound")
      }
      const right = yield* completeFixture(config.dataDir, writer, user.id, chat.id, inputs(2, 3))
      assert.deepStrictEqual((yield* assemble()).lcm!.selected, [])
      const left = yield* completeFixture(config.dataDir, writer, user.id, chat.id, inputs(0, 2))
      const boundary = JSON.parse(
        (yield* reader.AssembleContext({
          userId: user.id,
          chatId: chat.id,
          slotId: entries[2]!.slotId,
          versionId: entries[2]!.version.id,
          now: 1,
          timeZone: "UTC",
          frozen: null
        })).snapshot
      ) as ContextSnapshot
      assert.isFalse(boundary.pieces.some((p) => p.source.kind === "message" && p.messages.length > 0))
      assert.isNull(boundary.lcm!.verbatim)
      const parent = yield* completeFixture(config.dataDir, writer, user.id, chat.id, [], [left, right])
      assert.deepStrictEqual(
        (yield* assemble()).lcm!.selected.map((s) => s.id),
        [parent.id]
      )
      yield* api.EditSummary({ summaryId: left.id, content: "User revision", expectedRowVersion: 1, commitDraft: null })
      assert.deepStrictEqual(
        (yield* assemble()).lcm!.selected.map((s) => s.id),
        [left.id, right.id]
      )
      const invalid = yield* writer.AddStateEvent({
        userId: user.id,
        chatId: chat.id,
        slotId: null,
        versionId: null,
        scope: null,
        data: { key: "lcm.settings", value: { enabled: false } }
      })
      assert.ok(invalid.id)
      assert.isUndefined((yield* assemble()).lcm)
    }).pipe(Effect.provide(serverLayer(config)))
  },
  { timeout: 60_000 }
)

it.live(
  "failed summaries do not replace originals while the window fits",
  () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client(),
        user = yield* api.Whoami(),
        writer = yield* Writer,
        reader = yield* Reader
      const chat = yield* writer.CreateChat({
        userId: user.id,
        kind: "rp",
        status: "active",
        title: "Failure",
        participants: [],
        greeting: null
      })
      const version = (content: string) =>
        new NewVersion({
          speakerEntityId: null,
          writer: "human",
          content,
          status: "complete",
          origin: "user_written",
          macroMode: "verbatim"
        })
      const first = yield* writer.AppendMessage({
        userId: user.id,
        chatId: chat.id,
        parentSlotId: null,
        branch: false,
        version: version("Original text"),
        commitDraft: null
      })
      const target = yield* writer.AppendMessage({
        userId: user.id,
        chatId: chat.id,
        parentSlotId: first.slotId,
        branch: false,
        version: version("target"),
        commitDraft: null
      })
      yield* fixtureSql(config.dataDir, [
        {
          sql: "INSERT INTO summary_revisions(id,summary_id,content,token_count,origin,created_at) VALUES('failed-revision','failed-summary','',0,'generated',1)"
        },
        {
          sql: "INSERT INTO summaries(id,chat_id,level,selected_revision_id,first_slot_id,last_slot_id,slot_count,status,error_json,created_at) VALUES('failed-summary',?,1,'failed-revision',?,?,1,'failed','{}',1)",
          params: [chat.id, first.slotId, first.slotId]
        },
        {
          sql: "INSERT INTO summary_inputs(summary_id,ordinal,slot_id,version_id) VALUES('failed-summary',0,?,?)",
          params: [first.slotId, first.version.id]
        }
      ])
      const { snapshot: json } = yield* reader.AssembleContext({
        userId: user.id,
        chatId: chat.id,
        slotId: target.slotId,
        versionId: target.version.id,
        now: 1,
        timeZone: "UTC",
        frozen: null
      })
      const snapshot = JSON.parse(json) as ContextSnapshot
      assert.deepStrictEqual(snapshot.lcm!.selected, [])
      assert.isTrue(snapshot.request.messages.some((m) => m.content.includes("Original text")))
    }).pipe(Effect.provide(serverLayer(config)))
  },
  { timeout: 60_000 }
)

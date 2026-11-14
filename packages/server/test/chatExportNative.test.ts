// Actual locally generated versions use the ledger, not imported-generation fields.
// A loopback synthetic responder is the only transport; no external provider is called.
import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { client, post, serverLayer, testConfig } from "./support/config.ts"
import { generateReply } from "./support/generation.ts"
import { completionChunks, sse, startMockProvider } from "./support/mockProvider.ts"

layer(serverLayer(testConfig()), { excludeTestServices: true, timeout: "120 seconds" })(
  "native generation export",
  (it) => {
    it.effect("exports ledger tokens and actual times for an unswiped reply and an unselected swipe", () =>
      Effect.gen(function* () {
        const mock = yield* Effect.acquireRelease(
          Effect.promise(() =>
            startMockProvider((_request, response) =>
              sse(response, completionChunks(["Synthetic native reply."], { prompt_tokens: 15, completion_tokens: 12 }))
            )
          ),
          (m) => Effect.promise(() => m.close())
        )
        const api = yield* client()
        const { chat, version } = yield* generateReply(api, {
          connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
          model: {}
        })
        assert.isUndefined(version.recorded)
        const metrics = (yield* api.GetVersionMetrics({ versionIds: [version.id] }))[0]!
        assert.strictEqual(metrics.output, 12)
        assert.isNotNull(metrics.last.endedAt)
        const download = () =>
          Effect.gen(function* () {
            const response = yield* post("/library/chat-export", {
              chatId: chat.id,
              forkId: null,
              scope: "branch",
              format: "jsonl"
            })
            assert.strictEqual(response.status, 200)
            return (yield* Effect.promise(() => response.text()))
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line))
          })
        const lines = yield* download()
        const reply = lines.find((line) => line.mes === "Synthetic native reply.")!
        assert.strictEqual(reply.extra.token_count, 12)
        assert.strictEqual(Date.parse(reply.gen_started), metrics.last.startedAt)
        assert.strictEqual(Date.parse(reply.gen_finished), metrics.last.endedAt)
        if (metrics.last.firstTokenAt !== null)
          assert.strictEqual(reply.extra.time_to_first_token, metrics.last.firstTokenAt - metrics.last.startedAt)
        const page = yield* api.ReadPath({
          chatId: chat.id,
          forkId: null,
          leafSlotId: null,
          range: { _tag: "Bottom" },
          limit: 100
        })
        const entry = page.entries.find((e) => e.version.id === version.id)!
        yield* api.WriteVersion({
          slotId: entry.slotId,
          content: "A human alternative.",
          expectedRowVersion: entry.rowVersion
        })
        const changed = (yield* download()).find((line) => line.mes === "A human alternative.")!
        assert.strictEqual(changed.swipe_id, 1)
        assert.strictEqual(changed.swipe_info[0].extra.token_count, 12)
        assert.strictEqual(Date.parse(changed.swipe_info[0].gen_started), metrics.last.startedAt)
        assert.isUndefined(changed.extra.token_count)
      })
    )
  }
)

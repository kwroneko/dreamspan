// This fixture also runs unchanged on job/review-workshop2. The report compares its
// normalized serialized requests and complete chat/rollout rows across both builds.
import { assert, it } from "@effect/vitest"
import { writeFileSync } from "node:fs"
import { Effect } from "effect"
import { Reader } from "../src/db/Database.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { generateReply } from "./support/generation.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { sse, startMockProvider } from "./support/mockProvider.ts"

it.live("keeps story requests and persisted rows identical to the single-message contract", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    const mock = yield* Effect.acquireRelease(
      Effect.promise(() =>
        startMockProvider((_request, res) =>
          sse(res, [
            {
              id: "parity",
              object: "chat.completion.chunk",
              model: "mock-model",
              choices: [
                {
                  index: 0,
                  delta: {
                    role: "assistant",
                    tool_calls: ["First story reply.", "Must never post."].map((message, index) => ({
                      index,
                      id: `story_${index}`,
                      type: "function",
                      function: { name: "send_message", arguments: JSON.stringify({ message }) }
                    }))
                  },
                  finish_reason: null
                }
              ]
            },
            {
              id: "parity",
              object: "chat.completion.chunk",
              model: "mock-model",
              choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }]
            }
          ])
        )
      ),
      (mock) => Effect.promise(() => mock.close())
    )
    const api = yield* client()
    const result = yield* generateReply(api, {
      connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
      model: {},
      state: [
        { key: "agent.enabled", value: { on: true } },
        { key: "agent.tools", value: { tools: [] } }
      ]
    })
    assert.strictEqual(result.version.content, "First story reply.")
    assert.strictEqual(result.version.status, "complete")
    assert.lengthOf(
      mock.requests().filter((r) => r.path === "/v1/chat/completions"),
      1
    )
    const user = yield* api.Whoami()
    const material = yield* (yield* Reader).RolloutMaterial({ userId: user.id, versionId: result.version.id })
    // A story's default contract is the send tool alone since replycontract2 (spec/REPLY-CONTRACT.md §3.1).
    assert.strictEqual(JSON.parse(material.snapshot).agent.contract, "send_message")
    assert.isUndefined(JSON.parse(material.snapshot).continuity)
    const tables = [
      { sql: "SELECT * FROM slots WHERE chat_id = ? ORDER BY depth", params: [result.chat.id] },
      {
        sql: "SELECT v.* FROM versions v JOIN slots s ON s.id = v.slot_id WHERE s.chat_id = ? ORDER BY s.depth, v.ordinal",
        params: [result.chat.id]
      },
      {
        sql: "SELECT t.* FROM version_texts t JOIN versions v ON v.seq = t.version_seq JOIN slots s ON s.id = v.slot_id WHERE s.chat_id = ? ORDER BY s.depth, v.ordinal",
        params: [result.chat.id]
      },
      { sql: "SELECT * FROM rollouts WHERE chat_id = ? ORDER BY created_at, id", params: [result.chat.id] },
      {
        sql: "SELECT p.* FROM rollout_payloads p JOIN rollouts r ON r.id = p.rollout_id WHERE r.chat_id = ? ORDER BY r.created_at, r.id",
        params: [result.chat.id]
      },
      { sql: "SELECT e.* FROM state_events e WHERE chat_id = ? ORDER BY seq", params: [result.chat.id] }
    ]
    const rows = yield* fixtureSql(config.dataDir, tables, { readOnly: true })
    assert.lengthOf(rows[0]!, 3)
    assert.lengthOf(rows[1]!, 3)
    assert.lengthOf(rows[3]!, 1)
    assert.strictEqual(rows[3]![0]!.parent_rollout_id, null)
    const request = mock.requests().find((r) => r.path === "/v1/chat/completions")!.body!
    assert.deepStrictEqual(request.messages, JSON.parse(material.snapshot).request.messages)
    if (process.env.WORKSHOP_PARITY_OUTPUT) {
      // Only generated identities (including derived identity hashes), clocks and durations differ between independent runs.
      const ids = new Map<string, string>()
      const derived = new Map<string, string>()
      const normalize = (value: unknown, key = ""): unknown => {
        if (typeof value === "string") {
          if ((key === "configuration" || key === "id" || key === "source") && /^[0-9a-f]{64}$/.test(value)) {
            if (!derived.has(value)) derived.set(value, `derived-id-${derived.size + 1}`)
            return derived.get(value)!
          }
          if (/^[{[]/.test(value)) {
            try {
              return normalize(JSON.parse(value), key)
            } catch {
              /* ordinary text */
            }
          }
          return value.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (id) => {
            if (!ids.has(id)) ids.set(id, `id-${ids.size + 1}`)
            return ids.get(id)!
          })
        }
        if (typeof value === "number" && (/(?:_at|At)$/.test(key) || ["now", "timestamp", "ms"].includes(key))) return 0
        if (Array.isArray(value)) return value.map((part) => normalize(part))
        if (value && typeof value === "object")
          return Object.fromEntries(
            Object.entries(value).map(([name, part]) => [
              name.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (id) => {
                if (!ids.has(id)) ids.set(id, `id-${ids.size + 1}`)
                return ids.get(id)!
              }),
              normalize(part, name)
            ])
          )
        return value
      }
      writeFileSync(process.env.WORKSHOP_PARITY_OUTPUT, JSON.stringify(normalize({ request, rows }), null, 2))
    }
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
})

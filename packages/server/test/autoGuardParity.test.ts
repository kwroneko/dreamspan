// Stable synthetic wire catalogue, also runnable unchanged on master for a byte comparison.
import { readFileSync, writeFileSync } from "node:fs"
import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import type { StateEventData } from "@rp/shared/state.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { generateReply } from "./support/generation.ts"
import { completionChunks, sse, startMockProvider } from "./support/mockProvider.ts"

it.live(
  "ordinary sends retain the master request catalogue",
  () =>
    Effect.gen(function* () {
      const requests: Record<string, unknown> = {}
      for (const [name, state] of Object.entries({
        plain: [],
        separate: [{ key: "context.per_speaker", value: "separate" }],
        // An agent reply answered in plain text: the contract that takes it, so its requests stay
        // the master catalogue's (the send tool, the default since replycontract2, would nudge it).
        tools: [
          { key: "agent.enabled", value: { on: true } },
          { key: "agent.tools", value: { tools: [] } },
          { key: "output.contract", value: "both" }
        ],
        direction: [{ key: "context.per_speaker", value: "shared" }]
      } satisfies Record<string, ReadonlyArray<StateEventData>>)) {
        yield* Effect.gen(function* () {
          const mock = yield* Effect.acquireRelease(
            Effect.promise(() =>
              startMockProvider((_request, response) =>
                sse(
                  response,
                  completionChunks(["A synthetic ordinary reply."], { prompt_tokens: 80, completion_tokens: 3 })
                )
              )
            ),
            (mock) => Effect.promise(() => mock.close())
          )
          const api = yield* client()
          const made = yield* generateReply(api, {
            connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
            model: {},
            characters: ["Wren", "Pell"],
            state,
            ...(name === "direction" ? { preset: { main_prompt: "Write the synthetic scene carefully." } } : {})
          })
          assert.strictEqual(made.version.status, "complete")
          requests[name] = mock
            .requests()
            .filter((request) => request.path === "/v1/chat/completions")
            .map((request) => request.raw)
        }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
      }
      if (process.env.AUTO_GUARD_PARITY_OUT)
        writeFileSync(process.env.AUTO_GUARD_PARITY_OUT, JSON.stringify(requests, null, 2) + "\n")
      if (process.env.AUTO_GUARD_PARITY_EXPECT)
        assert.deepStrictEqual(requests, JSON.parse(readFileSync(process.env.AUTO_GUARD_PARITY_EXPECT, "utf8")))
    }),
  120_000
)

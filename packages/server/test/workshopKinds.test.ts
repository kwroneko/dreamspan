import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema, Stream } from "effect"
import { ChatKind } from "@rp/shared/chat.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { StateModules } from "../src/db/stateModules.ts"
import { ExecutionRegistry } from "../src/execution.ts"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { completionChunks, sse, startMockProvider } from "./support/mockProvider.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"

for (const workers of ["source", "bundle"] as const) {
  describe(`chat kind profiles in ${workers} workers`, () => {
    it.live("round-trips a plugin kind, replaces its planner and attributes its turn through the profile", () => {
      const config = testConfig({ dbWorkers: workers })
      return Effect.gen(function* () {
        assert.isTrue(Schema.is(ChatKind)("review/assistant"))
        const modules = yield* StateModules
        yield* modules.register({
          id: "review/chat-kind",
          module: new URL("./support/chatKindPlugin.ts", import.meta.url).href,
          exportName: "install"
        })
        const registry = yield* ExecutionRegistry
        const original = registry.orchestrationModes.get("workshop")!
        yield* registry.orchestrationModes.register({
          ...original,
          plan: (input) => ({
            ...original.plan(input),
            tools: [],
            assembly: { instructions: () => `Custom planner for ${input.kind}.`, speakerCardOnly: false }
          })
        })
        const mock = yield* Effect.acquireRelease(
          Effect.promise(() => startMockProvider((_request, res) => sse(res, completionChunks(["Custom reply."], {})))),
          (m) => Effect.promise(() => m.close())
        )
        const api = yield* client()
        yield* generateReply(api, { connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` }, model: {} })
        const user = yield* api.Whoami()
        const chat = yield* (yield* Writer).CreateChat({
          userId: user.id,
          kind: "review/assistant",
          status: "active",
          title: "Plugin chat",
          participants: [],
          greeting: null
        })
        assert.strictEqual((yield* api.GetChat({ chatId: chat.id })).kind, "review/assistant")
        const events: Array<import("@rp/shared/chatApi.ts").ChatEvent> = []
        yield* api.SubscribeChat({ chatId: chat.id }).pipe(
          Stream.runForEach((batch) => Effect.sync(() => events.push(...batch))),
          Effect.forkScoped
        )
        yield* eventually(() => events.length > 0)
        const sent = yield* posted(
          api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "Synthetic request." })
        )
        const generated = yield* posted(
          api.Generate({ chatId: chat.id, parentSlotId: sent.entry.slotId, branch: false })
        )
        yield* eventually(() => finished(events, generated.entry.version.id) !== undefined)
        assert.strictEqual(finished(events, generated.entry.version.id)!.content, "Custom reply.")
        const body = mock
          .requests()
          .filter((r) => r.path === "/v1/chat/completions")
          .at(-1)!.body!
        assert.include(JSON.stringify(body.messages), "Custom planner for review/assistant.")
        const [rows] = yield* fixtureSql(
          config.dataDir,
          [
            {
              sql: "SELECT r.kind, q.purpose FROM rollouts r JOIN llm_requests q ON q.rollout_id = r.id WHERE r.chat_id = ?",
              params: [chat.id]
            }
          ],
          { readOnly: true }
        )
        assert.deepStrictEqual(rows, [{ kind: "workshop", purpose: "workshop" }])
        assert.isEmpty((yield* (yield* Reader).ListActivity({ userId: user.id, chatId: chat.id, limit: 20 })).rows)
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    })
  })
}

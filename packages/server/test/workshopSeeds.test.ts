import { assert, describe, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { newCardDoc } from "@rp/shared/editing.ts"
import { foldState } from "@rp/shared/state.ts"
import type { ChatEvent } from "@rp/shared/chatApi.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { completionChunks, sse, startMockProvider } from "./support/mockProvider.ts"

describe("workshop seed lifecycle", () => {
  it.live(
    "serializes concurrent seeding, reuses archived seeds and keeps older workshops usable after seed deletion",
    () => {
      const config = testConfig()
      return Effect.gen(function* () {
        const api = yield* client()
        const user = yield* api.Whoami()
        const writer = yield* Writer
        const reader = yield* Reader
        const chats = yield* Effect.all(
          Array.from({ length: 8 }, () => api.CreateWorkshop({})),
          { concurrency: 8 }
        )
        const card = (yield* api.ListLibrary({ kind: "card" }))[0]!
        const preset = (yield* api.ListLibrary({ kind: "preset" }))[0]!
        assert.lengthOf(yield* api.ListLibrary({ kind: "card" }), 1)
        assert.lengthOf(yield* api.ListLibrary({ kind: "preset" }), 1)
        const stateOf = (chat: (typeof chats)[number]) =>
          reader
            .StateEventsAt({ userId: user.id, chatId: chat.id, slotId: chat.activeLeafSlotId })
            .pipe(Effect.map(foldState))
        for (const chat of chats) {
          const state = yield* stateOf(chat)
          assert.deepStrictEqual(state.participants, [card.entityId])
          assert.strictEqual(state.presetBindings[""]?.ref, preset.id)
        }
        for (const ref of [card, preset]) yield* api.SetRefArchived({ refId: ref.id, archived: true })
        const archived = yield* api.CreateWorkshop({})
        assert.deepStrictEqual((yield* stateOf(archived)).participants, [card.entityId])
        assert.strictEqual((yield* stateOf(archived)).presetBindings[""]?.ref, preset.id)
        for (const kind of ["card", "preset"] as const)
          assert.lengthOf(yield* api.ListLibrary({ kind, archived: true }), 1)
        for (const ref of [card, preset]) yield* writer.DeleteEntity({ userId: user.id, entityId: ref.entityId })
        const replacement = yield* api.CreateWorkshop({})
        const newCard = (yield* api.ListLibrary({ kind: "card" }))[0]!
        const newPreset = (yield* api.ListLibrary({ kind: "preset" }))[0]!
        assert.notStrictEqual(newCard.entityId, card.entityId)
        assert.notStrictEqual(newPreset.id, preset.id)
        const mock = yield* Effect.acquireRelease(
          Effect.promise(() => startMockProvider((_request, res) => sse(res, completionChunks(["Still usable."], {})))),
          (m) => Effect.promise(() => m.close())
        )
        yield* generateReply(api, { connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` }, model: {} })
        for (const chat of [chats[0]!, replacement]) {
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
              content: "Synthetic request after deleting seeds."
            })
          )
          const reply = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: sent.entry.slotId, branch: false }))
          yield* eventually(() => finished(events, reply.entry.version.id) !== undefined)
          assert.strictEqual(finished(events, reply.entry.version.id)!.content, "Still usable.")
        }
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    }
  )
  it.live("bounds library tool results and excludes stored connection secrets", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((request, res) => {
            const messages = request.body?.messages as Array<{ role: string; content: string }>
            const workshop = JSON.stringify(messages).includes("workshop assistant")
            if (!workshop || messages.at(-1)?.role === "tool") return sse(res, completionChunks(["Ready."], {}))
            sse(res, [
              {
                id: "cmpl-budget",
                object: "chat.completion.chunk",
                model: "mock-model",
                choices: [
                  {
                    index: 0,
                    delta: {
                      role: "assistant",
                      tool_calls: [
                        {
                          index: 0,
                          id: "budget-call",
                          type: "function",
                          function: { name: "read_card", arguments: JSON.stringify({ card: "Large synthetic card" }) }
                        }
                      ]
                    },
                    finish_reason: null
                  }
                ]
              },
              {
                id: "cmpl-budget",
                object: "chat.completion.chunk",
                model: "mock-model",
                choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }]
              }
            ])
          })
        ),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1`, apiKey: "synthetic-connection-secret" },
        model: {}
      })
      const user = yield* api.Whoami()
      yield* (yield* Writer).CreateEntity({
        userId: user.id,
        kind: "card",
        label: "Large synthetic card",
        subtitle: "",
        doc: { ...newCardDoc("Large synthetic card"), description: "Synthetic text. ".repeat(2000) },
        schemaVersion: 1,
        origin: "user",
        sourcePath: null
      })
      const chat = yield* api.CreateWorkshop({})
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
          content: "Read the large synthetic card."
        })
      )
      const generated = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: sent.entry.slotId, branch: false }))
      yield* eventually(() => finished(events, generated.entry.version.id) !== undefined)
      const transcript = yield* api.GetRunTranscript({ versionId: generated.entry.version.id })
      const result = transcript.entries.find((entry) => entry.role === "toolResult")!
      assert.include(result.text, "Result cut at 16000 characters")
      assert.isAtMost(result.text.length, 16_120)
      assert.notInclude(JSON.stringify(transcript), "synthetic-connection-secret")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})

// Cross-build probe: raw provider requests and outcomes of a standalone workshop rewrite
// and a character agent run. Only generated ids and clocks are normalized.
import { assert, it } from "@effect/vitest"
import { writeFileSync } from "node:fs"
import { Effect, Stream } from "effect"
import type { ChatEvent } from "@dreamspan/shared/chatApi.ts"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { completionChunks, sse, startMockProvider } from "./support/mockProvider.ts"

const call = (name: string, args: unknown, id: string) => [
  {
    id: "cmpl-tool",
    object: "chat.completion.chunk",
    model: "mock",
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
  {
    id: "cmpl-tool",
    object: "chat.completion.chunk",
    model: "mock",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }]
  }
]

it.live("keeps standalone workshop and character requests stable across story-position fixes", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    let story = ""
    const mock = yield* Effect.acquireRelease(
      Effect.promise(() =>
        startMockProvider((request, res) => {
          const messages = (request.body?.messages ?? []) as Array<{ role: string }>
          const tools = (request.body?.tools ?? []) as Array<{ function: { name: string } }>
          if (!tools.some((t) => t.function.name === "rewrite_messages"))
            return sse(res, completionChunks(["Story reply."], {}))
          sse(
            res,
            messages.some((m) => m.role === "tool")
              ? completionChunks(["Rewrote it."], {})
              : call(
                  "rewrite_messages",
                  { chat: story, title: "Probe", messages: [{ message: 1, text: "PROBE TEXT" }] },
                  "probe-call"
                )
          )
        })
      ),
      (m) => Effect.promise(() => m.close())
    )
    const api = yield* client()
    const character = yield* generateReply(api, {
      // The mock distinguishes workshop requests by their direct rewrite_messages declaration.
      connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1`, providerSettings: { toolLoading: "every" } },
      model: {},
      state: [{ key: "agent.enabled", value: { on: true } }]
    })
    story = character.chat.id
    const workshop = yield* api.CreateWorkshop({})
    yield* api.SetWorkshopGrant({ chatId: workshop.id, capability: "chats.rewrite", mode: "allow" })
    const events: Array<ChatEvent> = []
    yield* api.SubscribeChat({ chatId: workshop.id }).pipe(
      Stream.runForEach((batch) => Effect.sync(() => events.push(...batch))),
      Effect.forkScoped
    )
    yield* eventually(() => events.length > 0)
    const sent = yield* posted(
      api.SendMessage({
        chatId: workshop.id,
        parentSlotId: workshop.activeLeafSlotId,
        branch: false,
        content: "Rewrite it."
      })
    )
    const generated = yield* posted(
      api.Generate({ chatId: workshop.id, parentSlotId: sent.entry.slotId, branch: false })
    )
    yield* eventually(() => finished(events, generated.entry.version.id) !== undefined)
    const path = yield* api.ReadPath({ chatId: story, leafSlotId: null, range: { _tag: "Bottom" }, limit: 20 } as never)
    const effects = yield* api.ListRolloutEffects({ chatId: workshop.id })
    assert.isAbove(effects.length, 0)
    const ids = new Map<string, string>()
    const normalize = (value: unknown, key = ""): unknown => {
      if (typeof value === "string")
        return value.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (id) => {
          if (!ids.has(id)) ids.set(id, `id-${ids.size + 1}`)
          return ids.get(id)!
        })
      if (typeof value === "number" && (/(?:_at|At)$/.test(key) || ["now", "timestamp"].includes(key))) return 0
      if (Array.isArray(value)) return value.map((part) => normalize(part))
      if (value && typeof value === "object")
        return Object.fromEntries(Object.entries(value).map(([name, part]) => [name, normalize(part, name)]))
      return value
    }
    const out = {
      requests: mock
        .requests()
        .filter((r) => r.path === "/v1/chat/completions")
        .map((r) => r.body),
      story: (path as unknown as { entries: Array<{ version: { content: string } }> }).entries.map(
        (e) => e.version.content
      ),
      effects: effects.map((e) => ({ title: e.title, kind: e.kind }))
    }
    if (process.env.WORKSHOP_POSITION_PARITY_OUTPUT)
      writeFileSync(process.env.WORKSHOP_POSITION_PARITY_OUTPUT, JSON.stringify(normalize(out), null, 2))
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
})

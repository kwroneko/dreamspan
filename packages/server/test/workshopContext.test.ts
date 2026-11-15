import { toolData } from "../src/agent/toolData.ts"
// Workshop context sizing and long runs (spec/WORKSHOP-CONTEXT.md §1, §2, §3): the window and
// the reply reserve come from the model, a carried run leaves older tool results out before it
// is rebuilt, read_run shows them again, and the history tools never see later messages.
// Synthetic cards and a scripted provider only.
import { assert, describe, it } from "@effect/vitest"
import type { ChatEvent } from "@rp/shared/chatApi.ts"
import type { Chat, VersionId } from "@rp/shared/chat.ts"
import type { ModelOverrides } from "@rp/shared/providers.ts"
import { Effect, Stream } from "effect"
import { Reader } from "../src/db/Database.ts"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"
import { eventually, finished } from "./support/generation.ts"
import { completionChunks, sse, startMockProvider } from "./support/mockProvider.ts"

type Api = Effect.Success<ReturnType<typeof client>>
type Wire = { role: string; content?: unknown; tool_call_id?: string }

const call = (name: string, args: unknown, id: string) => [
  {
    id: "ctx",
    object: "chat.completion.chunk",
    model: "mock-model",
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
    id: "ctx",
    object: "chat.completion.chunk",
    model: "mock-model",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }]
  }
]

const text = (content: unknown) => (typeof content === "string" ? content : JSON.stringify(content ?? ""))
/** The latest user message and the tool results after it: which turn, how far along. */
const turnOf = (messages: ReadonlyArray<Wire>) => {
  // The preset's closing instruction is a user message too; the user's own is the one before it.
  const last = messages.findLastIndex((m) => m.role === "user" && !text(m.content).startsWith("[Write"))
  return {
    user: last < 0 ? "" : text(messages[last]!.content),
    results: messages.slice(last + 1).filter((m) => m.role === "tool")
  }
}

/** A connection and a model with these capabilities, set as the account's model: no fixture samplers. */
const useModel = (api: Api, baseUrl: string, overrides: ModelOverrides) =>
  Effect.gen(function* () {
    const connection = yield* api.CreateConnection({
      kind: "openai-chat",
      settings: {
        name: "Mock",
        baseUrl,
        compat: {},
        cacheTtlS: null,
        maxConcurrent: null,
        presetOverrideRefId: null
      }
    })
    const model = yield* api.AddUserModel({ connectionId: connection.id, key: "mock-model", overrides })
    yield* api.ChangeGenerationDefaults({ change: { model: { connection: connection.id, model: model.id } } })
    return { connection, model }
  })

const watch = (api: Api, chat: Chat) =>
  Effect.gen(function* () {
    const events: Array<ChatEvent> = []
    yield* api.SubscribeChat({ chatId: chat.id }).pipe(
      Stream.runForEach((batch) => Effect.sync(() => events.push(...batch))),
      Effect.forkScoped
    )
    yield* eventually(() => events.length > 0)
    return events
  })

/** Sends `content` below the leaf and waits for the reply to finish. */
const turn = (api: Api, chat: Chat, events: ReadonlyArray<ChatEvent>, content: string) =>
  Effect.gen(function* () {
    const current = yield* api.GetChat({ chatId: chat.id })
    const sent = yield* posted(
      api.SendMessage({ chatId: chat.id, parentSlotId: current.activeLeafSlotId, branch: false, content })
    )
    const reply = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: sent.entry.slotId, branch: false }))
    yield* eventually(() => finished(events, reply.entry.version.id) !== undefined, 60_000)
    assert.strictEqual(finished(events, reply.entry.version.id)!.status, "complete")
    return { sent, reply, id: reply.entry.version.id as VersionId }
  })

const budgetOf = (api: Api, versionId: VersionId) =>
  Effect.gen(function* () {
    const me = yield* api.Whoami()
    const material = yield* (yield* Reader).RolloutMaterial({ userId: me.id, versionId })
    return (JSON.parse(material.snapshot) as { contextBudget: { maximum: number; responseReserve: number } })
      .contextBudget
  })

/** Varied synthetic words, so a tokenizer can't fold them away. */
const filler = (seed: number, words: number) =>
  Array.from({ length: words }, (_, i) => `w${((i + seed) * 7919) % 10007}`).join(" ")

describe("workshop context", () => {
  it.live("uses the model's window and a quarter-window reply reserve, carried into the next turn", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((request, res) => {
            const { user, results } = turnOf(request.body!.messages as Array<Wire>)
            sse(
              res,
              user.includes("First") && results.length === 0
                ? call("read_card", { card: "Assistant" }, "first_read")
                : completionChunks(["Done."], {})
            )
          })
        ),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const { model } = yield* useModel(api, `${mock.url}/v1`, { context: 200_000, maxOutput: 64_000 })
      const chat = yield* api.CreateWorkshop({})
      const events = yield* watch(api, chat)
      yield* api.GetWorkshopDefaults({})
      yield* api.GetNextContext({ chatId: chat.id, leafSlotId: chat.activeLeafSlotId })
      assert.lengthOf(mock.requests(), 0, "creation and inspection must not send")
      const first = yield* turn(api, chat, events, "First request.")
      // 200k window; the reply reserve is the model's 64k output, capped at a quarter of the window.
      assert.deepInclude(yield* budgetOf(api, first.id), { maximum: 200_000, responseReserve: 50_000 })
      const firstBodies = mock.requests().map((r) => r.body!)
      assert.lengthOf(firstBodies, 2, JSON.stringify(firstBodies[0]!.messages).slice(-1500))
      assert.strictEqual(firstBodies[0]!.max_tokens ?? firstBodies[0]!.max_completion_tokens, 50_000)
      const second = yield* turn(api, chat, events, "Second request.")
      const run = yield* api.GetRunContext({ versionId: second.id })
      assert.strictEqual(run.continuity?.parentVersionId, first.id, run.continuity?.reason)
      const before = firstBodies[1]!.messages as Array<Wire>
      const carried = mock.requests()[2]!.body!.messages as Array<Wire>
      assert.deepStrictEqual(carried.slice(0, before.length), before)
      assert.include(text(carried.at(-1)!.content), "Second request.")
      // A smaller window and an explicit send limit must invalidate the frozen carry.
      yield* api.EditModel({
        modelId: model.id,
        expectedRowVersion: model.rowVersion,
        overrides: { context: 32_000, maxOutput: 8_000, settings: { samplers: { openai_max_context: 16_384 } } }
      })
      assert.lengthOf(mock.requests(), 3, "editing the model must not send")
      const third = yield* turn(api, chat, events, "Third request.")
      assert.deepInclude(yield* budgetOf(api, third.id), { maximum: 16_384, responseReserve: 4_096 })
      const rebuilt = yield* api.GetRunContext({ versionId: third.id })
      assert.isUndefined(rebuilt.continuity?.parentVersionId)
      assert.include(rebuilt.continuity?.reason, "model or connection settings changed")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("assumes a 128k window when nothing reports the model's", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() => startMockProvider((_request, res) => sse(res, completionChunks(["Done."], {})))),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      yield* useModel(api, `${mock.url}/v1`, {})
      const chat = yield* api.CreateWorkshop({})
      const events = yield* watch(api, chat)
      const { id } = yield* turn(api, chat, events, "Hello.")
      const budget = yield* budgetOf(api, id)
      assert.strictEqual(budget.maximum, 128_000)
      assert.isAtMost(budget.responseReserve, 32_000)
      assert.isAbove(budget.responseReserve, 0)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  // 37k: the combined workshop toolset (presets, lorebooks and chat rewrites too, and load_skill with its
  // index) leaves turn two room to carry.
  for (const window of [24_000, 37_000])
    it.live(`elision and protected newest results with a ${window} window`, () => {
      const config = testConfig()
      return Effect.gen(function* () {
        const mock = yield* Effect.acquireRelease(
          Effect.promise(() =>
            startMockProvider((request, res) => {
              const messages = request.body!.messages as Array<Wire>
              const { user, results } = turnOf(messages)
              const plan: ReadonlyArray<readonly [string, unknown, string]> = user.includes("Turn one")
                ? [
                    ["read_card", { card: "Ledger one" }, "c1"],
                    ["read_card", { card: "Ledger two" }, "c2"]
                  ]
                : user.includes("Turn two")
                  ? [["read_card", { card: "Ledger three" }, "c3"]]
                  : user.includes("Turn three")
                    ? (() => {
                        const marker = messages
                          .map((m) => text(m.content))
                          .join("\n")
                          .match(/\[Result left out to save room\. read_run with message (\d+)/)
                        return marker ? [["read_run", { message: Number(marker[1]), call: "c1" }, "c4"] as const] : []
                      })()
                    : []
              const next = plan[results.length]
              sse(res, next ? call(next[0], next[1], next[2]) : completionChunks(["Done."], {}))
            })
          ),
          (m) => Effect.promise(() => m.close())
        )
        const api = yield* client()
        for (const [label, seed] of [
          ["Ledger one", 1],
          ["Ledger two", 2],
          ["Ledger three", 3]
        ] as const)
          yield* api.CreateCard({ label, name: label, description: `Marker ${label}. ${filler(seed, 1800)}` })
        yield* useModel(api, `${mock.url}/v1`, { context: window, maxOutput: 2_000 })
        const chat = yield* api.CreateWorkshop({})
        // Keep this library-result boundary independent of optional authoring definitions.
        // Every-tool mode intentionally includes every offered tool; Off removes these tools.
        yield* api.SetWorkshopGrant({ chatId: chat.id, capability: "plugins.write", mode: "off" })
        yield* api.SetWorkshopGrant({ chatId: chat.id, capability: "plugins.apply", mode: "off" })
        // Legacy elision remains available when the user explicitly turns LCM off.
        yield* api.ChangeLcmSettings({ chatId: chat.id, change: { enabled: false } })
        const events = yield* watch(api, chat)
        yield* turn(api, chat, events, "Turn one.")
        const second = yield* turn(api, chat, events, "Turn two.")
        const secondRun = yield* api.GetRunContext({ versionId: second.id })
        if (window === 24_000) {
          assert.isUndefined(secondRun.continuity?.parentVersionId)
          assert.include(secondRun.continuity?.reason, "outgrew the context budget")
          return
        }
        assert.isDefined(secondRun.continuity?.parentVersionId, secondRun.continuity?.reason)
        assert.isUndefined(secondRun.continuity?.elided)
        const before = mock.requests().length
        const third = yield* turn(api, chat, events, "Turn three.")
        const run = yield* api.GetRunContext({ versionId: third.id })
        // Carried, not rebuilt: the oldest results were left out instead.
        assert.strictEqual(run.continuity?.parentVersionId, second.id, run.continuity?.reason)
        assert.isAtLeast(run.continuity?.elided ?? 0, 1)
        const opening = mock.requests()[before]!.body!.messages as Array<Wire>
        const tools = opening.filter((m) => m.role === "tool").map((m) => text(m.content))
        assert.include(tools[0], "[Result left out to save room. read_run with message")
        assert.notInclude(tools[0], "Marker Ledger one")
        // The last turn's results stay as they were.
        assert.include(tools.at(-1), "Marker Ledger three")
        // read_run brings the left-out result back, from the run that made it.
        const closing = mock.requests().at(-1)!.body!.messages as Array<Wire>
        const reread = closing.findLast((m) => m.role === "tool")!
        assert.strictEqual(reread.tool_call_id, "c4")
        assert.include(text(reread.content), "&quot;call&quot;:&quot;c1&quot;")
        assert.include(text(reread.content), "Marker Ledger one")
        // The next turn carries the shortened run as it was sent.
        const fourth = yield* turn(api, chat, events, "Turn four.")
        const fourthRun = yield* api.GetRunContext({ versionId: fourth.id })
        assert.strictEqual(fourthRun.continuity?.parentVersionId, third.id, fourthRun.continuity?.reason)
        const carried = mock.requests().at(-1)!.body!.messages as Array<Wire>
        // (Past the trigger again, it may leave out turn two's result as well, but nothing before it changes.)
        const cut = closing.findIndex((m) => m.tool_call_id === "c3")
        assert.isAbove(cut, 0)
        assert.deepStrictEqual(carried.slice(0, cut), closing.slice(0, cut))
        assert.include(text(carried.find((m) => m.tool_call_id === "c1")!.content), "[Result left out")
        // Editing a step resumes the stored elision bytes instead of compacting them again.
        const reader = yield* Reader
        const me = yield* api.Whoami()
        const { entry } = yield* reader.GetSlot({ userId: me.id, slotId: third.reply.entry.slotId })
        const editedAt = mock.requests().length
        const edited = yield* api.ResumeFromStep({
          versionId: third.id,
          step: 0,
          expectedRowVersion: entry.rowVersion,
          edit: { kind: "result", text: "Edited lookup result." }
        })
        yield* eventually(() => finished(events, edited.version.id) !== undefined, 60_000)
        const replayed = mock.requests()[editedAt]!.body!.messages as Array<Wire>
        assert.deepStrictEqual(replayed.slice(0, opening.length), opening)
        assert.include(text(replayed.at(-1)!.content), "Edited lookup result.")
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    })

  it.live("a regenerated middle reply's history tools never return later messages or runs", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const regenerating = { on: false }
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((request, res) => {
            const { results } = turnOf(request.body!.messages as Array<Wire>)
            const plan: ReadonlyArray<readonly [string, unknown]> = regenerating.on
              ? [
                  ["search_chat", { query: "Zephyr" }],
                  ["read_messages", { from: 1, count: 20 }],
                  ["read_run", { message: 7 }],
                  ["read_run", { message: 3 }]
                ]
              : [["read_card", { card: "Assistant" }]]
            const at = regenerating.on
              ? results.filter((r) => r.tool_call_id?.startsWith("history_")).length
              : results.length
            const next = plan[at]
            sse(
              res,
              next
                ? call(next[0], next[1], `${regenerating.on ? "history" : "lookup"}_${at}`)
                : completionChunks(["Done."], {})
            )
          })
        ),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      yield* useModel(api, `${mock.url}/v1`, { context: 200_000, maxOutput: 8_000 })
      const chat = yield* api.CreateWorkshop({})
      const events = yield* watch(api, chat)
      // Message 1 is the greeting: 2 and 3, 4 and 5, 6 and 7 are the turns.
      yield* turn(api, chat, events, "Plan the first card.")
      const middle = yield* turn(api, chat, events, "Plan the second card.")
      yield* turn(api, chat, events, "Name it Zephyr.")
      regenerating.on = true
      const before = mock.requests().length
      const again = yield* posted(
        api.Generate({ chatId: chat.id, parentSlotId: middle.sent.entry.slotId, branch: true })
      )
      yield* eventually(() => finished(events, again.entry.version.id) !== undefined, 60_000)
      const results = (mock.requests().slice(before).at(-1)!.body!.messages as Array<Wire>)
        .filter((m) => m.role === "tool")
        .map((m) => text(m.content))
      // Turn one's read, carried from message 3's run, then the four reads of this one.
      const own = results.slice(-4)
      assert.lengthOf(results, 5, JSON.stringify(results).slice(0, 3000))
      for (const result of results.filter((_, i) => i !== 1)) assert.notInclude(result, "Zephyr", result)
      assert.strictEqual(own[0], toolData("No earlier messages match “Zephyr”."))
      assert.include(own[1], "Message 4, local: Plan the second card.")
      assert.include(own[1], "Message 3, Assistant: Done.")
      assert.notInclude(own[1], "Message 5")
      assert.include(own[2], "Message 7 isn&apos;t one of the earlier messages.")
      assert.include(own[3], "&quot;tool&quot;:&quot;read_card&quot;")

      // Attack the same boundary through a real swipe and an explicit fork, rather than
      // relying only on Generate's branch flag. Later runs stay readable to the user.
      const reader = yield* Reader
      const me = yield* api.Whoami()
      const originalFork = chat.currentForkId
      const { entry: currentMiddle } = yield* reader.GetSlot({
        userId: me.id,
        slotId: middle.reply.entry.slotId,
        forkId: originalFork
      })
      const swipeAt = mock.requests().length
      const swiped = yield* api.Regenerate({
        slotId: currentMiddle.slotId,
        forkId: originalFork,
        expectedRowVersion: currentMiddle.rowVersion
      })
      yield* eventually(() => finished(events, swiped.version.id) !== undefined, 60_000)
      const fork = yield* api.CreateFork({
        chatId: chat.id,
        fromForkId: originalFork,
        atSlotId: middle.sent.entry.slotId
      })
      const forkAt = mock.requests().length
      const forked = yield* posted(
        api.Generate({
          chatId: chat.id,
          parentSlotId: middle.sent.entry.slotId,
          branch: false,
          forkId: fork.fork.id
        })
      )
      yield* eventually(() => finished(events, forked.entry.version.id) !== undefined, 60_000)
      for (const batch of [mock.requests().slice(swipeAt, forkAt), mock.requests().slice(forkAt)]) {
        const last = batch.at(-1)!.body!.messages as Array<Wire>
        const outputs = last
          .filter((m) => m.role === "tool")
          .slice(-4)
          .map((m) => text(m.content))
        assert.lengthOf(outputs, 4)
        assert.strictEqual(outputs[0], toolData("No earlier messages match “Zephyr”."))
        assert.notInclude(outputs[1], "Zephyr")
        assert.include(outputs[2], "Message 7 isn&apos;t one of the earlier messages.")
        assert.include(outputs[3], "&quot;tool&quot;:&quot;read_card&quot;")
      }
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})

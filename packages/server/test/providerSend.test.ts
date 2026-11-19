// Nothing goes to a provider the user didn't choose to send to (owner, 2026-11-02: "Users choose
// to send a chat to a provider by switching to it *and submitting*. Editing a card for example
// cannot do that, neither should switching a provider on its own or opening a chat"; DESIGN §11).
// With every setting at its default, opening a chat, attaching an image, reading the next
// context, editing a card's text and switching the model send the provider nothing; the
// submit is the first request it gets, and it's the reply itself. Synthetic data and mock
// providers only.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import type { ChatEvent } from "@dreamspan/shared/chatApi.ts"
import { client, serverLayer, serverPort, testConfig } from "./support/config.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { sizedPng } from "./formats/support.ts"
import { anthropicSse, completionChunks, type Recorded, sse, startMockProvider } from "./support/mockProvider.ts"
import {
  completions,
  isChild,
  mockProvider,
  scripted,
  task,
  toolTexts,
  TRIGGER,
  watch
} from "./support/subagentScript.ts"
import { countingModelKey } from "../src/providers/countingModel.ts"

const upload = (bytes: Uint8Array) =>
  Effect.gen(function* () {
    const port = yield* serverPort
    const response = yield* Effect.promise(() =>
      fetch(`http://127.0.0.1:${port}/chat/image`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: bytes
      })
    )
    assert.strictEqual(response.status, 200)
    return (yield* Effect.promise(() => response.json())) as { mediaId: string }
  })

/** An Anthropic endpoint that answers every message and every count. */
const anthropic = () =>
  Effect.acquireRelease(
    Effect.promise(() =>
      startMockProvider((request: Recorded, res) => {
        if (request.path.endsWith("/count_tokens")) {
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ input_tokens: JSON.stringify(request.body).includes('"image"') ? 1311 : 11 }))
          return
        }
        anthropicSse(res, [
          {
            type: "message_start",
            message: {
              id: "synthetic",
              type: "message",
              role: "assistant",
              model: "claude-opus-4-7",
              content: [],
              stop_reason: null,
              usage: { input_tokens: 1400, output_tokens: 1 }
            }
          },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "A drawing." } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
          { type: "message_stop" }
        ])
      })
    ),
    (m) => Effect.promise(() => m.close())
  )

const settings = (name: string, baseUrl: string) => ({
  name,
  baseUrl,
  compat: {},
  cacheTtlS: null,
  maxConcurrent: null,
  presetOverrideRefId: null
})

describe("what reaches a provider", () => {
  it.live("with the defaults, only the user's submit sends anything, and only to the chat's model", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const first = yield* anthropic()
      const second = yield* anthropic()
      const a = yield* api.CreateConnection({
        kind: "anthropic",
        settings: settings("First", first.url),
        apiKey: "sk-first"
      })
      const b = yield* api.CreateConnection({
        kind: "anthropic",
        settings: settings("Second", second.url),
        apiKey: "sk-second"
      })
      const modelA = yield* api.AddUserModel({
        connectionId: a.id,
        key: "claude-opus-4-7",
        overrides: { vision: true }
      })
      const modelB = yield* api.AddUserModel({
        connectionId: b.id,
        key: "claude-opus-4-7",
        overrides: { vision: true }
      })
      yield* api.SetGenerationDefaults({ defaults: { model: { connection: b.id, model: modelB.id }, preset: null } })
      assert.deepStrictEqual(yield* api.GetTokenCounting(), [])

      // Open a chat, attach an image, read what the next request would hold.
      const chat = yield* api.CreateChat({ title: "Synthetic" })
      const events: Array<ChatEvent> = []
      yield* api.SubscribeChat({ chatId: chat.id }).pipe(
        Stream.runForEach((batch) => Effect.sync(() => events.push(...batch))),
        Effect.forkScoped
      )
      const draft = yield* api.OpenComposer({ chatId: chat.id, forkId: null })
      const image = yield* upload(sizedPng(1000, 1000))
      yield* api.SetComposerImage({
        chatId: chat.id,
        draftId: draft.id,
        id: "before-send",
        mediaId: image.mediaId,
        altText: "Drawing"
      })
      // Edit a card's text: the editors count its tokens.
      yield* api.CreateCard({ label: "Mira", name: "Mira" })
      const counted = yield* api.CountTokens({ texts: ["{{char}} keeps the ledger for {{user}}."] })
      assert.isFalse(counted.tokenizer.exact)
      // Switch the chat model to the first connection, on its own.
      yield* api.SetGenerationDefaults({ defaults: { model: { connection: a.id, model: modelA.id }, preset: null } })
      const next = yield* api.GetNextContext({ chatId: chat.id, leafSlotId: null })
      // The image is estimated by Anthropic's formula, not counted, and never shown as zero.
      assert.strictEqual(next.imageTokens?.count, 1)
      assert.deepStrictEqual(next.imageTokens?.bases, ["formula"])
      assert.isAbove(next.imageTokens?.tokens ?? 0, 0)
      yield* eventually(() => events.some((e) => e._tag === "Cache" && e.imageTokens?.count === 1))
      // Background work has had its chance: the image counter's queue runs within milliseconds.
      yield* Effect.sleep("1500 millis")
      assert.lengthOf(first.requests(), 0, JSON.stringify(first.requests().map((r) => r.path)))
      assert.lengthOf(second.requests(), 0, JSON.stringify(second.requests().map((r) => r.path)))

      // The submit: the chat's chosen provider gets the reply request, and nothing else.
      const posted = yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: null,
        branch: false,
        content: "Describe",
        images: [image],
        speakerEntityId: null
      } as Parameters<typeof api.SendMessage>[0])
      assert.strictEqual(posted._tag, "Posted")
      if (posted._tag !== "Posted") return
      const reply = yield* api.Generate({ chatId: chat.id, parentSlotId: posted.entry.slotId, branch: false })
      assert.strictEqual(reply._tag, "Posted")
      if (reply._tag !== "Posted") return
      yield* eventually(() => finished(events, reply.entry.version.id) !== undefined)
      yield* Effect.sleep("1500 millis")
      assert.isAbove(first.requests().length, 0)
      assert.isTrue(
        first.requests().every((r) => r.path.startsWith("/v1/messages") && !r.path.includes("count_tokens")),
        JSON.stringify(first.requests().map((r) => r.path))
      )
      assert.lengthOf(second.requests(), 0)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("images are counted only through the connection the user chose for counting", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const chatProvider = yield* anthropic()
      const counting = yield* anthropic()
      const a = yield* api.CreateConnection({
        kind: "anthropic",
        settings: settings("Chat", chatProvider.url),
        apiKey: "sk-chat"
      })
      const b = yield* api.CreateConnection({
        kind: "anthropic",
        settings: settings("Counting", counting.url),
        apiKey: "sk-counting"
      })
      const model = yield* api.AddUserModel({ connectionId: a.id, key: "claude-opus-4-7", overrides: { vision: true } })
      yield* api.SetGenerationDefaults({ defaults: { model: { connection: a.id, model: model.id }, preset: null } })
      const chat = yield* api.CreateChat({ title: "Synthetic" })
      const events: Array<ChatEvent> = []
      yield* api.SubscribeChat({ chatId: chat.id }).pipe(
        Stream.runForEach((batch) => Effect.sync(() => events.push(...batch))),
        Effect.forkScoped
      )
      const draft = yield* api.OpenComposer({ chatId: chat.id, forkId: null })
      const image = yield* upload(sizedPng(1000, 1000))
      yield* api.SetComposerImage({
        chatId: chat.id,
        draftId: draft.id,
        id: "before-send",
        mediaId: image.mediaId,
        altText: "Drawing"
      })
      yield* eventually(() => events.some((e) => e._tag === "Cache" && e.imageTokens?.bases.includes("formula")))
      assert.lengthOf(counting.requests(), 0)
      // Chosen: the counting connection gets the image, the chat's provider still nothing.
      yield* api.SetTokenCounting({ connectionId: a.id, via: b.id })
      yield* eventually(() => events.some((e) => e._tag === "Cache" && e.imageTokens?.bases.includes("counted")))
      const counts = counting.requests().filter((r) => r.path === "/v1/messages/count_tokens")
      assert.lengthOf(counts, 2, "one count with the image, one without")
      assert.strictEqual(counts[0]!.headers["x-api-key"], "sk-counting")
      assert.lengthOf(chatProvider.requests(), 0)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )
})

describe("the model a counting connection is asked for", () => {
  it("is the chat model's own key, else its name without the router's prefix", () => {
    assert.strictEqual(countingModelKey("claude-opus-4-7", ["claude-opus-4-7"]), "claude-opus-4-7")
    assert.strictEqual(
      countingModelKey("anthropic/claude-sonnet-4.5", ["claude-haiku-4-5", "claude-sonnet-4-5"]),
      "claude-sonnet-4-5"
    )
    assert.strictEqual(countingModelKey("google/gemini-2.5-pro", []), "gemini-2.5-pro")
    assert.strictEqual(countingModelKey("models/gemini-2.5-pro", ["gemini-2.5-pro"]), "gemini-2.5-pro")
  })
})

// The subagent twin (spec/SUBAGENTS.md §5.2): with the subagent settings at their defaults
// ("Same as this chat's model"), a workshop's subagent sends only to the chat's own model, whatever
// the reply asks for, even with a summary model on another connection; a story reply, even with
// tools on, is never offered the agent tool.
describe("what a subagent reaches", () => {
  it.live("with the defaults, a subagent sends only to the chat's model, whatever the reply asks for", () =>
    Effect.gen(function* () {
      const script = scripted({
        parent: [
          { name: "agent", args: { type: "research", task: "Look.", model: "fast" }, id: "fast" },
          { name: "agent", args: { type: "research", task: "Look." }, id: "plain" }
        ],
        child: () => undefined
      })
      const chatProvider = yield* mockProvider(script.handler)
      const elsewhere = yield* mockProvider((_request, res) => sse(res, completionChunks(["Elsewhere."], {})))
      const api = yield* client()
      const story = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${chatProvider.url}/v1` },
        model: {},
        state: [
          { key: "agent.enabled", value: { on: true } },
          { key: "output.contract", value: "final_text" }
        ]
      })
      const other = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: settings("Elsewhere", `${elsewhere.url}/v1`)
      })
      const model = yield* api.AddUserModel({ connectionId: other.id, key: "elsewhere-model", overrides: {} })
      // A summary model elsewhere: the chat already sends summaries there, but subagents weren't given it.
      yield* api.ChangeGenerationDefaults({ change: { summarizer: { connection: other.id, model: model.id } } })
      const chat = yield* api.CreateWorkshop({})
      const events = yield* watch(api, chat)
      const versionId = yield* task(api, chat, "look")
      yield* eventually(() => finished(events, versionId) !== undefined)
      const bodies = completions(chatProvider.requests())
      const results = toolTexts(bodies.filter((b) => !isChild(b)).at(-1)!)
      assert.include(results[0], "no subagent model “fast” here. Use one of: same.")
      assert.include(results[1], "Report.")
      assert.lengthOf(bodies.filter(isChild), 1)
      assert.lengthOf(completions(elsewhere.requests()), 0)
      // The story's agent reply had tools, never `agent`.
      const storyBodies = bodies.filter((b) => !isChild(b) && !JSON.stringify(b.messages).includes(TRIGGER))
      assert.isAbove(storyBodies.length, 0)
      for (const body of storyBodies)
        assert.notInclude(
          (body.tools ?? []).map((t) => t.function.name),
          "agent"
        )
      assert.isDefined(story.chat)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )
})

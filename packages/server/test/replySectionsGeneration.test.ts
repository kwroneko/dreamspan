// Tagged reply sections (spec/REPLY-SECTIONS.md) through real generation: a mock provider
// streams reasoning and a reply that starts with a `<thinking>…</think>` section, split
// across chunks. The section is stored apart from the body and the provider's reasoning,
// sent back only as the preset says, resumed by Continue after a cutoff inside it, and put
// back into the text by "Show as reply text".
import { assert, describe, it } from "@effect/vitest"
import { originalReply } from "@dreamspan/shared/replySections.ts"
import { Effect } from "effect"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { type Recorded, sse, startMockProvider } from "./support/mockProvider.ts"

const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
  id: "cmpl-1",
  object: "chat.completion.chunk",
  model: "served-model",
  choices: [{ index: 0, delta, finish_reason: finish }]
})
const usage = {
  id: "cmpl-1",
  object: "chat.completion.chunk",
  model: "served-model",
  choices: [],
  usage: { prompt_tokens: 100, completion_tokens: 10 }
}

type Message = { readonly role: string; readonly content: string }
const messagesOf = (request: Recorded) => (request.body as { messages: ReadonlyArray<Message> }).messages
const completions = (requests: ReadonlyArray<Recorded>) => requests.filter((r) => r.path === "/v1/chat/completions")

const REPLY = "<thinking>\nPlan: Mira is wary.</thinking>\n\nThe ledger says otherwise."

/** Reasoning, then the reply with its section, the closing tag split in two. */
const replyWithSection = (res: Parameters<typeof sse>[0]) =>
  sse(res, [
    chunk({ role: "assistant", reasoning_content: "Provider reasoning." }),
    chunk({ content: "<thin" }),
    chunk({ content: "king>\nPlan: Mira is wary.</thi" }),
    chunk({ content: "nking>\n\nThe ledger" }),
    chunk({ content: " says otherwise." }),
    chunk({}, "stop"),
    usage
  ])

const plain = (res: Parameters<typeof sse>[0]) =>
  sse(res, [chunk({ role: "assistant", content: "Fine." }), chunk({}, "stop"), usage])

describe("reply sections in generation", () => {
  for (const sendBack of [0, 1]) {
    it.live(`stores a leading section apart from the body and the reasoning (send_back=${sendBack})`, () => {
      const config = testConfig()
      return Effect.gen(function* () {
        let first = true
        const mock = yield* Effect.acquireRelease(
          Effect.promise(() =>
            startMockProvider((_request, res) => {
              if (!first) return plain(res)
              first = false
              return replyWithSection(res)
            })
          ),
          (m) => Effect.promise(() => m.close())
        )
        const api = yield* client()
        const { version, chat, events } = yield* generateReply(api, {
          connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
          model: { prefill: "assistant" },
          ...(sendBack
            ? {
                presetFields: {
                  reply_sections: {
                    enabled: true,
                    pairs: [{ open: "<think(?:ing)?>", close: "</think(?:ing)?>", regex: true }],
                    send_back: 1
                  }
                }
              }
            : {})
        })
        assert.strictEqual(version.status, "complete")
        assert.strictEqual(version.content, "The ledger says otherwise.")
        assert.strictEqual(version.reasoning, "Provider reasoning.")
        assert.deepStrictEqual(version.replySections, {
          sections: [{ lead: "", open: "<thinking>", text: "\nPlan: Mira is wary.", close: "</thinking>" }],
          gap: "\n\n"
        })
        assert.strictEqual(originalReply(version.content, version.replySections), REPLY)
        // Streamed: the section to its panel, never a tag into the body.
        const of = (tag: string) =>
          events.flatMap((e) => (e._tag === tag && "text" in e && e.versionId === version.id ? [e.text] : []))
        assert.strictEqual(of("Section").join(""), "\nPlan: Mira is wary.")
        assert.strictEqual(of("Delta").join(""), "The ledger says otherwise.")

        // The next request: the body only, unless the preset sends the last reply's section back.
        const next = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: version.slotId, branch: false }))
        yield* eventually(() => finished(events, next.entry.version.id) !== undefined)
        const sent = messagesOf(completions(mock.requests())[1]!)
        const reply = sent.find((m) => m.role === "assistant" && m.content.includes("The ledger"))!
        assert.strictEqual(reply.content, sendBack ? REPLY : "The ledger says otherwise.")
        assert.notInclude(JSON.stringify(sent), "Provider reasoning")

        // Show as reply text: an edited version with the reply as it came, the reasoning kept.
        const path = yield* api.ReadPath({
          chatId: chat.id,
          leafSlotId: version.slotId,
          range: { _tag: "Bottom" },
          limit: 10
        })
        const shown = yield* api.ShowSectionsAsText({
          versionId: version.id,
          expectedRowVersion: path.entries.at(-1)!.rowVersion
        })
        assert.strictEqual(shown.version.content, REPLY)
        assert.strictEqual(shown.version.origin, "edited")
        assert.strictEqual(shown.version.sourceVersionId, version.id)
        assert.strictEqual(shown.version.reasoning, "Provider reasoning.")
        assert.strictEqual(shown.version.replySections, undefined)
        const versions = yield* api.ListVersions({ slotId: version.slotId })
        assert.deepStrictEqual(versions[0]!.replySections, version.replySections)
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    })
  }

  it.live("keeps a section cut off by the length limit open, and Continue resumes inside it", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      let first = true
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((_request, res) => {
            if (first) {
              first = false
              return sse(res, [
                chunk({ role: "assistant", content: "<think>Plan: the tide" }),
                chunk({}, "length"),
                usage
              ])
            }
            return sse(res, [
              chunk({ role: "assistant", content: " is late.</thi" }),
              chunk({ content: "nking>\nMira looks up." }),
              chunk({}, "stop"),
              usage
            ])
          })
        ),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const { version, chat, events } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: { prefill: "assistant" }
      })
      assert.strictEqual(version.status, "failed")
      assert.strictEqual(version.content, "")
      assert.deepStrictEqual(version.replySections?.sections, [
        { lead: "", open: "<think>", text: "Plan: the tide", close: null }
      ])
      const path = yield* api.ReadPath({
        chatId: chat.id,
        leafSlotId: version.slotId,
        range: { _tag: "Bottom" },
        limit: 10
      })
      const continued = yield* api.ContinueVersion({
        versionId: version.id,
        expectedRowVersion: path.entries.at(-1)!.rowVersion
      })
      yield* eventually(() => finished(events, continued.version.id) !== undefined)
      const done = finished(events, continued.version.id)!
      assert.strictEqual(done.status, "complete")
      assert.strictEqual(done.content, "Mira looks up.")
      assert.deepStrictEqual(done.replySections, {
        sections: [{ lead: "", open: "<think>", text: "Plan: the tide is late.", close: "</thinking>" }],
        gap: "\n"
      })
      // The prefill rebuilt the opening tag and the section so far.
      assert.strictEqual(messagesOf(completions(mock.requests())[1]!).at(-1)!.content, "<think>Plan: the tide")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("continues inside a section cut off on a model that takes no prefill", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      let first = true
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((_request, res) => {
            if (first) {
              first = false
              return sse(res, [
                chunk({ role: "assistant", content: "<think>Plan: the tide" }),
                chunk({}, "length"),
                usage
              ])
            }
            // Only what follows, with no space of its own (owner, 2026-10-31).
            return sse(res, [
              chunk({ role: "assistant", content: "is late.</thi" }),
              chunk({ content: "nking>\nMira looks up." }),
              chunk({}, "stop"),
              usage
            ])
          })
        ),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const { version, chat, events } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {}
      })
      assert.strictEqual(version.status, "failed")
      const path = yield* api.ReadPath({
        chatId: chat.id,
        leafSlotId: version.slotId,
        range: { _tag: "Bottom" },
        limit: 10
      })
      const continued = yield* api.ContinueVersion({
        versionId: version.id,
        expectedRowVersion: path.entries.at(-1)!.rowVersion
      })
      yield* eventually(() => finished(events, continued.version.id) !== undefined)
      const done = finished(events, continued.version.id)!
      assert.strictEqual(done.status, "complete")
      assert.strictEqual(done.content, "Mira looks up.")
      assert.deepStrictEqual(done.replySections, {
        sections: [{ lead: "", open: "<think>", text: "Plan: the tide is late.", close: "</thinking>" }],
        gap: "\n"
      })
      // The reply as it came, its section in its tag, as the model's own message; the nudge last.
      const messages = messagesOf(completions(mock.requests())[1]!)
      assert.deepStrictEqual(messages.slice(-2), [
        { role: "assistant", content: "<think>Plan: the tide" },
        { role: "user", content: "[Continue your last message without repeating its original content.]" }
      ])
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})

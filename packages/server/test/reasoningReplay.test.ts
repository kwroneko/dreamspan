// Earlier replies' own reasoning sent back in plain chats (the preset's `reasoning_send_back`,
// owner 2026-11-23), through real generation against fake providers: off by default, signed
// blocks replayed only to the model that wrote them and on the terms its provider checks (a
// bound-thinking Claude model: what preceded them unchanged, as an unbroken run, with the
// provider's drop_block opted into; an earlier Claude model and OpenAI Responses: any history,
// so with the preset's end-of-request text too), plain reasoning only where the provider
// documents taking it, and the thinking panels' indicator (`NextContext.thinking`) always the
// request's own decision. Tool runs keep their thinking at any setting. Synthetic chats only;
// nothing reaches a real provider.
import { assert, describe, it } from "@effect/vitest"
import { Type } from "@earendil-works/pi-ai"
import type { Chat, VersionId } from "@dreamspan/shared/chat.ts"
import type { ChatEvent } from "@dreamspan/shared/chatApi.ts"
import { GROUP_NUDGE } from "@dreamspan/shared/endOfRequest.ts"
import { DEFAULT_SECTION_PAIRS } from "@dreamspan/shared/replySections.ts"
import { Effect } from "effect"
import type { ServerResponse } from "node:http"
import type { RolloutTool } from "../src/agent/tools.ts"
import { Reader } from "../src/db/Database.ts"
import { ExecutionRegistry } from "../src/execution.ts"
import { importStPreset } from "../src/formats/preset.ts"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"
import { type AnthropicBody, enforcingAnthropic } from "./support/enforcingAnthropic.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { type Recorded, sse, startMockProvider } from "./support/mockProvider.ts"

type Api = Effect.Success<ReturnType<typeof client>>

const mockOf = (handler: (request: Recorded, res: ServerResponse) => void | Promise<void>) =>
  Effect.acquireRelease(
    Effect.promise(() => startMockProvider(handler)),
    (m) => Effect.promise(() => m.close())
  )

/** The imported ST default, with its turn text ("When a character speaks"), the end-of-request message. */
const withTurnText = importStPreset(JSON.stringify({ frequency_penalty: 0 })).document!.prompts
/** The same, its turn text emptied. */
const noTurnText = withTurnText.map((p) => (p.identifier === GROUP_NUDGE ? { ...p, content: "" } : p))

/** The preset: the reasoning send-back as given (absent: the default), and no end-of-request text unless asked. */
const presetWith = (reasoning: number | undefined, sections = 0, endText = false) => ({
  presetFields: {
    // The turn text is the request's last message, which a later request doesn't repeat: a
    // bound block written after it never fits again. Without it the request ends on the user's.
    prompts: endText ? withTurnText : noTurnText,
    reply_sections: {
      enabled: true,
      pairs: DEFAULT_SECTION_PAIRS,
      send_back: sections,
      ...(reasoning === undefined ? {} : { reasoning_send_back: reasoning })
    }
  }
})

type Block = { readonly type: string } & Record<string, unknown>
const thinkingIn = (body: AnthropicBody) =>
  body.messages.flatMap((m) =>
    m.role === "assistant" && Array.isArray(m.content)
      ? (m.content as Array<Block>).flatMap((b) => (b.type === "thinking" ? [String(b.thinking)] : []))
      : []
  )

/** A bound-thinking model (claudeThinking.ts `claudeBoundThinking`), and an earlier one. */
const BOUND = "claude-opus-5-5"
const EARLIER = "claude-opus-5"

/**
 * Mira's n-th reply thinks "Thought n." and says "Reply n.", from an endpoint that checks what
 * the model checks: the prefix and the run for a bound model, only the signature for an earlier one.
 */
const numbered = (
  options: { readonly relaxed?: boolean; readonly reportDropped?: (body: AnthropicBody) => ReadonlyArray<string> } = {}
) => {
  let n = 0
  return enforcingAnthropic({
    chain: true,
    ...options,
    reply: () => {
      n++
      return { thinking: `Thought ${n}.`, text: `Reply ${n}.` }
    }
  })
}

const anthropic = (
  api: Api,
  url: string,
  reasoning: number | undefined,
  sections = 0,
  options: { readonly key?: string; readonly endText?: boolean } = {}
) =>
  generateReply(api, {
    connection: { kind: "anthropic", baseUrl: url, apiKey: "sk-ant-made-up-for-tests-0000" },
    modelKey: options.key ?? BOUND,
    model: {},
    ...presetWith(reasoning, sections, options.endText)
  })

/** Every request was taken as sent: nothing refused, and nothing the provider had to drop. */
const clean = (fake: ReturnType<typeof numbered>) =>
  fake.verdicts.every((v) => v.verdict.ok && !(v.verdict.dropped?.length ?? 0))

/** The user says something, and Mira replies. */
const turn = (api: Api, chat: Chat, events: ReadonlyArray<ChatEvent>, content: string) =>
  Effect.gen(function* () {
    const current = yield* api.GetChat({ chatId: chat.id })
    const user = yield* posted(
      api.SendMessage({ chatId: chat.id, parentSlotId: current.activeLeafSlotId, branch: false, content })
    )
    const reply = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: user.entry.slotId, branch: false }))
    yield* eventually(() => finished(events, reply.entry.version.id) !== undefined)
    const version = finished(events, reply.entry.version.id)!
    assert.strictEqual(version.status, "complete", JSON.stringify(version.error))
    return { user: user.entry, version }
  })

/** What the next request will send back, as the thinking panels read it. */
const nextSends = (api: Api, chat: Chat) =>
  Effect.map(api.GetNextContext({ chatId: chat.id, leafSlotId: null }), (next) => next.thinking)

/** What the request inspector notes on a reply's context. */
const issuesOf = (api: Api, versionId: VersionId) =>
  Effect.map(api.GetRunContext({ versionId }), (run) => run.issues.map((i) => i.kind))

/** What the reply itself shows under it. */
const shownIssues = (api: Api, versionId: VersionId) =>
  Effect.gen(function* () {
    const me = yield* api.Whoami()
    const version = yield* (yield* Reader).GetVersion({ userId: me.id, versionId })
    return (version.context?.issues ?? []).map((i) => i.kind)
  })

describe("provider reasoning sent back in plain chats", () => {
  for (const setting of [undefined, 0] as const)
    it.live(`${setting === undefined ? "by default" : "at 0"}, no request carries earlier reasoning`, () =>
      Effect.gen(function* () {
        const fake = numbered()
        const mock = yield* mockOf(fake.handler)
        const api = yield* client()
        const { chat, events, version } = yield* anthropic(api, mock.url, setting)
        assert.strictEqual(version.reasoning, "Thought 1.")
        yield* turn(api, chat, events, "The tide turns.")
        yield* turn(api, chat, events, "Mira laughs.")
        assert.isTrue(clean(fake))
        for (const { body } of fake.verdicts) assert.deepStrictEqual(thinkingIn(body), [])
        assert.isUndefined(yield* nextSends(api, chat), "nothing to show as sent")
      }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
    )

  it.live("the setting absent and at 0 make the same requests, byte for byte", () =>
    Effect.gen(function* () {
      const bodies: Array<Array<string>> = []
      for (const setting of [undefined, 0] as const) {
        const sent: Array<string> = []
        const fake = numbered()
        yield* Effect.scoped(
          Effect.gen(function* () {
            const mock = yield* mockOf((request, res) => {
              sent.push(JSON.stringify(request.body))
              return fake.handler(request, res)
            })
            const api = yield* client()
            const { chat, events } = yield* anthropic(api, mock.url, setting)
            yield* turn(api, chat, events, "The tide turns.")
          }).pipe(Effect.provide(serverLayer(testConfig())))
        )
        bodies.push(sent)
      }
      assert.strictEqual(bodies[0]!.length, 2)
      assert.deepStrictEqual(bodies[0], bodies[1])
    })
  )

  it.live("N=2 sends the last 2 replies' signed thinking while nothing before them changed", () =>
    Effect.gen(function* () {
      const fake = numbered()
      const mock = yield* mockOf(fake.handler)
      const api = yield* client()
      const { chat, events } = yield* anthropic(api, mock.url, 2)
      yield* turn(api, chat, events, "The tide turns.")
      assert.deepStrictEqual(thinkingIn(fake.verdicts.at(-1)!.body), ["Thought 1."])
      yield* turn(api, chat, events, "Mira laughs.")
      assert.deepStrictEqual(thinkingIn(fake.verdicts.at(-1)!.body), ["Thought 1.", "Thought 2."])
      const third = yield* turn(api, chat, events, "The lamp gutters.")
      // The oldest left the last 2: only the newest two go back.
      const sends = yield* nextSends(api, chat)
      assert.deepStrictEqual(
        sends?.items.filter((i) => i.part === "reasoning").map((i) => [i.sent, i.reason]),
        [
          [true, "sent"],
          [true, "sent"]
        ]
      )
      yield* turn(api, chat, events, "Night falls.")
      assert.deepStrictEqual(thinkingIn(fake.verdicts.at(-1)!.body), ["Thought 3.", "Thought 4."])
      assert.isTrue(clean(fake), JSON.stringify(fake.verdicts.map((v) => v.verdict)))
      // The thinking block goes first in the reply's message, the text after it.
      const last = fake.verdicts.at(-1)!.body
      const replay = last.messages.find(
        (m) => Array.isArray(m.content) && JSON.stringify(m.content).includes("Thought 4.")
      )!
      assert.deepStrictEqual(
        (replay.content as Array<Block>).map((b) => b.type),
        ["thinking", "text"]
      )
      assert.notInclude(yield* issuesOf(api, third.version.id), "reasoning_left_out")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("an edited earlier message drops the thinking after it, and keeps what's before it", () =>
    Effect.gen(function* () {
      const fake = numbered()
      const mock = yield* mockOf(fake.handler)
      const api = yield* client()
      const { chat, events } = yield* anthropic(api, mock.url, 3)
      const second = yield* turn(api, chat, events, "The tide turns.")
      yield* turn(api, chat, events, "Mira laughs.")
      // The user's message before reply 2 changes: reply 1 still fits, replies 2 and 3 don't.
      yield* api.EditVersion({
        slotId: second.user.slotId,
        sourceVersionId: second.user.version.id,
        content: "The tide turns early.",
        expectedRowVersion: second.user.rowVersion
      })
      const sends = yield* nextSends(api, chat)
      const reasons = new Map(sends!.items.filter((i) => i.part === "reasoning").map((i) => [i.versionId, i]))
      assert.strictEqual(reasons.size, 3)
      assert.deepStrictEqual([...reasons.values()].map((i) => i.reason).toSorted(), ["changed", "changed", "sent"])
      yield* turn(api, chat, events, "Night falls.")
      assert.deepStrictEqual(thinkingIn(fake.verdicts.at(-1)!.body), ["Thought 1."])
      assert.isTrue(clean(fake))
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("another model doesn't get the thinking, and the inspector says why", () =>
    Effect.gen(function* () {
      const fake = numbered()
      const mock = yield* mockOf(fake.handler)
      const api = yield* client()
      const { chat, events, connection } = yield* anthropic(api, mock.url, 2)
      const other = yield* api.AddUserModel({ connectionId: connection.id, key: "claude-other-model", overrides: {} })
      const defaults = yield* api.GetGenerationDefaults()
      yield* api.SetGenerationDefaults({
        defaults: { ...defaults, model: { connection: connection.id, model: other.id } }
      })
      const sends = yield* nextSends(api, chat)
      assert.deepStrictEqual(
        sends?.items.map((i) => [i.part, i.sent, i.reason]),
        [["reasoning", false, "model"]]
      )
      const next = yield* turn(api, chat, events, "The tide turns.")
      assert.deepStrictEqual(thinkingIn(fake.verdicts.at(-1)!.body), [])
      assert.include(yield* issuesOf(api, next.version.id), "reasoning_left_out")
      // The inspector has it; the reply shows no note for it.
      assert.notInclude(yield* shownIssues(api, next.version.id), "reasoning_left_out")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("hidden thinking isn't sent within the last N, and still counts as one of them", () =>
    Effect.gen(function* () {
      const fake = numbered()
      const mock = yield* mockOf(fake.handler)
      const api = yield* client()
      const { chat, events } = yield* anthropic(api, mock.url, 1, 1)
      const second = yield* turn(api, chat, events, "The tide turns.")
      yield* api.SetThinkingHidden({ versionId: second.version.id, part: "reasoning", hidden: true })
      const sends = yield* nextSends(api, chat)
      assert.deepStrictEqual(
        sends?.items.filter((i) => i.part === "reasoning").map((i) => [i.versionId, i.sent, i.reason]),
        [[second.version.id, false, "hidden"]]
      )
      yield* turn(api, chat, events, "Mira laughs.")
      // Not reply 2's (hidden), and not reply 1's in its place.
      assert.deepStrictEqual(thinkingIn(fake.verdicts.at(-1)!.body), [])
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("an edited reply's thinking is never sent as a signed block", () =>
    Effect.gen(function* () {
      const fake = numbered()
      const mock = yield* mockOf(fake.handler)
      const api = yield* client()
      const { chat, events } = yield* anthropic(api, mock.url, 2)
      const path = yield* api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 10 })
      const reply = path.entries.at(-1)!
      yield* api.EditVersion({
        slotId: reply.slotId,
        sourceVersionId: reply.version.id,
        content: reply.version.content,
        reasoning: "Thought 1, edited.",
        expectedRowVersion: reply.rowVersion
      })
      const sends = yield* nextSends(api, chat)
      assert.deepStrictEqual(
        sends?.items.map((i) => [i.sent, i.reason]),
        [[false, "unrecorded"]]
      )
      yield* turn(api, chat, events, "The tide turns.")
      assert.deepStrictEqual(thinkingIn(fake.verdicts.at(-1)!.body), [])
      assert.notInclude(JSON.stringify(fake.verdicts.at(-1)!.body), "edited")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("with the preset's end-of-request text, an earlier Claude model takes the last N back", () =>
    Effect.gen(function* () {
      const fake = numbered({ relaxed: true })
      const mock = yield* mockOf(fake.handler)
      const api = yield* client()
      const { chat, events } = yield* anthropic(api, mock.url, 2, 0, { key: EARLIER, endText: true })
      const second = yield* turn(api, chat, events, "The tide turns.")
      // The end text is the request's own last message, after the user's.
      const sent = fake.verdicts.at(-1)!.body.messages
      const user = sent.findLastIndex((m) => JSON.stringify(m.content).includes("The tide turns."))
      assert.isTrue(
        sent.slice(user + 1).some((m) => JSON.stringify(m.content).includes("Mira")),
        JSON.stringify(sent)
      )
      assert.deepStrictEqual(thinkingIn(fake.verdicts.at(-1)!.body), ["Thought 1."])
      yield* turn(api, chat, events, "Mira laughs.")
      // Any history before it: even an edited earlier message keeps every one.
      yield* api.EditVersion({
        slotId: second.user.slotId,
        sourceVersionId: second.user.version.id,
        content: "The tide turns early.",
        expectedRowVersion: second.user.rowVersion
      })
      yield* turn(api, chat, events, "Night falls.")
      assert.deepStrictEqual(thinkingIn(fake.verdicts.at(-1)!.body), ["Thought 2.", "Thought 3."])
      assert.isTrue(clean(fake))
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("with the end-of-request text, a bound model gets none, and the panel and inspector say why", () =>
    Effect.gen(function* () {
      const fake = numbered()
      const mock = yield* mockOf(fake.handler)
      const api = yield* client()
      const { chat, events } = yield* anthropic(api, mock.url, 2, 0, { endText: true })
      yield* turn(api, chat, events, "The tide turns.")
      const sends = yield* nextSends(api, chat)
      assert.deepStrictEqual(
        sends?.items.filter((i) => i.part === "reasoning").map((i) => [i.sent, i.reason]),
        [
          [false, "end"],
          [false, "end"]
        ]
      )
      const next = yield* turn(api, chat, events, "Mira laughs.")
      assert.deepStrictEqual(thinkingIn(fake.verdicts.at(-1)!.body), [])
      assert.isTrue(clean(fake))
      const run = yield* api.GetRunContext({ versionId: next.version.id })
      assert.isTrue(run.issues.some((i) => i.kind === "reasoning_left_out" && i.message.includes("end-of-request")))
      assert.notInclude(yield* shownIssues(api, next.version.id), "reasoning_left_out")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("a bound model's requests that send thinking back opt into the provider's check", () =>
    Effect.gen(function* () {
      const fake = numbered()
      const headers: Array<string> = []
      const mock = yield* mockOf((request, res) => {
        headers.push(String(request.headers["anthropic-beta"] ?? ""))
        return fake.handler(request, res)
      })
      const api = yield* client()
      const { chat, events } = yield* anthropic(api, mock.url, 1)
      yield* turn(api, chat, events, "The tide turns.")
      const binding = (i: number) =>
        (fake.verdicts[i]!.body as { thinking?: { block_binding?: unknown } }).thinking?.block_binding
      // The first request sends nothing back; the second does, with the setting and its beta.
      assert.isUndefined(binding(0))
      assert.notInclude(headers[0]!, "thinking-binding-controls-2026-08-01")
      assert.deepStrictEqual(thinkingIn(fake.verdicts[1]!.body), ["Thought 1."])
      assert.deepStrictEqual(binding(1), { prefix_mismatch_behavior: "drop_block" })
      assert.include(headers[1]!, "thinking-binding-controls-2026-08-01")
      // No mid-conversation effort messages, which the next request couldn't repeat as they were.
      for (const { body } of fake.verdicts)
        assert.isFalse(
          body.messages.some((m) => m.role === "system"),
          JSON.stringify(body.messages)
        )
      assert.isTrue(clean(fake))
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("what the provider says it left out is in the request inspector only", () =>
    Effect.gen(function* () {
      const fake = numbered({
        reportDropped: (body) => (thinkingIn(body).length > 0 ? ["messages.2.content.0"] : [])
      })
      const mock = yield* mockOf(fake.handler)
      const api = yield* client()
      const { chat, events } = yield* anthropic(api, mock.url, 1)
      const next = yield* turn(api, chat, events, "The tide turns.")
      assert.deepStrictEqual(thinkingIn(fake.verdicts.at(-1)!.body), ["Thought 1."])
      const run = yield* api.GetRunContext({ versionId: next.version.id })
      assert.isTrue(
        run.issues.some((i) => i.kind === "reasoning_left_out" && i.message.includes("left out by the provider")),
        JSON.stringify(run.issues)
      )
      assert.notInclude(yield* shownIssues(api, next.version.id), "reasoning_left_out")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("a bound model gets an unbroken run: hiding one in between keeps only the newer", () =>
    Effect.gen(function* () {
      const fake = numbered()
      const mock = yield* mockOf(fake.handler)
      const api = yield* client()
      const { chat, events, version: first } = yield* anthropic(api, mock.url, 3)
      const second = yield* turn(api, chat, events, "The tide turns.")
      const third = yield* turn(api, chat, events, "Mira laughs.")
      yield* api.SetThinkingHidden({ versionId: second.version.id, part: "reasoning", hidden: true })
      const sends = yield* nextSends(api, chat)
      const reason = new Map(sends!.items.filter((i) => i.part === "reasoning").map((i) => [i.versionId, i.reason]))
      assert.strictEqual(reason.get(first.id), "chain")
      assert.strictEqual(reason.get(second.version.id), "hidden")
      assert.strictEqual(reason.get(third.version.id), "sent")
      yield* turn(api, chat, events, "Night falls.")
      assert.deepStrictEqual(thinkingIn(fake.verdicts.at(-1)!.body), ["Thought 3."])
      assert.isTrue(clean(fake))
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  // The indicator is the request's own decision: what it says is sent is exactly what goes, on
  // a bound model (with and without the end-of-request text) and an earlier one.
  for (const model of ["bound", "bound, end text", "earlier, end text"] as const)
    for (const n of [0, 1, 2, 3])
      for (const change of ["none", "edit", "hide"] as const)
        it.live(`the indicator matches the request (${model}, N=${n}, ${change})`, () =>
          Effect.gen(function* () {
            const fake = numbered({ relaxed: model.startsWith("earlier") })
            const mock = yield* mockOf(fake.handler)
            const api = yield* client()
            const {
              chat,
              events,
              version: first
            } = yield* anthropic(api, mock.url, n, 0, {
              key: model.startsWith("earlier") ? EARLIER : BOUND,
              endText: model.endsWith("end text")
            })
            const second = yield* turn(api, chat, events, "The tide turns.")
            const third = yield* turn(api, chat, events, "Mira laughs.")
            if (change === "edit")
              yield* api.EditVersion({
                slotId: third.user.slotId,
                sourceVersionId: third.user.version.id,
                content: "Mira laughs aloud.",
                expectedRowVersion: third.user.rowVersion
              })
            if (change === "hide")
              yield* api.SetThinkingHidden({ versionId: second.version.id, part: "reasoning", hidden: true })
            const sends = yield* nextSends(api, chat)
            const said = new Set(
              (sends?.items ?? []).filter((i) => i.sent && i.part === "reasoning").map((i) => i.versionId)
            )
            yield* turn(api, chat, events, "Night falls.")
            const went = new Set(thinkingIn(fake.verdicts.at(-1)!.body))
            for (const [i, version] of [first, second.version, third.version].entries())
              assert.strictEqual(said.has(version.id), went.has(`Thought ${i + 1}.`), `reply ${i + 1}`)
            assert.isTrue(clean(fake))
            // A bound model never fits after the end text; an earlier one always takes the newest.
            if (model === "bound, end text") assert.strictEqual(said.size, 0)
            else if (n > 0 && (model === "earlier, end text" || change === "none")) assert.isAbove(said.size, 0)
          }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
        )
})

// --- OpenAI Responses: encrypted reasoning items

const responsesHandler = () => {
  let n = 0
  return (request: Recorded, res: ServerResponse) => {
    n++
    const thought = {
      type: "reasoning",
      id: `rs_${n}`,
      summary: [{ type: "summary_text", text: `Plan ${n}.` }],
      encrypted_content: `opaque-${n}`
    }
    const item = {
      type: "message",
      id: `msg_${n}`,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: `Reply ${n}.`, annotations: [] }]
    }
    sse(res, [
      { type: "response.output_item.added", output_index: 0, item: { ...thought, summary: [] } },
      { type: "response.reasoning_summary_text.delta", output_index: 0, summary_index: 0, delta: `Plan ${n}.` },
      { type: "response.output_item.done", output_index: 0, item: thought },
      { type: "response.output_item.added", output_index: 1, item: { ...item, content: [] } },
      { type: "response.output_text.delta", output_index: 1, content_index: 0, delta: `Reply ${n}.` },
      { type: "response.output_item.done", output_index: 1, item },
      {
        type: "response.completed",
        response: {
          id: `resp_${n}`,
          status: "completed",
          model: "mock-model",
          output: [thought, item],
          usage: { input_tokens: 20, output_tokens: 5 }
        }
      }
    ])
  }
}

const reasoningItems = (body: Record<string, unknown> | null | undefined) =>
  ((body?.input ?? []) as Array<Record<string, unknown>>).flatMap((item) =>
    item.type === "reasoning" ? [String(item.encrypted_content)] : []
  )

describe("encrypted reasoning on OpenAI Responses", () => {
  it.live("N=2 sends the last 2 replies' reasoning items back, before their messages", () =>
    Effect.gen(function* () {
      const mock = yield* mockOf(responsesHandler())
      const api = yield* client()
      const { chat, events, version } = yield* generateReply(api, {
        connection: { kind: "openai-responses", baseUrl: mock.url, apiKey: "synthetic-key" },
        model: {},
        ...presetWith(2)
      })
      assert.strictEqual(version.reasoning, "Plan 1.")
      yield* turn(api, chat, events, "The tide turns.")
      assert.deepStrictEqual(reasoningItems(mock.requests().at(-1)!.body), ["opaque-1"])
      yield* turn(api, chat, events, "Mira laughs.")
      yield* turn(api, chat, events, "Night falls.")
      const input = mock.requests().at(-1)!.body!.input as Array<Record<string, unknown>>
      assert.deepStrictEqual(reasoningItems(mock.requests().at(-1)!.body), ["opaque-2", "opaque-3"])
      const at = input.findIndex((item) => item.encrypted_content === "opaque-3")
      assert.strictEqual(input[at + 1]!.role, "assistant", "the reply's message follows its reasoning")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("with the preset's end-of-request text, the last N replies' items still go back", () =>
    Effect.gen(function* () {
      const mock = yield* mockOf(responsesHandler())
      const api = yield* client()
      const { chat, events } = yield* generateReply(api, {
        connection: { kind: "openai-responses", baseUrl: mock.url, apiKey: "synthetic-key" },
        model: {},
        ...presetWith(2, 0, true)
      })
      yield* turn(api, chat, events, "The tide turns.")
      assert.deepStrictEqual(reasoningItems(mock.requests().at(-1)!.body), ["opaque-1"])
      yield* turn(api, chat, events, "Mira laughs.")
      assert.deepStrictEqual(reasoningItems(mock.requests().at(-1)!.body), ["opaque-1", "opaque-2"])
      const sends = yield* nextSends(api, chat)
      assert.deepStrictEqual(
        sends?.items.map((i) => [i.sent, i.reason]),
        [
          [true, "sent"],
          [true, "sent"]
        ]
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("at the default, no reasoning item goes back", () =>
    Effect.gen(function* () {
      const mock = yield* mockOf(responsesHandler())
      const api = yield* client()
      const { chat, events } = yield* generateReply(api, {
        connection: { kind: "openai-responses", baseUrl: mock.url, apiKey: "synthetic-key" },
        model: {},
        ...presetWith(undefined)
      })
      yield* turn(api, chat, events, "The tide turns.")
      assert.deepStrictEqual(reasoningItems(mock.requests().at(-1)!.body), [])
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )
})

// --- Chat Completions: plain reasoning only where the provider documents taking it

const completionsWithReasoning = (field: "reasoning" | "reasoning_content") => {
  let n = 0
  return (_request: Recorded, res: ServerResponse) => {
    n++
    sse(res, [
      {
        id: `c_${n}`,
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { role: "assistant", [field]: `Musing ${n}.` }, finish_reason: null }]
      },
      {
        id: `c_${n}`,
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { content: `Reply ${n}.` }, finish_reason: null }]
      },
      { id: `c_${n}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      {
        id: `c_${n}`,
        object: "chat.completion.chunk",
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
      }
    ])
  }
}

const assistantsOf = (body: Record<string, unknown> | null | undefined) =>
  ((body?.messages ?? []) as Array<Record<string, unknown>>).filter((m) => m.role === "assistant")

describe("plain reasoning text", () => {
  it.live("OpenRouter takes it in `reasoning` on the reply's message", () =>
    Effect.gen(function* () {
      const mock = yield* mockOf(completionsWithReasoning("reasoning"))
      const api = yield* client()
      const { chat, events, version } = yield* generateReply(api, {
        connection: { kind: "openrouter", baseUrl: mock.url, apiKey: "synthetic-key" },
        modelKey: "deepseek/deepseek-r1",
        model: {},
        ...presetWith(1)
      })
      assert.strictEqual(version.reasoning, "Musing 1.")
      yield* turn(api, chat, events, "The tide turns.")
      const replies = assistantsOf(mock.requests().at(-1)!.body)
      const reply = replies.find((m) => m.content === "Reply 1.")!
      assert.strictEqual(reply.reasoning, "Musing 1.")
      assert.isUndefined(reply.reasoning_details)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  for (const kind of ["deepseek", "openai-chat"] as const)
    it.live(`${kind} gets no earlier reasoning, and the indicator says why`, () =>
      Effect.gen(function* () {
        const mock = yield* mockOf(completionsWithReasoning("reasoning_content"))
        const api = yield* client()
        const { chat, events, version } = yield* generateReply(api, {
          connection: { kind, baseUrl: `${mock.url}/v1`, apiKey: "synthetic-key" },
          model: {},
          ...presetWith(1)
        })
        assert.strictEqual(version.reasoning, "Musing 1.")
        const sends = yield* nextSends(api, chat)
        assert.deepStrictEqual(
          sends?.items.map((i) => [i.sent, i.reason]),
          [[false, kind === "deepseek" ? "ignored" : "provider"]]
        )
        yield* turn(api, chat, events, "The tide turns.")
        assert.notInclude(JSON.stringify(mock.requests().at(-1)!.body), "Musing 1.")
      }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
    )
})

// --- Tool runs keep their thinking whatever the setting

const lookup: RolloutTool<{ readonly topic: string }> = {
  id: "look_up",
  label: "Looked something up",
  effect: "read",
  description: "Looks up a detail of the story.",
  parameters: Type.Object({ topic: Type.String() }),
  execute: (_context, args) => Effect.succeed({ text: `${args.topic}: the keeper is Ansel.` })
}

describe("tool runs", () => {
  for (const setting of [undefined, 0] as const)
    it.live(`keep their thinking within the run with the send-back ${setting === undefined ? "absent" : "at 0"}`, () =>
      Effect.gen(function* () {
        const registry = yield* ExecutionRegistry
        yield* registry.rolloutTools.register(lookup as RolloutTool<never>)
        yield* registry.orchestrationModes.register({
          ...registry.orchestrationModes.get("default")!,
          plan: () => ({ strategy: "agent", tools: [lookup.id], contract: "final_text", turnCap: 6 })
        })
        const hasResult = (body: AnthropicBody) =>
          body.messages.some((m) => Array.isArray(m.content) && JSON.stringify(m.content).includes("tool_result"))
        const fake = enforcingAnthropic({
          reply: (body) =>
            hasResult(body)
              ? { thinking: "Ansel keeps it.", text: "Ansel keeps the lamp." }
              : { thinking: "I should check the keeper.", call: { name: "look_up", input: { topic: "keeper" } } }
        })
        const mock = yield* mockOf(fake.handler)
        const api = yield* client()
        const { version } = yield* generateReply(api, {
          connection: { kind: "anthropic", baseUrl: mock.url, apiKey: "sk-ant-made-up-for-tests-0000" },
          modelKey: "claude-test-model",
          model: {},
          state: [{ key: "agent.enabled" as const, value: { on: true } }],
          ...presetWith(setting)
        })
        assert.strictEqual(version.status, "complete", JSON.stringify(version.error))
        assert.isTrue(clean(fake))
        assert.deepStrictEqual(thinkingIn(fake.verdicts.at(-1)!.body), ["I should check the keeper."])
      }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
    )
})

// Hiding a reply's thinking from the model (SetThinkingHidden), and signed thinking left out
// where the provider would refuse it (providers/thinkingBinding.ts), through real generation.
// The Anthropic endpoint is an independent fake (support/enforcingAnthropic.ts): it issues
// signatures, checks each one against the request that carries it, and answers with
// Anthropic's own 400 messages. Synthetic chats only; nothing reaches a real provider.
import { assert, describe, it } from "@effect/vitest"
import { Type } from "@earendil-works/pi-ai"
import type { VersionId } from "@dreamspan/shared/chat.ts"
import type { ChatEvent } from "@dreamspan/shared/chatApi.ts"
import { Effect } from "effect"
import type { ServerResponse } from "node:http"
import type { RolloutTool } from "../src/agent/tools.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { ExecutionRegistry } from "../src/execution.ts"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"
import { type AnthropicBody, enforcingAnthropic } from "./support/enforcingAnthropic.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { json, type Recorded, sse, startMockProvider } from "./support/mockProvider.ts"

type Api = Effect.Success<ReturnType<typeof client>>

const lookup: RolloutTool<{ readonly topic: string }> = {
  id: "look_up",
  label: "Looked something up",
  effect: "read",
  description: "Looks up a detail of the story.",
  parameters: Type.Object({ topic: Type.String() }),
  execute: (_context, args) => Effect.succeed({ text: `${args.topic}: the keeper is Ansel.` })
}

const agentCapped = (turnCap: number) =>
  Effect.gen(function* () {
    const registry = yield* ExecutionRegistry
    yield* registry.rolloutTools.register(lookup as RolloutTool<never>)
    yield* registry.orchestrationModes.register({
      ...registry.orchestrationModes.get("default")!,
      plan: () => ({ strategy: "agent", tools: [lookup.id], contract: "final_text", turnCap })
    })
  })
const agent = agentCapped(6)

const agentOn = [{ key: "agent.enabled" as const, value: { on: true } }]

const mockOf = (handler: (request: Recorded, res: ServerResponse) => void | Promise<void>) =>
  Effect.acquireRelease(
    Effect.promise(() => startMockProvider(handler)),
    (m) => Effect.promise(() => m.close())
  )

type Block = { readonly type: string } & Record<string, unknown>
const blocksOf = (body: AnthropicBody) =>
  body.messages.flatMap((m) => (Array.isArray(m.content) ? (m.content as Array<Block>) : []))
const signedIn = (body: AnthropicBody) =>
  blocksOf(body).filter((b) => b.type === "thinking" || b.type === "redacted_thinking").length
const hasResult = (body: AnthropicBody) => blocksOf(body).some((b) => b.type === "tool_result")

const anthropicReply = (api: Api, url: string) =>
  generateReply(api, {
    connection: { kind: "anthropic", baseUrl: url, apiKey: "sk-ant-made-up-for-tests-0000" },
    modelKey: "claude-test-model",
    model: {},
    state: agentOn
  })

/** Resumes a stopped version as the client does, and waits for the new one to finish. */
const resume = (api: Api, events: ReadonlyArray<ChatEvent>, versionId: VersionId) =>
  Effect.gen(function* () {
    const me = yield* api.Whoami()
    const version = yield* (yield* Reader).GetVersion({ userId: me.id, versionId })
    const slot = yield* (yield* Reader).GetSlot({ userId: me.id, slotId: version.slotId })
    const entry = yield* api.ResumeVersion({ versionId, expectedRowVersion: slot.entry.rowVersion })
    yield* eventually(() => finished(events, entry.version.id) !== undefined)
    return finished(events, entry.version.id)!
  })

const issuesOf = (api: Api, versionId: VersionId) =>
  Effect.gen(function* () {
    const me = yield* api.Whoami()
    const version = yield* (yield* Reader).GetVersion({ userId: me.id, versionId })
    return (version.context?.issues ?? []).filter((i) => i.kind === "thinking_left_out").map((i) => i.message)
  })

describe("signed thinking through an agent run", () => {
  it.live("with nothing changed, the run sends its thinking back as it came, and nothing is noted", () =>
    Effect.gen(function* () {
      yield* agent
      const fake = enforcingAnthropic({
        reply: (body) =>
          hasResult(body)
            ? { thinking: "Ansel keeps it.", text: "Ansel keeps the lamp." }
            : { thinking: "I should check the keeper.", call: { name: "look_up", input: { topic: "keeper" } } }
      })
      const mock = yield* mockOf(fake.handler)
      const api = yield* client()
      const { version } = yield* anthropicReply(api, mock.url)
      assert.strictEqual(version.status, "complete", JSON.stringify(version.error))
      assert.strictEqual(version.content, "Ansel keeps the lamp.")
      assert.isTrue(
        fake.verdicts.every((v) => v.verdict.ok),
        JSON.stringify(fake.verdicts.map((v) => v.verdict))
      )
      assert.strictEqual(signedIn(fake.verdicts.at(-1)!.body), 1, "the tool turn's thinking goes back")
      assert.deepStrictEqual(yield* issuesOf(api, version.id), [])
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  for (const change of ["edit", "hide", "delete", "model settings"] as const)
    it.live(
      `Resume after ${change === "model settings" ? "the model's settings changed" : `an earlier message's ${change}`} sends the saved request, whose thinking still fits`,
      () =>
        Effect.gen(function* () {
          yield* agent
          let fail = true
          const fake = enforcingAnthropic({
            reply: (body) =>
              hasResult(body)
                ? { thinking: "Ansel keeps it.", text: "Ansel keeps the lamp." }
                : { thinking: "I should check the keeper.", call: { name: "look_up", input: { topic: "keeper" } } }
          })
          // The first run fails after its tool turn, so there's a run to resume.
          const mock = yield* mockOf((request, res) => {
            const body = request.body as unknown as AnthropicBody
            if (fail && request.path.startsWith("/v1/messages") && hasResult(body))
              return json(res, 529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } })
            return fake.handler(request, res)
          })
          const api = yield* client()
          const generated = yield* anthropicReply(api, mock.url)
          const { version, events, chat, connection } = generated
          assert.strictEqual(version.status, "failed")
          fail = false
          const path = yield* api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 10 })
          const earlier = path.entries.find((e) => e.side === "user")!
          if (change === "edit")
            yield* api.EditVersion({
              slotId: earlier.slotId,
              sourceVersionId: earlier.version.id,
              content: "Mira runs up the stairs.",
              expectedRowVersion: earlier.rowVersion
            })
          else if (change === "hide") yield* api.SetMessageHidden({ slotId: path.entries[0]!.slotId, hidden: true })
          else if (change === "delete") {
            const first = path.entries[0]!
            yield* api.DeleteMessage({ slotId: first.slotId })
          } else
            yield* api.UpdateConnection({
              connectionId: connection.id,
              expectedRowVersion: connection.rowVersion,
              settings: {
                name: "Renamed",
                baseUrl: mock.url,
                compat: connection.compat,
                cacheTtlS: connection.cacheTtlS,
                maxConcurrent: connection.maxConcurrent,
                presetOverrideRefId: connection.presetOverrideRefId
              }
            })
          const resumed = yield* resume(api, events, version.id)
          assert.strictEqual(resumed.status, "complete", JSON.stringify(resumed.error))
          const last = fake.verdicts.at(-1)!
          assert.isTrue(last.verdict.ok, JSON.stringify(last.verdict))
          assert.isTrue(hasResult(last.body), "the kept tool turn is carried on")
          // The same model resumes from the request as it was saved (spec/AGENTIC.md §12.3), so
          // the history it bound to is still the history sent.
          assert.strictEqual(signedIn(last.body), 1)
          assert.deepStrictEqual(yield* issuesOf(api, resumed.id), [])
        }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
    )

  it.live("the turn cap keeps Anthropic tools and thinking, forbidding calls with tool_choice none", () =>
    Effect.gen(function* () {
      yield* agentCapped(2)
      const fake = enforcingAnthropic({
        reply: (body) =>
          (body as { tool_choice?: { type: string } }).tool_choice?.type !== "none"
            ? { thinking: "I should check the keeper.", call: { name: "look_up", input: { topic: "keeper" } } }
            : { thinking: "Time to answer.", text: "Ansel keeps the lamp." }
      })
      const mock = yield* mockOf(fake.handler)
      const api = yield* client()
      const { version } = yield* anthropicReply(api, mock.url)
      assert.strictEqual(version.status, "complete", JSON.stringify(version.error))
      assert.isTrue(
        fake.verdicts.every((v) => v.verdict.ok),
        JSON.stringify(fake.verdicts.map((v) => v.verdict))
      )
      const last = fake.verdicts.at(-1)!
      assert.isTrue(hasResult(last.body))
      assert.strictEqual(signedIn(last.body), 1)
      assert.deepStrictEqual(last.body.tools, fake.verdicts[0]!.body.tools)
      assert.deepStrictEqual((last.body as { tool_choice?: unknown }).tool_choice, { type: "none" })
      assert.deepStrictEqual(yield* issuesOf(api, version.id), [])
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("Resume rebuilt with tools the chat offers now leaves the run's thinking out and says so", () =>
    Effect.gen(function* () {
      const registry = yield* ExecutionRegistry
      const noteDown: RolloutTool<{ readonly text: string }> = {
        id: "note_down",
        label: "Noted something",
        effect: "read",
        description: "Notes a detail of the story.",
        parameters: Type.Object({ text: Type.String() }),
        execute: () => Effect.succeed({ text: "Noted." })
      }
      yield* registry.rolloutTools.register(lookup as RolloutTool<never>)
      yield* registry.rolloutTools.register(noteDown as RolloutTool<never>)
      // The tools follow the chat's tool choice, as a capability turned on does.
      yield* registry.orchestrationModes.register({
        ...registry.orchestrationModes.get("default")!,
        plan: ({ state }) => ({
          strategy: "agent",
          tools: state.agentTools ? [...state.agentTools] : [lookup.id],
          contract: "final_text",
          turnCap: 6
        })
      })
      let fail = true
      const fake = enforcingAnthropic({
        reply: (body) =>
          hasResult(body)
            ? { thinking: "Ansel keeps it.", text: "Ansel keeps the lamp." }
            : { thinking: "I should check the keeper.", call: { name: "look_up", input: { topic: "keeper" } } }
      })
      const mock = yield* mockOf((request, res) => {
        const body = request.body as unknown as AnthropicBody
        if (fail && request.path.startsWith("/v1/messages") && hasResult(body))
          return json(res, 529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } })
        return fake.handler(request, res)
      })
      const api = yield* client()
      const { version, events, chat } = yield* anthropicReply(api, mock.url)
      assert.strictEqual(version.status, "failed")
      fail = false
      const me = yield* api.Whoami()
      yield* (yield* Writer).AddStateEvent({
        userId: me.id,
        chatId: chat.id,
        slotId: version.slotId,
        versionId: null,
        scope: null,
        data: { key: "agent.tools", value: { tools: [lookup.id, noteDown.id] } }
      })
      const resumed = yield* resume(api, events, version.id)
      assert.strictEqual(resumed.status, "complete", JSON.stringify(resumed.error))
      const last = fake.verdicts.at(-1)!
      assert.isTrue(last.verdict.ok, JSON.stringify(last.verdict))
      assert.include(
        (last.body.tools ?? []).map((t) => (t as { name: string }).name),
        "note_down",
        "the resumed request offers the tool added since"
      )
      assert.isTrue(hasResult(last.body))
      assert.strictEqual(signedIn(last.body), 0, "bound to the old tools, it would be refused")
      assert.lengthOf(yield* issuesOf(api, resumed.id), 1)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("Resume with nothing changed sends the kept thinking", () =>
    Effect.gen(function* () {
      yield* agent
      let fail = true
      const fake = enforcingAnthropic({
        reply: (body) =>
          hasResult(body)
            ? { thinking: "Ansel keeps it.", text: "Ansel keeps the lamp." }
            : { thinking: "I should check the keeper.", call: { name: "look_up", input: { topic: "keeper" } } }
      })
      const mock = yield* mockOf((request, res) => {
        const body = request.body as unknown as AnthropicBody
        if (fail && request.path.startsWith("/v1/messages") && hasResult(body))
          return json(res, 529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } })
        return fake.handler(request, res)
      })
      const api = yield* client()
      const { version, events } = yield* anthropicReply(api, mock.url)
      assert.strictEqual(version.status, "failed")
      fail = false
      const resumed = yield* resume(api, events, version.id)
      assert.strictEqual(resumed.status, "complete", JSON.stringify(resumed.error))
      const last = fake.verdicts.at(-1)!
      assert.isTrue(last.verdict.ok, JSON.stringify(last.verdict))
      assert.strictEqual(signedIn(last.body), 1)
      assert.deepStrictEqual(yield* issuesOf(api, resumed.id), [])
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("Resume after the user hid the reply's reasoning sends none of it", () =>
    Effect.gen(function* () {
      yield* agent
      let fail = true
      const fake = enforcingAnthropic({
        reply: (body) =>
          hasResult(body)
            ? { thinking: "Ansel keeps it.", text: "Ansel keeps the lamp." }
            : { thinking: "I should check the keeper.", call: { name: "look_up", input: { topic: "keeper" } } }
      })
      const mock = yield* mockOf((request, res) => {
        const body = request.body as unknown as AnthropicBody
        if (fail && request.path.startsWith("/v1/messages") && hasResult(body))
          return json(res, 529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } })
        return fake.handler(request, res)
      })
      const api = yield* client()
      const { version, events } = yield* anthropicReply(api, mock.url)
      assert.strictEqual(version.status, "failed")
      fail = false
      const hidden = yield* api.SetThinkingHidden({ versionId: version.id, part: "reasoning", hidden: true })
      assert.deepStrictEqual(hidden.hiddenThinking, ["reasoning"])
      const resumed = yield* resume(api, events, version.id)
      assert.strictEqual(resumed.status, "complete", JSON.stringify(resumed.error))
      const last = fake.verdicts.at(-1)!
      assert.isTrue(last.verdict.ok, JSON.stringify(last.verdict))
      assert.isTrue(hasResult(last.body))
      assert.strictEqual(signedIn(last.body), 0)
      assert.notInclude(JSON.stringify(last.body), "I should check the keeper.")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("a refusal the check didn't foresee is sent once more without the thinking", () =>
    Effect.gen(function* () {
      yield* agent
      let executions = 0
      yield* (yield* ExecutionRegistry).rolloutTools.register({
        ...lookup,
        execute: () => {
          executions++
          return Effect.succeed({ text: "Ansel." })
        }
      } as RolloutTool<never>)
      const fake = enforcingAnthropic({
        reply: (body) =>
          hasResult(body)
            ? { thinking: "Ansel keeps it.", text: "Ansel keeps the lamp." }
            : { thinking: "I should check the keeper.", call: { name: "look_up", input: { topic: "keeper" } } }
      })
      let refused = 0
      // A provider stricter than the fake: the first request carrying thinking is refused.
      const mock = yield* mockOf((request, res) => {
        const body = request.body as unknown as AnthropicBody
        if (request.path.startsWith("/v1/messages") && signedIn(body) > 0 && refused === 0) {
          refused++
          return json(res, 400, {
            type: "error",
            error: {
              type: "invalid_request_error",
              message:
                "messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation."
            }
          })
        }
        return fake.handler(request, res)
      })
      const api = yield* client()
      const { version, events } = yield* anthropicReply(api, mock.url)
      assert.strictEqual(version.status, "complete", JSON.stringify(version.error))
      assert.strictEqual(refused, 1)
      assert.strictEqual(executions, 1, "the retry never repeats a tool that already ran")
      assert.isTrue(events.some((e) => e._tag === "RequestNotice" && e.message.includes("Trying once")))
      const last = fake.verdicts.at(-1)!
      assert.isTrue(last.verdict.ok)
      assert.strictEqual(signedIn(last.body), 0)
      assert.lengthOf(yield* issuesOf(api, version.id), 1)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )
})

// Thinking captured from the reply by the preset's tags (spec/REPLY-SECTIONS.md).
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
const REPLY = "<thinking>\nPlan: Mira is wary.</thinking>\n\nThe ledger says otherwise."
const withSection = (res: ServerResponse) =>
  sse(res, [
    chunk({ role: "assistant", reasoning_content: "Provider reasoning." }),
    chunk({ content: REPLY }),
    chunk({}, "stop"),
    usage
  ])
const plain = (res: ServerResponse) =>
  sse(res, [chunk({ role: "assistant", content: "Fine." }), chunk({}, "stop"), usage])
type Message = { readonly role: string; readonly content: string }
const sentReply = (request: Recorded) =>
  (request.body as { messages: ReadonlyArray<Message> }).messages.find(
    (m) => m.role === "assistant" && m.content.includes("The ledger")
  )!.content

describe("hiding captured thinking", () => {
  it.live("leaves the section out of later requests in this fork and on this version only, and shows it again", () =>
    Effect.gen(function* () {
      let first = true
      const mock = yield* mockOf((_request, res) => {
        if (!first) return plain(res)
        first = false
        return withSection(res)
      })
      const api = yield* client()
      const { version, chat, events } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: { prefill: "assistant" },
        presetFields: {
          reply_sections: {
            enabled: true,
            pairs: [{ open: "<think(?:ing)?>", close: "</think(?:ing)?>", regex: true }],
            send_back: 1
          }
        }
      })
      assert.strictEqual(version.status, "complete")
      const me = yield* api.Whoami()
      const forkId = chat.currentForkId!
      const other = yield* (yield* Writer).CreateFork({
        userId: me.id,
        chatId: chat.id,
        fromForkId: forkId,
        atSlotId: version.slotId
      })
      const completions = () => mock.requests().filter((r) => r.path === "/v1/chat/completions")
      const next = Effect.fnUntraced(function* (fork: typeof forkId) {
        const { entry } = yield* posted(
          api.Generate({ chatId: chat.id, parentSlotId: version.slotId, branch: true, forkId: fork })
        )
        yield* eventually(() => finished(events, entry.version.id) !== undefined)
        return { request: completions().at(-1)!, versionId: entry.version.id }
      })

      const hidden = yield* api.SetThinkingHidden({ versionId: version.id, part: "sections", forkId, hidden: true })
      assert.deepStrictEqual(hidden.hiddenThinking, ["sections"])
      assert.strictEqual(hidden.version.id, version.id, "the message and its thinking stay")
      assert.deepStrictEqual(hidden.version.replySections, version.replySections)
      const inherited = yield* (yield* Writer).CreateFork({
        userId: me.id,
        chatId: chat.id,
        fromForkId: forkId,
        atSlotId: version.slotId
      })
      const inheritedChoice = yield* (yield* Reader).GetSlot({
        userId: me.id,
        slotId: version.slotId,
        forkId: inherited.fork.id
      })
      assert.deepStrictEqual(inheritedChoice.entry.hiddenThinking, ["sections"])
      const elsewhere = yield* (yield* Reader).GetSlot({ userId: me.id, slotId: version.slotId, forkId: other.fork.id })
      assert.isUndefined(elsewhere.entry.hiddenThinking, "another fork keeps it")

      const left = yield* next(forkId)
      assert.strictEqual(sentReply(left.request), "The ledger says otherwise.")
      assert.deepStrictEqual(yield* issuesOf(api, left.versionId as VersionId), [
        "Thinking you hid on an earlier reply was left out."
      ])
      const kept = yield* next(other.fork.id)
      assert.strictEqual(sentReply(kept.request), REPLY)

      // Another version of the message has its own: hiding is per version.
      const swiped = yield* api.Regenerate({ slotId: version.slotId, forkId, expectedRowVersion: hidden.rowVersion })
      assert.isUndefined(swiped.hiddenThinking)
      yield* eventually(() => finished(events, swiped.version.id) !== undefined)
      assert.deepStrictEqual(
        yield* (yield* Reader).GetThinkingHidden({ userId: me.id, versionId: version.id, forkId }),
        ["sections"]
      )
      const selected = yield* (yield* Reader).GetSlot({ userId: me.id, slotId: version.slotId, forkId })
      const back = yield* api.SelectVersion({
        slotId: version.slotId,
        forkId,
        versionId: version.id,
        expectedVersionId: selected.entry.version.id
      })
      assert.deepStrictEqual(back.hiddenThinking, ["sections"])

      const shown = yield* api.SetThinkingHidden({ versionId: version.id, part: "sections", forkId, hidden: false })
      assert.isUndefined(shown.hiddenThinking)
      const again = yield* next(forkId)
      assert.strictEqual(sentReply(again.request), REPLY)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )
})

it.live("review: Continue never prefills a section the user hid", () =>
  Effect.gen(function* () {
    let first = true
    const mock = yield* mockOf((_request, res) => {
      if (!first) return plain(res)
      first = false
      return withSection(res)
    })
    const api = yield* client()
    const { version, events } = yield* generateReply(api, {
      connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
      model: { prefill: "assistant" },
      presetFields: {
        reply_sections: {
          enabled: true,
          pairs: [{ open: "<thinking>", close: "</thinking>", regex: false }],
          send_back: 1
        }
      }
    })
    const hidden = yield* api.SetThinkingHidden({ versionId: version.id, part: "sections", hidden: true })
    const continued = yield* api.ContinueVersion({ versionId: version.id, expectedRowVersion: hidden.rowVersion })
    yield* eventually(() => finished(events, continued.version.id) !== undefined)
    assert.notInclude(JSON.stringify(mock.requests().at(-1)!.body), "Plan: Mira is wary.")
    assert.include(JSON.stringify(mock.requests().at(-1)!.body), "The ledger says otherwise.")
  }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
)

it.live("review: saved prefixes apply the branch's new thinking choice without changing pinned prose", () =>
  Effect.gen(function* () {
    let first = true
    const mock = yield* mockOf((_request, res) => {
      if (!first) return plain(res)
      first = false
      return withSection(res)
    })
    const api = yield* client()
    const { version, chat, events } = yield* generateReply(api, {
      connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
      model: { prefill: "assistant" },
      presetFields: {
        reply_sections: {
          enabled: true,
          pairs: [{ open: "<thinking>", close: "</thinking>", regex: false }],
          send_back: 1
        }
      }
    })
    const { entry } = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: version.slotId, branch: false }))
    yield* eventually(() => finished(events, entry.version.id) !== undefined)
    const me = yield* api.Whoami()
    const reader = yield* Reader
    const material = yield* reader.RolloutMaterial({ userId: me.id, versionId: entry.version.id })
    const old = JSON.parse(material.snapshot)
    assert.include(JSON.stringify(old.request), "Plan: Mira is wary.")
    const same = yield* reader.RebuildContext({
      userId: me.id,
      snapshot: material.snapshot,
      thinkingForkId: chat.currentForkId!
    })
    assert.strictEqual(same._tag, "Rebuilt")
    if (same._tag === "Rebuilt") assert.strictEqual(same.snapshot, material.snapshot)
    yield* api.SetThinkingHidden({ versionId: version.id, part: "sections", hidden: true })
    const rebuilt = yield* reader.RebuildContext({
      userId: me.id,
      snapshot: material.snapshot,
      thinkingForkId: chat.currentForkId!
    })
    assert.strictEqual(rebuilt._tag, "Rebuilt")
    if (rebuilt._tag !== "Rebuilt") return
    const next = JSON.parse(rebuilt.snapshot)
    assert.notInclude(JSON.stringify(next.request), "Plan: Mira is wary.")
    assert.include(JSON.stringify(next.request), "The ledger says otherwise.")
    assert.deepStrictEqual(next.inputs, old.inputs)
  }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
)

for (const exact of [false, true]) {
  it.live(
    `review: ${exact ? "a repeated binding refusal stops after one retry" : "another signature error is never retried"}`,
    () =>
      Effect.gen(function* () {
        yield* agent
        let executions = 0
        yield* (yield* ExecutionRegistry).rolloutTools.register({
          ...lookup,
          execute: () => {
            executions++
            return Effect.succeed({ text: "Ansel." })
          }
        } as RolloutTool<never>)
        const fake = enforcingAnthropic({
          reply: () => ({ thinking: "Check", call: { name: "look_up", input: { topic: "keeper" } } })
        })
        let attempts = 0
        const mock = yield* mockOf((request, res) => {
          if (request.path.startsWith("/v1/messages") && hasResult(request.body as unknown as AnthropicBody)) {
            attempts++
            return json(res, 400, {
              type: "error",
              error: {
                type: "invalid_request_error",
                message: exact
                  ? "Invalid `signature` in `thinking` block. The block is bound to a different conversation."
                  : "Invalid signature in thinking block."
              }
            })
          }
          return fake.handler(request, res)
        })
        const api = yield* client()
        const { version } = yield* anthropicReply(api, mock.url)
        assert.strictEqual(version.status, "failed")
        assert.strictEqual(attempts, exact ? 2 : 1)
        assert.strictEqual(executions, 1)
        const versions = yield* api.ListVersions({ slotId: version.slotId })
        assert.lengthOf(versions, 1, "an HTTP retry must not create a reply version")
      }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )
}

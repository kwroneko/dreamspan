// Multi-round tool runs on a bound-thinking Claude model (claudeThinking.ts
// `claudeBoundThinking`), against the enforcing fake with its run check on (prefix and unbroken
// run): within a run every request repeats the one before it as it was sent, so every thinking
// block the run wrote goes back. The causes this covers: the app's own messages (a nudge, the
// turn cap's message, a subagent's report or progress) sent last as a block and then as a
// string; tool images past the model's limit dropping the oldest from an earlier result; a
// refusal's stripped retry leaving the run broken for every later request. Requests that carry
// thinking opt into the provider's drop_block, and what it drops shows in the inspector only.
// Synthetic chats only; nothing reaches a real provider.
import { OPEN_LIBRARY } from "./support/libraryGrants.ts"
import { assert, describe, it } from "@effect/vitest"
import { Type } from "@earendil-works/pi-ai"
import type { VersionId } from "@dreamspan/shared/chat.ts"
import type { ChatEvent } from "@dreamspan/shared/chatApi.ts"
import { Effect, Stream } from "effect"
import type { ServerResponse } from "node:http"
import { imagesLeftOut } from "../src/agent/session.ts"
import type { RolloutTool } from "../src/agent/tools.ts"
import { Reader } from "../src/db/Database.ts"
import { ExecutionRegistry } from "../src/execution.ts"
import { DROP_NOTES, PROVIDER_RUN_DROP_NOTE, THINKING_BINDING_BETA } from "../src/providers/thinkingBinding.ts"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"
import { type AnthropicBody, enforcingAnthropic } from "./support/enforcingAnthropic.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { json, type Recorded, startMockProvider } from "./support/mockProvider.ts"

type Api = Effect.Success<ReturnType<typeof client>>

/** In pi-ai's catalog (its managed effort messages on), and one it doesn't know. */
const BOUND = "claude-opus-5-5"
const UNLISTED = "claude-opus-5-6"

const lookup: RolloutTool<{ readonly topic: string }> = {
  id: "look_up",
  label: "Looked something up",
  effect: "read",
  description: "Looks up a detail of the story.",
  parameters: Type.Object({ topic: Type.String() }),
  execute: (_context, args) => Effect.succeed({ text: `${args.topic}: the keeper is Ansel.` })
}

const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
/** A tool whose result carries an image, as an MCP server's can (spec/MCP.md §9). */
const picture: RolloutTool<{ readonly of: string }> = {
  id: "picture",
  label: "Looked at a picture",
  effect: "read",
  description: "Shows a picture of something in the story.",
  parameters: Type.Object({ of: Type.String() }),
  execute: (_context, args) =>
    Effect.succeed({ text: `A picture of ${args.of}.`, images: [{ data: PIXEL, mimeType: "image/png" }] })
}

const mockOf = (handler: (request: Recorded, res: ServerResponse) => void) =>
  Effect.acquireRelease(
    Effect.promise(() => startMockProvider(handler)),
    (m) => Effect.promise(() => m.close())
  )

type Block = { readonly type: string } & Record<string, unknown>
const unmark = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(unmark)
  if (value !== null && typeof value === "object") {
    const { cache_control: _marker, ...rest } = value as Record<string, unknown>
    return Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, unmark(v)]))
  }
  return value
}
const blocksOf = (body: AnthropicBody) =>
  body.messages.flatMap((m) => (Array.isArray(m.content) ? (m.content as Array<Block>) : []))
const thinkingIn = (body: AnthropicBody) =>
  body.messages.flatMap((m) =>
    m.role === "assistant" && Array.isArray(m.content)
      ? (m.content as Array<Block>).flatMap((b) => (b.type === "thinking" ? [String(b.thinking)] : []))
      : []
  )
const bindingOf = (body: AnthropicBody) => (body as { thinking?: { block_binding?: unknown } }).thinking?.block_binding

/**
 * Where `next` doesn't repeat `before` as it was sent (cache markers aside): its system, its
 * tools, or one of its messages. Empty when the history only grew.
 */
const editsBetween = (before: AnthropicBody, next: AnthropicBody) => {
  const out: Array<string> = []
  if (JSON.stringify(unmark(before.system)) !== JSON.stringify(unmark(next.system))) out.push("system")
  if (JSON.stringify(unmark(before.tools)) !== JSON.stringify(unmark(next.tools))) out.push("tools")
  for (const [i, m] of before.messages.entries())
    if (JSON.stringify(unmark(m)) !== JSON.stringify(unmark(next.messages[i])))
      out.push(`messages.${i}: ${JSON.stringify(unmark(m))} -> ${JSON.stringify(unmark(next.messages[i]))}`)
  return out
}

/** Every request repeats the one before it. */
const appendOnly = (bodies: ReadonlyArray<AnthropicBody>) => {
  for (const [i, body] of bodies.slice(1).entries())
    assert.deepStrictEqual(editsBetween(bodies[i]!, body), [], `request ${i + 2} edits request ${i + 1}`)
}
/** The provider took every request, and dropped nothing from any. */
const clean = (fake: ReturnType<typeof enforcingAnthropic>) =>
  assert.isTrue(
    fake.verdicts.every((v) => v.verdict.ok && !(v.verdict.dropped?.length ?? 0)),
    JSON.stringify(fake.verdicts.map((v) => v.verdict))
  )

const call = (n: number, name = "look_up", input: unknown = { topic: `t${n}` }) => ({
  thinking: `Thought ${n}.`,
  call: { name, input }
})
const done = (n: number) => ({ thinking: `Thought ${n}.`, text: "Ansel keeps the lamp." })
type Answer = ReturnType<Parameters<typeof enforcingAnthropic>[0]["reply"]>

/** A story reply run by the agent with `look_up` (and `picture` when the plan offers it). */
const storyRun = (options: {
  readonly plan: Record<string, unknown>
  readonly answer: (n: number, body: AnthropicBody) => Answer
  readonly key?: string
  readonly model?: Record<string, unknown>
  readonly reportDropped?: (body: AnthropicBody) => ReadonlyArray<string>
  /** Answers a request before the fake does; true when it did. */
  readonly before?: (body: AnthropicBody, res: ServerResponse) => boolean
}) =>
  Effect.gen(function* () {
    const registry = yield* ExecutionRegistry
    yield* registry.rolloutTools.register(lookup as RolloutTool<never>)
    yield* registry.rolloutTools.register(picture as RolloutTool<never>)
    yield* registry.orchestrationModes.register({
      ...registry.orchestrationModes.get("default")!,
      plan: () => ({ strategy: "agent", tools: [lookup.id], ...options.plan }) as never
    })
    let n = 0
    const fake = enforcingAnthropic({
      chain: true,
      reply: (body) => options.answer(++n, body),
      ...(options.reportDropped ? { reportDropped: options.reportDropped } : {})
    })
    const headers: Array<string> = []
    const mock = yield* mockOf((request, res) => {
      if (options.before?.(request.body as unknown as AnthropicBody, res)) return
      headers.push(String(request.headers["anthropic-beta"] ?? ""))
      fake.handler(request, res)
    })
    const api = yield* client()
    const generated = yield* generateReply(api, {
      connection: { kind: "anthropic", baseUrl: mock.url, apiKey: "sk-ant-made-up-for-tests-0000" },
      modelKey: options.key ?? BOUND,
      model: (options.model ?? {}) as never,
      state: [{ key: "agent.enabled" as const, value: { on: true } }]
    })
    return { ...generated, api, fake, headers, bodies: fake.verdicts.map((v) => v.body) }
  })

/** The notes a reply shows under it, and those the request inspector shows. */
const notesOf = (api: Api, versionId: VersionId) =>
  Effect.gen(function* () {
    const me = yield* api.Whoami()
    const version = yield* (yield* Reader).GetVersion({ userId: me.id, versionId })
    const run = yield* api.GetRunContext({ versionId })
    return { shown: version.context?.issues ?? [], inspector: run.issues }
  })

describe("tool runs on a bound-thinking model", () => {
  for (const key of [BOUND, UNLISTED])
    it.live(`each request repeats the one before it, with every block the run wrote (${key})`, () =>
      Effect.gen(function* () {
        const { version, fake, bodies, headers } = yield* storyRun({
          key,
          plan: { contract: "final_text", turnCap: 8 },
          answer: (n) => (n < 4 ? call(n) : done(n))
        })
        assert.strictEqual(version.status, "complete", JSON.stringify(version.error))
        clean(fake)
        appendOnly(bodies)
        assert.deepStrictEqual(thinkingIn(bodies.at(-1)!), ["Thought 1.", "Thought 2.", "Thought 3."])
        // Each request that carries thinking opts into the provider's drop_block with its beta,
        // whether or not pi-ai knows the model.
        for (const [i, body] of bodies.entries())
          if (thinkingIn(body).length > 0) {
            assert.deepNestedInclude(bindingOf(body) as object, { prefix_mismatch_behavior: "drop_block" })
            assert.include(headers[i]!, THINKING_BINDING_BETA)
          }
      }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
    )

  it.live("a nudge sent last keeps its shape in the rounds after it", () =>
    Effect.gen(function* () {
      const { version, fake, bodies } = yield* storyRun({
        plan: { contract: "send_message", turnCap: 8 },
        answer: (n) =>
          n === 1 || n === 3
            ? call(n)
            : n === 2
              ? { thinking: "Thought 2.", text: "Plain words." }
              : call(n, "send_message", { message: "Ansel keeps the lamp." })
      })
      assert.strictEqual(version.status, "complete", JSON.stringify(version.error))
      assert.strictEqual(version.content, "Ansel keeps the lamp.")
      clean(fake)
      appendOnly(bodies)
      assert.deepStrictEqual(thinkingIn(bodies.at(-1)!), ["Thought 1.", "Thought 2.", "Thought 3."])
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("the turn cap's message and the capped request repeat the run as it was", () =>
    Effect.gen(function* () {
      const { version, fake, bodies } = yield* storyRun({
        plan: { contract: "final_text", turnCap: 3 },
        answer: (n) => (n < 3 ? call(n) : done(n))
      })
      assert.strictEqual(version.status, "complete", JSON.stringify(version.error))
      clean(fake)
      appendOnly(bodies)
      assert.deepStrictEqual(thinkingIn(bodies.at(-1)!), ["Thought 1.", "Thought 2."])
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("tool images past the model's limit are left out where they arrive, never taken back", () =>
    Effect.gen(function* () {
      const { version, fake, bodies } = yield* storyRun({
        plan: { contract: "final_text", turnCap: 8, tools: [picture.id] },
        answer: (n) => (n < 5 ? call(n, "picture", { of: `p${n}` }) : done(n)),
        model: { vision: true, maxImages: 2 }
      })
      assert.strictEqual(version.status, "complete", JSON.stringify(version.error))
      clean(fake)
      appendOnly(bodies)
      assert.deepStrictEqual(thinkingIn(bodies.at(-1)!), ["Thought 1.", "Thought 2.", "Thought 3.", "Thought 4."])
      // The first two pictures are sent and stay; the later results say theirs were left out.
      const results = blocksOf(bodies.at(-1)!).filter((b) => b.type === "tool_result")
      const parts = (b: Block) => (Array.isArray(b.content) ? (b.content as Array<Block>) : [])
      assert.deepStrictEqual(
        results.map((r) => parts(r).filter((c) => c.type === "image").length),
        [1, 1, 0, 0]
      )
      assert.include(JSON.stringify(results[2]), imagesLeftOut(1))
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("after a refusal's retry without thinking, later rounds send the newer unbroken run", () =>
    Effect.gen(function* () {
      let refused = 0
      const { version, fake, bodies, api } = yield* storyRun({
        plan: { contract: "final_text", turnCap: 8 },
        answer: (n) => (n < 5 ? call(n) : done(n)),
        // A provider stricter than the fake: the first request that carries thinking is refused.
        before: (body, res) => {
          if (refused > 0 || thinkingIn(body).length === 0) return false
          refused++
          json(res, 400, {
            type: "error",
            error: {
              type: "invalid_request_error",
              message:
                "messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation."
            }
          })
          return true
        }
      })
      assert.strictEqual(version.status, "complete", JSON.stringify(version.error))
      assert.strictEqual(refused, 1)
      clean(fake)
      // The retry's block followed none, so the older one before it is left out from then on.
      assert.deepStrictEqual(thinkingIn(bodies.at(-1)!), ["Thought 2.", "Thought 3.", "Thought 4."])
      appendOnly(bodies.slice(1))
      const { shown } = yield* notesOf(api, version.id)
      assert.isTrue(
        shown.some((i) => i.kind === "thinking_left_out" && i.message === DROP_NOTES.chain),
        JSON.stringify(shown)
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("what the provider says it dropped from a run is noted in the request inspector only", () =>
    Effect.gen(function* () {
      const { version, api } = yield* storyRun({
        plan: { contract: "final_text", turnCap: 8 },
        answer: (n) => (n < 3 ? call(n) : done(n)),
        reportDropped: (body) => (thinkingIn(body).length > 0 ? ["messages.2.content.0"] : [])
      })
      assert.strictEqual(version.status, "complete", JSON.stringify(version.error))
      const { shown, inspector } = yield* notesOf(api, version.id)
      assert.isTrue(
        inspector.some((i) => i.kind === "reasoning_left_out" && i.message === PROVIDER_RUN_DROP_NOTE),
        JSON.stringify(inspector)
      )
      assert.isFalse(shown.some((i) => i.message === PROVIDER_RUN_DROP_NOTE))
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )
})

// Workshops: a subagent's run, a background one's progress and report, a skill loaded mid-run,
// and the next task carrying the run on.
const TRIGGER = "Workshop task:"
const CHILD = "You are a subagent"
const isChild = (body: AnthropicBody) =>
  JSON.stringify(body.system ?? "").includes(CHILD) || JSON.stringify(body.messages[0] ?? "").includes(CHILD)
const results = (messages: AnthropicBody["messages"]) =>
  messages
    .flatMap((m) => (Array.isArray(m.content) ? (m.content as Array<Block>) : []))
    .filter((b) => b.type === "tool_result").length
const resultsAfterTask = (body: AnthropicBody) => {
  const at = body.messages.findLastIndex((m) => m.role === "user" && JSON.stringify(m.content).includes(TRIGGER))
  return at < 0 ? -1 : results(body.messages.slice(at))
}
type Step = { readonly name: string; readonly input: unknown }
type Script = (done: number, body: AnthropicBody) => Step | string
const LIST: Step = { name: "list_library", input: { kind: "card" } }

const workshopRun = (parent: Script, child: Script, tasks: ReadonlyArray<string> = ["look through my cards"]) =>
  Effect.gen(function* () {
    let calls = 0
    const answer = (who: string, out: Step | string) =>
      typeof out === "string" ? { thinking: `${who} says.`, text: out } : { thinking: `${who} ${++calls}.`, call: out }
    const fake = enforcingAnthropic({
      chain: true,
      reply: (body) => {
        if (isChild(body)) return answer("Child", child(results(body.messages), body))
        const at = resultsAfterTask(body)
        return at < 0 ? { thinking: "Story.", text: "Ready." } : answer("Parent", parent(at, body))
      }
    })
    const mock = yield* mockOf(fake.handler)
    const api = yield* client()
    yield* generateReply(api, {
      connection: { kind: "anthropic", baseUrl: mock.url, apiKey: "sk-ant-made-up-for-tests-0000" },
      modelKey: BOUND,
      model: {}
    })
    const chat = yield* api.CreateWorkshop({ grants: OPEN_LIBRARY })
    const events: Array<ChatEvent> = []
    yield* api.SubscribeChat({ chatId: chat.id }).pipe(
      Stream.runForEach((batch) => Effect.sync(() => events.push(...batch))),
      Effect.forkScoped
    )
    yield* eventually(() => events.length > 0)
    for (const content of tasks) {
      const current = yield* api.GetChat({ chatId: chat.id })
      const sent = yield* posted(
        api.SendMessage({
          chatId: chat.id,
          parentSlotId: current.activeLeafSlotId,
          branch: false,
          content: `${TRIGGER} ${content}`
        })
      )
      const generated = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: sent.entry.slotId, branch: false }))
      const versionId = generated.entry.version.id
      yield* eventually(() => finished(events, versionId) !== undefined)
      assert.strictEqual(
        finished(events, versionId)!.status,
        "complete",
        JSON.stringify(finished(events, versionId)!.error)
      )
      // A run that waits for a background subagent writes its last message after it.
      yield* Effect.sleep(1500)
    }
    const sent = fake.verdicts.filter((v) => resultsAfterTask(v.body) >= 0 || isChild(v.body))
    return {
      fake,
      parents: sent.filter((v) => !isChild(v.body)).map((v) => v.body),
      children: sent.filter((v) => isChild(v.body)).map((v) => v.body)
    }
  })

describe("workshop runs on a bound-thinking model", () => {
  it.live("a background subagent's progress and report keep their shape in the rounds after them", () =>
    Effect.gen(function* () {
      const { fake, parents, children } = yield* workshopRun(
        (at, body) =>
          JSON.stringify(body.messages).includes("finished:")
            ? at < 3
              ? LIST
              : "Summed up."
            : at === 0
              ? { name: "agent", input: { type: "research", task: "List the cards.", name: "cards", background: true } }
              : at === 1
                ? LIST
                : "Waiting on the cards.",
        (at) =>
          at === 0
            ? { name: "report_progress", input: { text: "Read 1 of 2 shelves" } }
            : at === 1
              ? LIST
              : "Two cards."
      )
      clean(fake)
      appendOnly(parents)
      appendOnly(children)
      assert.include(JSON.stringify(parents.at(-1)!.messages), "finished:")
      assert.lengthOf(thinkingIn(parents.at(-1)!), 4)
      assert.lengthOf(thinkingIn(children.at(-1)!), 2)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("a skill loaded mid-run keeps every block", () =>
    Effect.gen(function* () {
      const { fake, parents } = yield* workshopRun(
        (at) => (at === 0 ? { name: "load_skill", input: { name: "cards" } } : at < 3 ? LIST : "Summed up."),
        () => "none"
      )
      clean(fake)
      appendOnly(parents)
      assert.lengthOf(thinkingIn(parents.at(-1)!), 3)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("the next task carries the run on with every block", () =>
    Effect.gen(function* () {
      const { fake, parents } = yield* workshopRun(
        (at) => (at < 2 ? LIST : "Summed up."),
        () => "none",
        ["look through my cards", "and again"]
      )
      clean(fake)
      appendOnly(parents)
      assert.lengthOf(thinkingIn(parents.at(-1)!), 5)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )
})

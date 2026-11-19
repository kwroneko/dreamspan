// Subagents' reasoning effort (spec/SUBAGENTS.md §2.5, §5.1; DESIGN §7.10 [P]): a model row's
// effort and a type's, the type's first, each only where the model takes that level; the level
// reaches each provider's request as the model's own "Reasoning effort" setting would, and the
// subagent's row names it. Synthetic data and scripted loopback providers only.
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import type { Chat } from "@dreamspan/shared/chat.ts"
import { supportedEfforts } from "@dreamspan/shared/modelSettings.ts"
import { effectiveEffort } from "@dreamspan/shared/subagents.ts"
import type { AssembledRequest, ModelInput } from "../src/assembler/types.ts"
import { providerRequest } from "../src/assembler/wire.ts"
import { withReasoning } from "../src/agent/subagents.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { type Api, completions, isChild, mockProvider, scripted, task, watch } from "./support/subagentScript.ts"
import { completionChunks, type Recorded, sse } from "./support/mockProvider.ts"
import type { ServerResponse } from "node:http"

describe("which effort a subagent asks for", () => {
  it("the type's, else its model row's, else none; a level the model doesn't take is passed over", () => {
    const all = supportedEfforts({ reasoning: { value: true }, thinkingLevels: { value: null } })
    assert.deepStrictEqual(all, ["minimal", "low", "medium", "high", "xhigh", "max"])
    assert.strictEqual(effectiveEffort("low", "high", all), "low")
    assert.strictEqual(effectiveEffort(undefined, "high", all), "high")
    assert.strictEqual(effectiveEffort(null, "high", all), "high")
    assert.strictEqual(effectiveEffort(undefined, undefined, all), null)
    // A model that doesn't reason takes none: both are ignored.
    const none = supportedEfforts({ reasoning: { value: false }, thinkingLevels: { value: null } })
    assert.deepStrictEqual(none, [])
    assert.strictEqual(effectiveEffort("low", "high", none), null)
    // A level its map marks unsupported falls through to the row's.
    const capped = supportedEfforts({
      reasoning: { value: true },
      thinkingLevels: { value: { xhigh: null, max: null, high: "high" } }
    })
    assert.deepStrictEqual(capped, ["minimal", "low", "medium", "high"])
    assert.strictEqual(effectiveEffort("max", "medium", capped), "medium")
    assert.strictEqual(effectiveEffort("max", "xhigh", capped), null)
  })
})

const request: AssembledRequest = {
  messages: [
    { role: "system", content: "Synthetic instructions." },
    { role: "user", content: "Your task: look." }
  ],
  prefill: null,
  useSystemPrompt: true,
  names: { user: "", char: "", group: [] },
  breakpoints: [],
  samplers: {
    temperature: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
    top_p: 1,
    top_k: 0,
    top_a: 0,
    min_p: 0,
    repetition_penalty: 1,
    max_tokens: 64,
    seed: -1
  }
}

const modelFor = (kind: string, api: string, key: string): ModelInput => ({
  connectionId: "c",
  modelId: "m",
  kind,
  api,
  key,
  prefill: "none",
  cacheBreakpoints: "auto",
  context: null,
  settings: { samplers: { reasoning_effort: "low" } },
  presetOverride: null
})

describe("each provider's request carries a subagent's effort", () => {
  it("as the model's own setting would, over it", () => {
    const chat = providerRequest(request, withReasoning(modelFor("openai-chat", "openai-completions", "o"), "high"))
    assert.strictEqual(chat.reasoning, "high")
    assert.strictEqual(chat.payload.reasoning_effort, "high")
    const responses = providerRequest(request, withReasoning(modelFor("openai", "openai-responses", "gpt"), "xhigh"))
    assert.strictEqual(responses.reasoning, "xhigh")
    assert.deepStrictEqual(responses.payload.reasoning, { effort: "xhigh" })
    // Anthropic and Google take it through pi-ai's thinking level (their own mapping), not a payload field.
    for (const [kind, api, key] of [
      ["anthropic", "anthropic-messages", "claude-sonnet-4-5"],
      ["google", "google-generative-ai", "gemini-2.5-pro"]
    ] as const) {
      const wire = providerRequest(request, withReasoning(modelFor(kind, api, key), "medium"))
      assert.strictEqual(wire.reasoning, "medium")
      assert.notProperty(wire.payload, "reasoning_effort")
    }
    // None: the model's own setting stays.
    assert.strictEqual(
      providerRequest(request, withReasoning(modelFor("x", "openai-completions", "o"), null)).reasoning,
      "low"
    )
  })
})

const LIST = { name: "list_library", args: { kind: "card" }, id: "child-list" }

/** The second provider answers as a subagent would: one lookup, then its report. */
const childHandler = (request: Recorded, res: ServerResponse) => {
  const body = request.body as { messages: ReadonlyArray<{ role: string }> }
  if (body.messages.some((m) => m.role === "tool")) return sse(res, completionChunks(["Report."], {}))
  sse(res, [
    {
      id: "c",
      object: "chat.completion.chunk",
      model: "m",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              { index: 0, id: LIST.id, type: "function", function: { name: LIST.name, arguments: '{"kind":"card"}' } }
            ]
          },
          finish_reason: null
        }
      ]
    },
    {
      id: "c",
      object: "chat.completion.chunk",
      model: "m",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }]
    }
  ])
}

const setup = (reasons: boolean) =>
  Effect.gen(function* () {
    const script = scripted({
      parent: [{ name: "agent", args: { type: "research", task: "List the cards.", model: "cheap" }, id: "call-1" }],
      child: (done) => (done === 0 ? LIST : undefined),
      report: "Same report."
    })
    const first = yield* mockProvider(script.handler)
    const second = yield* mockProvider(childHandler)
    const api: Api = yield* client()
    yield* generateReply(api, { connection: { kind: "openai-chat", baseUrl: `${first.url}/v1` }, model: {} })
    const connection = yield* api.CreateConnection({
      kind: "openai-chat",
      settings: {
        name: "Second",
        baseUrl: `${second.url}/v1`,
        compat: {},
        cacheTtlS: null,
        maxConcurrent: null,
        presetOverrideRefId: null
      }
    })
    const model = yield* api.AddUserModel({
      connectionId: connection.id,
      key: "cheap-model",
      overrides: reasons ? { reasoning: true } : {}
    })
    const pick = `${connection.id} ${model.id}`
    yield* api.ChangeSubagentSettings({
      picks: ["same", pick],
      rows: { [pick]: { alias: "cheap", note: "", effort: "high" } }
    })
    const chat: Chat = yield* api.CreateWorkshop({})
    const events = yield* watch(api, chat)
    return { api, chat, events, first, second }
  })

const run = (reasons: boolean, typeEffort?: "low") =>
  Effect.gen(function* () {
    const { api, chat, events, first, second } = yield* setup(reasons)
    if (typeEffort) yield* api.ChangeSubagentType({ id: "research", edit: { id: "research", effort: typeEffort } })
    const versionId = yield* task(api, chat, "look through my cards")
    yield* eventually(() => finished(events, versionId) !== undefined)
    assert.strictEqual(finished(events, versionId)!.status, "complete")
    const steps = yield* api.GetRolloutSteps({ versionId })
    const row = steps.flatMap((s) => (s.kind === "tool" && s.subagent ? [s.subagent] : []))[0]!
    const child = completions(second.requests()) as unknown as ReadonlyArray<Record<string, unknown>>
    const parent = completions(first.requests()).filter((b) => !isChild(b)) as unknown as ReadonlyArray<
      Record<string, unknown>
    >
    return { api, row, child, parent }
  })

describe("a subagent's requests", () => {
  it.live("ask for its model row's effort, and its row names it; the reply's own requests don't", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const { row, child, parent } = yield* run(true)
      assert.lengthOf(child, 2)
      for (const body of child) assert.strictEqual(body.reasoning_effort, "high")
      for (const body of parent) assert.notProperty(body, "reasoning_effort")
      assert.strictEqual(row.effort, "high")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("ask for the type's effort over the row's, and the types list shows it", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const { api, row, child } = yield* run(true, "low")
      for (const body of child) assert.strictEqual(body.reasoning_effort, "low")
      assert.strictEqual(row.effort, "low")
      const research = (yield* api.GetSubagentTypes({})).types.find((t) => t.id === "research")!
      assert.strictEqual(research.effort, "low")
      assert.isTrue(research.edited)
      // Back to none of its own: the change is dropped (a built-in type has none).
      yield* api.ChangeSubagentType({ id: "research", edit: { id: "research", effort: null } })
      const restored = (yield* api.GetSubagentTypes({})).types.find((t) => t.id === "research")!
      assert.isNull(restored.effort)
      assert.isFalse(restored.edited)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("ask for none on a model that doesn't reason, whatever the row and the type say", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const { row, child } = yield* run(false, "low")
      assert.lengthOf(child, 2)
      for (const body of child) assert.notProperty(body, "reasoning_effort")
      assert.isUndefined(row.effort)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})

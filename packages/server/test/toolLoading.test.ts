// Dynamic tool loading (spec/TOOL-LOADING.md): the split, the transcript-derived loaded set, card
// skills, and the wire: the requests before and after a load share their prefix byte for byte.
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { writeFileSync } from "node:fs"
import { normalizeContext, type Api, type Message, type Model, type Tool } from "@earendil-works/pi-ai"
import { foldState } from "@rp/shared/state.ts"
import { ExecutionRegistry, toolForKind } from "../src/execution.ts"
import {
  cardSkills,
  loadedSet,
  loadPoints,
  runSkills,
  searchTools,
  skillsFor,
  splitOffer,
  orphansOf,
  loadSkillDescription,
  toolSearchDescription
} from "../src/agent/toolLoading.ts"
import {
  applyAnthropicToolLoading,
  applyResponsesToolLoading,
  applyRouterToolLoading,
  LOADED_DEFINITIONS
} from "../src/providers/toolLoading.ts"
import { prepareTokenizer } from "../src/importer/tokenizer.ts"
import type { RolloutTool } from "../src/agent/tools.ts"
import { planStepResume, StepNotResumable } from "../src/agent/resume.ts"

type AnyTool = RolloutTool<never>

const workshopTools = Effect.gen(function* () {
  const registry = yield* ExecutionRegistry
  const plan = registry.orchestrationModes.get("workshop")!.plan({ state: foldState([]), kind: "workshop" })
  return { registry, tools: plan.tools.map((name) => toolForKind(registry, "workshop", name)!) }
})

const split = (
  registry: ExecutionRegistry["Service"],
  tools: ReadonlyArray<AnyTool>,
  kind: string,
  target: { kind: string; api: string; key: string }
) =>
  splitOffer({
    tools,
    profile: registry.toolLoadingProfiles.get(kind),
    wire: registry.toolLoadingWires.get(target.api),
    target,
    // As loadingPlan.ts builds them: the skill index and the uncovered tools in the descriptions.
    loaders: (deferred) => {
      const names = deferred.map((t) => t.id)
      const skills = skillsFor(runSkills(registry.skills.list(), kind, []), names)
      return [
        { ...registry.toolLoaders.get("tool_search")!, description: toolSearchDescription(orphansOf(names, skills)) },
        { ...registry.toolLoaders.get("load_skill")!, description: loadSkillDescription(skills) }
      ]
    }
  })

const claude = { kind: "anthropic", api: "anthropic-messages", key: "claude-sonnet-4-5" }

describe("built-in skills come with every workshop, whatever its card", () => {
  it.effect("with no card, a plain card or a card of its own, they cover every deferred workshop tool", () =>
    Effect.gen(function* () {
      const { registry, tools } = yield* workshopTools
      const offer = split(registry, tools, "workshop", claude)
      const deferred = [...offer.deferred]
      const plain = cardSkills({}, { entity: "mine", name: "My card" })
      const own = cardSkills(
        {
          extensions: {
            rp_harness: {
              skills: [{ name: "proofread", description: "Checks spelling.", instructions: "List typos.", tools: [] }]
            }
          }
        },
        { entity: "other", name: "Proofreader" }
      )
      for (const cards of [[], [plain], [own]]) {
        const skills = skillsFor(runSkills(registry.skills.list(), "workshop", cards), deferred)
        const builtins = skills.filter((s) => !s.source).map((s) => s.id)
        assert.deepStrictEqual(
          builtins,
          registry.skills.list().map((s) => s.id)
        )
        assert.deepStrictEqual(orphansOf(deferred, skills), [])
      }
    }).pipe(Effect.provide(ExecutionRegistry.layer))
  )

  it.effect("beside a story, the story tools are callable from the start and the rest are in skills", () =>
    Effect.gen(function* () {
      const registry = yield* ExecutionRegistry
      const plan = registry.orchestrationModes
        .get("workshop")!
        .plan({ state: { ...foldState([]), workshopAttached: "story-chat" }, kind: "workshop" })
      const tools = plan.tools.map((name) => toolForKind(registry, "workshop", name)!)
      const offer = split(registry, tools, "workshop", claude)
      for (const name of ["search_story", "read_story", "open_story_summary", "search_story_summaries"]) {
        assert.include(
          offer.tools.map((t) => t.id),
          name
        )
        assert.isFalse(offer.deferred.has(name), `${name} is sent from the start`)
      }
      const deferred = [...offer.deferred]
      assert.deepStrictEqual(
        orphansOf(deferred, skillsFor(runSkills(registry.skills.list(), "workshop", []), deferred)),
        []
      )
    }).pipe(Effect.provide(ExecutionRegistry.layer))
  )

  it.effect("a card's own skills come on top of the built-in ones", () =>
    Effect.gen(function* () {
      const { registry } = yield* workshopTools
      const own = cardSkills(
        {
          extensions: {
            rp_harness: {
              skills: [
                {
                  name: "proofread",
                  description: "Checks spelling.",
                  instructions: "List typos.",
                  tools: ["read_card"]
                }
              ]
            }
          }
        },
        { entity: "other", name: "Proofreader" }
      )
      const ids = runSkills(registry.skills.list(), "workshop", [own]).map((s) => s.id)
      assert.deepStrictEqual(ids, [...registry.skills.list().map((s) => s.id), "proofread"])
    }).pipe(Effect.provide(ExecutionRegistry.layer))
  )
})

describe("the split", () => {
  it.effect("defers the workshop's tools for Claude 4.5 and later on Anthropic's API", () =>
    Effect.gen(function* () {
      const { registry, tools } = yield* workshopTools
      const offer = split(registry, tools, "workshop", claude)
      assert.deepStrictEqual(
        offer.tools.slice(0, 3).map((t) => t.id),
        ["list_library", "tool_search", "load_skill"]
      )
      assert.strictEqual(offer.deferred.size, tools.length - 1)
      assert.isFalse(offer.deferred.has("list_library"))
    }).pipe(Effect.provide(ExecutionRegistry.layer))
  )

  it.effect("sends everything where no wire is measured, for older models, and in RP", () =>
    Effect.gen(function* () {
      const { registry, tools } = yield* workshopTools
      for (const target of [
        { kind: "openai-chat", api: "openai-completions", key: "gpt-5.4" },
        { kind: "openrouter", api: "openai-completions", key: "anthropic/claude-sonnet-4.5" },
        { kind: "deepseek", api: "openai-completions", key: "deepseek-chat" },
        // Bedrock and Vertex speak Anthropic's API, but neither is measured yet.
        { kind: "bedrock", api: "anthropic-messages", key: "us.anthropic.claude-sonnet-4-5-v1:0" },
        { kind: "vertex", api: "anthropic-messages", key: "claude-sonnet-4-5" },
        { kind: "anthropic", api: "anthropic-messages", key: "claude-sonnet-4-0" },
        { kind: "openai-responses", api: "openai-responses", key: "gpt-5.2" },
        { kind: "openai-responses", api: "openai-responses", key: "gpt-5.4" }
      ]) {
        const offer = split(registry, tools, "workshop", target)
        assert.strictEqual(offer.deferred.size, 0, target.key)
        assert.strictEqual(offer.tools, tools, target.key)
      }
      assert.strictEqual(split(registry, tools, "rp", claude).deferred.size, 0)
    }).pipe(Effect.provide(ExecutionRegistry.layer))
  )

  it.effect("defers on OpenRouter only for the measured models and upstreams", () =>
    Effect.gen(function* () {
      const { registry, tools } = yield* workshopTools
      const route = (only: Array<string>) => ({ routing: { only, allow_fallbacks: false } })
      const cases: ReadonlyArray<[string, Record<string, unknown> | undefined, boolean]> = [
        ["anthropic/claude-sonnet-4.5", route(["anthropic"]), true],
        ["anthropic/claude-haiku-4.5", route(["google-vertex"]), true],
        ["anthropic/claude-opus-5.5", route(["google-vertex/us-east5"]), true],
        ["anthropic/claude-sonnet-4.5", undefined, false],
        ["anthropic/claude-sonnet-4.5", { routing: { order: ["anthropic"] } }, false],
        ["anthropic/claude-sonnet-4.5", { routing: { order: ["anthropic"], allow_fallbacks: true } }, false],
        ["anthropic/claude-sonnet-4.5", { routing: { order: ["anthropic"], allow_fallbacks: false } }, true],
        ["anthropic/claude-sonnet-4.5", { routing: { only: ["anthropic"], allow_fallbacks: true } }, true],
        ["anthropic/claude-sonnet-4.5", { routing: { only: ["anthropic"], ignore: ["anthropic"] } }, false],
        ["anthropic/claude-sonnet-4.5", route(["anthropic", "amazon-bedrock"]), false],
        // Bedrock rewrites the whole cache at the first call of each loaded tool (measured).
        ["anthropic/claude-sonnet-4.5", route(["amazon-bedrock"]), false],
        ["anthropic/claude-sonnet-4", route(["anthropic"]), false],
        ["openai/gpt-5.4-mini", undefined, false],
        // OpenRouter defers it itself, and each newly called loaded tool rewrote the cache (measured).
        ["deepseek/deepseek-v4-flash", route(["deepseek"]), false]
      ]
      for (const [key, settings, defers] of cases) {
        const offer = split(registry, tools, "workshop", {
          kind: "openrouter",
          api: "openai-completions",
          key,
          ...(settings ? { settings } : {})
        })
        assert.strictEqual(offer.deferred.size > 0, defers, `${key} ${JSON.stringify(settings)}`)
      }
    }).pipe(Effect.provide(ExecutionRegistry.layer))
  )

  it.live("sends far fewer tool tokens before anything is loaded", () =>
    Effect.gen(function* () {
      const { registry, tools } = yield* workshopTools
      const offer = split(registry, tools, "workshop", claude)
      const count = yield* Effect.promise(() => prepareTokenizer("o200k_base"))
      const tokens = (list: ReadonlyArray<AnyTool>) =>
        count(JSON.stringify(list.map((t) => ({ name: t.id, description: t.description, input_schema: t.parameters }))))
      const before = tokens(tools)
      // Deferred definitions aren't part of the prompt until loaded (Anthropic's tool search guide).
      const after = tokens(offer.tools.filter((t) => !offer.deferred.has(t.id)))
      if (process.env.TOOL_LOADING_MEASUREMENT_OUTPUT)
        writeFileSync(
          process.env.TOOL_LOADING_MEASUREMENT_OUTPUT,
          JSON.stringify({ before, after, tools: tools.length })
        )
      assert.isBelow(after * 3, before)
    }).pipe(Effect.provide(ExecutionRegistry.layer))
  )
})

describe("step edits keep loads where the transcript has them", () => {
  const frozen = [
    {
      name: "tool_search",
      label: "Looked for tools",
      description: "d",
      parameters: { type: "object", properties: {} },
      effect: "read"
    },
    {
      name: "read_card",
      label: "Read",
      description: "d",
      parameters: { type: "object", properties: {} },
      effect: "read",
      deferred: true
    }
  ] as const
  const turn = (id: string, name: string) => ({
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: {} }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "m",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: "toolUse",
    timestamp: 0
  })
  const transcript = JSON.stringify([
    { role: "rpRequest", timestamp: 0 },
    turn("c1", "tool_search"),
    {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "tool_search",
      content: [{ type: "text", text: "Loaded." }],
      details: { loaded: ["read_card"] },
      isError: false,
      timestamp: 0
    },
    turn("c2", "read_card"),
    {
      role: "toolResult",
      toolCallId: "c2",
      toolName: "read_card",
      content: [{ type: "text", text: "Card." }],
      details: null,
      isError: false,
      timestamp: 0
    }
  ])
  const deferred = new Set(["read_card"])

  it("editing a load's result text keeps the load", () => {
    const plan = planStepResume(transcript, frozen as never, 0, { kind: "result", text: "Edited." }, "new", "v")
    assert.notInstanceOf(plan, StepNotResumable)
    if (!(plan instanceof StepNotResumable))
      assert.deepStrictEqual([...loadedSet(plan.transcript as never, deferred)], ["read_card"])
  })

  it("editing a loading call's arguments drops the load until it runs again", () => {
    const plan = planStepResume(transcript, frozen as never, 0, { kind: "arguments", arguments: {} }, "new", "v")
    assert.notInstanceOf(plan, StepNotResumable)
    if (!(plan instanceof StepNotResumable)) assert.strictEqual(loadedSet(plan.transcript as never, deferred).size, 0)
  })
})

describe("the loaded set", () => {
  const result = (id: string, loaded: unknown, isError = false) =>
    ({
      role: "toolResult",
      toolCallId: id,
      toolName: "tool_search",
      content: [{ type: "text", text: "Loaded." }],
      details: { loaded },
      isError,
      timestamp: 0
    }) as Message

  it("comes from successful loading results, each tool at its first load", () => {
    const deferred = new Set(["read_card", "edit_card", "read_preset"])
    const messages = [
      result("a", ["read_card"]),
      result("b", ["read_card", "edit_card"]),
      result("c", ["read_preset"], true),
      result("d", ["not_offered"])
    ].flatMap((r) => [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: r.role === "toolResult" ? r.toolCallId : "", name: "tool_search", arguments: {} }
        ]
      } as Message,
      r
    ])
    assert.deepStrictEqual(loadPoints(messages, deferred), [
      { toolCallId: "a", names: ["read_card"] },
      { toolCallId: "b", names: ["edit_card"] }
    ])
    assert.deepStrictEqual([...loadedSet(messages, deferred)], ["read_card", "edit_card"])
  })

  it("keyword search weighs names over descriptions", () => {
    const found = searchTools(
      [
        { name: "read_preset", description: "Reads a preset." },
        { name: "edit_card", description: "Changes a card's fields." },
        { name: "read_card", description: "Reads a card." }
      ],
      "card",
      5
    )
    assert.deepStrictEqual(found, ["edit_card", "read_card"])
  })
})

describe("card skills", () => {
  it("reads references and the card's own skills, ignoring anything else", () => {
    const doc = {
      extensions: {
        rp_harness: {
          skills: [
            { use: "cards" },
            { use: "Not A Name" },
            {
              name: "proofread",
              description: "Checks spelling.",
              instructions: "Read, then list typos.",
              tools: ["read_card"]
            },
            { name: "no-instructions", description: "Missing." },
            "junk"
          ]
        },
        other_app: { skills: [{ use: "cards" }] }
      }
    }
    const parsed = cardSkills(doc, { entity: "e1", name: "Helper" })
    assert.deepStrictEqual(parsed.uses, ["cards"])
    assert.deepStrictEqual(
      parsed.own.map((s) => [s.id, s.tools, s.source]),
      [["proofread", ["read_card"], { card: "e1", name: "Helper" }]]
    )
    assert.deepStrictEqual(cardSkills({}, { entity: "e1", name: "Plain" }), { uses: [], own: [] })
  })

  it("can't stand in for a registered skill, and names optional ones it uses", () => {
    const registered = [
      { id: "cards", label: "Cards", description: "d", instructions: "i", tools: ["read_card"] },
      { id: "extra", label: "Extra", description: "d", instructions: "i", tools: [], always: false }
    ]
    const card = {
      uses: ["extra"],
      own: [
        {
          id: "cards",
          label: "cards",
          description: "fake",
          instructions: "x",
          tools: ["*"],
          source: { card: "e", name: "C" }
        },
        { id: "mine", label: "mine", description: "ok", instructions: "y", tools: [], source: { card: "e", name: "C" } }
      ]
    }
    assert.deepStrictEqual(
      runSkills(registered, "workshop", []).map((s) => s.id),
      ["cards"]
    )
    const skills = runSkills(registered, "workshop", [card])
    assert.deepStrictEqual(
      skills.map((s) => [s.id, s.description]),
      [
        ["cards", "d"],
        ["extra", "d"],
        ["mine", "ok"]
      ]
    )
  })
})

// The wire: pi-ai's own serializers build the bodies; the transforms then run as they do in
// Providers.ts. No request leaves the process.
const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
}
const piTool = (t: AnyTool): Tool => ({
  name: t.id,
  description: t.description,
  parameters: t.parameters as Tool["parameters"]
})

type WireApi = "anthropic-messages" | "openai-responses" | "openai-completions"
const providerOf = (api: WireApi) =>
  api === "anthropic-messages" ? "anthropic" : api === "openai-responses" ? "openai" : "openrouter"

const serialize = (api: WireApi, modelId: string, messages: ReadonlyArray<Message>, tools: ReadonlyArray<Tool>) =>
  Effect.promise(async () => {
    const adapter = await import(`@earendil-works/pi-ai/api/${api}`)
    const model: Model<Api> = {
      id: modelId,
      name: "Synthetic",
      api,
      provider: providerOf(api),
      baseUrl: "http://127.0.0.1:1",
      input: ["text"],
      reasoning: false,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 1024
    }
    let body: Record<string, unknown> | undefined
    const stream = adapter.streamSimple(
      model,
      normalizeContext({
        systemPrompt: "You help with a character library.",
        messages: [...messages],
        tools: [...tools]
      }),
      {
        apiKey: "synthetic-key",
        cacheRetention: "short",
        onPayload: (payload: Record<string, unknown>) => {
          body = structuredClone(payload)
          throw new Error("Serialized; nothing is sent")
        },
        fetch: () => {
          throw new Error("A wire test must never send")
        }
      }
    )
    await stream.result()
    return body!
  })

const conversation = (api: WireApi, modelId: string) => {
  const provider = providerOf(api)
  const id = (n: string) => (api === "openai-responses" ? `call_${n}|fc_${n}` : `toolu_${n}`)
  const assistant = (name: string, args: unknown, n: string) =>
    ({
      role: "assistant",
      content: [{ type: "toolCall", id: id(n), name, arguments: args }],
      api,
      provider,
      model: modelId,
      usage,
      stopReason: "toolUse",
      timestamp: 0
    }) as Message
  const result = (name: string, n: string, text: string, loaded?: ReadonlyArray<string>) =>
    ({
      role: "toolResult",
      toolCallId: id(n),
      toolName: name,
      content: [{ type: "text", text }],
      details: loaded ? { loaded } : null,
      isError: false,
      timestamp: 0
    }) as Message
  const user = { role: "user", content: "Make the Assistant card warmer.", timestamp: 0 } as Message
  const before = [user, assistant("list_library", {}, "1"), result("list_library", "1", "Cards: Assistant.")]
  const after = [
    ...before,
    assistant("load_skill", { name: "cards" }, "2"),
    result("load_skill", "2", "Loaded 5 tools.", [
      "read_card",
      "create_card",
      "edit_card",
      "clone_card",
      "set_card_favourite"
    ]),
    assistant("read_card", { card: "Assistant" }, "3"),
    result("read_card", "3", "The Assistant is practical.")
  ]
  return { before, after, id }
}

describe("the wire", () => {
  it.effect("Anthropic: the tool list never changes and a load only appends", () =>
    Effect.gen(function* () {
      const { registry, tools } = yield* workshopTools
      const offer = split(registry, tools, "workshop", claude)
      const deferred = offer.tools.filter((t) => offer.deferred.has(t.id)).map(piTool)
      const immediate = offer.tools.filter((t) => !offer.deferred.has(t.id)).map(piTool)
      const all = [...immediate, ...deferred]
      const { before, after } = conversation("anthropic-messages", "claude-sonnet-4-5")
      const loading = (messages: ReadonlyArray<Message>) => ({
        api: "anthropic-messages",
        deferred,
        loads: loadPoints(messages, offer.deferred)
      })
      const first = applyAnthropicToolLoading(
        yield* serialize("anthropic-messages", "claude-sonnet-4-5", before, all),
        loading(before)
      )
      const second = applyAnthropicToolLoading(
        yield* serialize("anthropic-messages", "claude-sonnet-4-5", after, all),
        loading(after)
      )
      type T = { name: string; defer_loading?: boolean; cache_control?: unknown }
      const firstTools = first.tools as Array<T>
      assert.strictEqual(JSON.stringify(second.tools), JSON.stringify(first.tools))
      assert.strictEqual(JSON.stringify(second.system), JSON.stringify(first.system))
      assert.deepStrictEqual(
        firstTools.filter((t) => t.defer_loading).map((t) => t.name),
        deferred.map((t) => t.name)
      )
      // The marker can't sit on a deferred tool: it's on the last immediate one.
      assert.deepStrictEqual(
        firstTools.filter((t) => t.cache_control !== undefined).map((t) => t.name),
        ["load_skill"]
      )
      type Block = { type: string; cache_control?: unknown; content?: Array<{ type: string; tool_name?: string }> }
      type M = { role: string; content: Array<Block> }
      const strip = (m: M) =>
        typeof m.content === "string" ? m : { ...m, content: m.content.map(({ cache_control: _, ...b }) => b) }
      const a = first.messages as Array<M>
      const b = second.messages as Array<M>
      assert.deepStrictEqual(b.slice(0, a.length).map(strip), a.map(strip))
      // The result holds only the references (the API refuses them mixed with text); its text
      // follows the message's tool results.
      const [loadResult, loadText] = b[a.length + 1]!.content
      assert.deepStrictEqual(
        loadResult!.content!.map((c) => [c.type, c.tool_name]),
        ["read_card", "create_card", "edit_card", "clone_card", "set_card_favourite"].map((n) => ["tool_reference", n])
      )
      assert.deepStrictEqual(loadText as unknown, { type: "text", text: "Loaded 5 tools." })
    }).pipe(Effect.provide(ExecutionRegistry.layer))
  )

  it.effect("Responses: loaded definitions follow their load point, and later calls name their namespace", () =>
    Effect.gen(function* () {
      const { registry, tools } = yield* workshopTools
      const offer = split(registry, tools, "workshop", claude)
      const deferred = offer.tools.filter((t) => offer.deferred.has(t.id)).map(piTool)
      const immediate = offer.tools.filter((t) => !offer.deferred.has(t.id)).map(piTool)
      const { before, after } = conversation("openai-responses", "gpt-5.4")
      const loading = (messages: ReadonlyArray<Message>) => ({
        api: "openai-responses",
        deferred,
        loads: loadPoints(messages, offer.deferred)
      })
      const first = applyResponsesToolLoading(
        yield* serialize("openai-responses", "gpt-5.4", before, immediate),
        loading(before)
      )
      const second = applyResponsesToolLoading(
        yield* serialize("openai-responses", "gpt-5.4", after, immediate),
        loading(after)
      )
      assert.strictEqual(JSON.stringify(second.tools), JSON.stringify(first.tools))
      assert.deepStrictEqual(
        (first.tools as Array<{ name: string }>).map((t) => t.name),
        ["list_library", "tool_search", "load_skill"]
      )
      type Item = {
        type?: string
        name?: string
        call_id?: string
        namespace?: string
        tools?: Array<{ name: string; defer_loading?: boolean }>
      }
      const a = first.input as Array<Item>
      const b = second.input as Array<Item>
      assert.strictEqual(JSON.stringify(b.slice(0, a.length)), JSON.stringify(a))
      const types = b.slice(a.length).map((i) => i.type)
      assert.deepStrictEqual(types, [
        "function_call",
        "function_call_output",
        "tool_search_call",
        "tool_search_output",
        "function_call",
        "function_call_output"
      ])
      const output = b[a.length + 3]!
      assert.deepStrictEqual(
        output.tools!.map((t) => [t.name, t.defer_loading]),
        ["read_card", "create_card", "edit_card", "clone_card", "set_card_favourite"].map((n) => [n, true])
      )
      assert.strictEqual(b[a.length + 4]!.namespace, "read_card")
      assert.isUndefined(b[a.length]!.namespace, "a loader is a top-level tool")
    }).pipe(Effect.provide(ExecutionRegistry.layer))
  )

  // pi-ai marks the newest message for caching, so that marker moves on every request by design;
  // the transforms must leave everything else in the earlier messages as it was.
  const unmarked = (messages: ReadonlyArray<unknown>) =>
    JSON.stringify(messages, (key, value: unknown) => {
      if (key === "cache_control") return undefined
      if (Array.isArray(value) && value.length === 1) {
        const only = value[0] as { type?: string; text?: unknown; cache_control?: unknown }
        if (only?.type === "text" && only.cache_control !== undefined && typeof only.text === "string") return only.text
      }
      return value
    })

  const router = (modelId: string) =>
    Effect.gen(function* () {
      const { registry, tools } = yield* workshopTools
      const offer = split(registry, tools, "workshop", claude)
      const deferred = offer.tools.filter((t) => offer.deferred.has(t.id)).map(piTool)
      const all = [...offer.tools.filter((t) => !offer.deferred.has(t.id)).map(piTool), ...deferred]
      const { before, after } = conversation("openai-completions", modelId)
      const loading = (messages: ReadonlyArray<Message>) => ({
        api: "openai-completions",
        deferred,
        loads: loadPoints(messages, offer.deferred)
      })
      const first = applyRouterToolLoading(
        yield* serialize("openai-completions", modelId, before, all),
        loading(before)
      )
      const second = applyRouterToolLoading(yield* serialize("openai-completions", modelId, after, all), loading(after))
      type T = { function: { name: string; defer_loading?: boolean } }
      const flagged = (body: Record<string, unknown>) =>
        (body.tools as Array<T>).filter((t) => t.function.defer_loading).map((t) => t.function.name)
      type M = { role: string; tool_call_id?: string; content: unknown }
      return {
        deferred,
        first,
        second,
        flagged,
        messages: (body: Record<string, unknown>) => body.messages as Array<M>
      }
    })

  it.effect("OpenRouter Claude: the flags never change and the load's result carries the definitions", () =>
    Effect.gen(function* () {
      const { deferred, first, second, flagged, messages } = yield* router("anthropic/claude-sonnet-4.5")
      assert.strictEqual(JSON.stringify(second.tools), JSON.stringify(first.tools))
      assert.deepStrictEqual(
        flagged(first),
        deferred.map((t) => t.name)
      )
      // Anthropic refuses a marker on a deferred tool: pi-ai's moves to the last immediate one.
      type Marked = { cache_control?: unknown; function: { name: string } }
      assert.deepStrictEqual(
        (first.tools as Array<Marked>).filter((t) => t.cache_control !== undefined).map((t) => t.function.name),
        [(first.tools as Array<Marked>).findLast((t) => !flagged(first).includes(t.function.name))!.function.name]
      )
      const a = messages(first)
      const b = messages(second)
      assert.strictEqual(unmarked(b.slice(0, a.length)), unmarked(a))
      const load = b.find((m) => m.role === "tool" && m.tool_call_id === "toolu_2")!
      const text = load.content as string
      assert.isTrue(text.startsWith("Loaded 5 tools."))
      assert.include(text, LOADED_DEFINITIONS)
      const definitions = text
        .slice(text.indexOf(LOADED_DEFINITIONS) + LOADED_DEFINITIONS.length)
        .trim()
        .split("\n")
        .map((line) => (JSON.parse(line) as { name: string }).name)
      assert.deepStrictEqual(definitions, ["read_card", "create_card", "edit_card", "clone_card", "set_card_favourite"])
    }).pipe(Effect.provide(ExecutionRegistry.layer))
  )

  it.effect("RP and unprofiled agents keep the original serialized requests", () =>
    Effect.gen(function* () {
      const { registry, tools } = yield* workshopTools
      for (const kind of ["rp", "synthetic-plugin-kind"]) {
        const offer = split(registry, tools, kind, claude)
        assert.strictEqual(offer.tools, tools)
        assert.strictEqual(offer.deferred.size, 0)
        for (const api of ["anthropic-messages", "openai-responses"] as const) {
          const messages = conversation(api, api === "anthropic-messages" ? claude.key : "gpt-5.4").before
          const baseline = yield* serialize(api, "synthetic-model", messages, tools.map(piTool))
          const current = yield* serialize(api, "synthetic-model", messages, offer.tools.map(piTool))
          assert.strictEqual(JSON.stringify(current), JSON.stringify(baseline))
        }
      }
    }).pipe(Effect.provide(ExecutionRegistry.layer))
  )

  it("changes nothing without a load plan", () => {
    const payload = { tools: [{ name: "a", cache_control: { type: "ephemeral" } }], messages: [] }
    const copy = structuredClone(payload)
    assert.deepStrictEqual(
      applyAnthropicToolLoading(payload, { api: "anthropic-messages", deferred: [], loads: [] }),
      copy
    )
  })
})

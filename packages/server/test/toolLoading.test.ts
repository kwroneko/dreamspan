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
import { applyAnthropicToolLoading, applyResponsesToolLoading } from "../src/providers/toolLoading.ts"
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
      const skills = skillsFor(runSkills(registry.skills.list(), kind, [assistantCard(registry)]), names)
      return [
        { ...registry.toolLoaders.get("tool_search")!, description: toolSearchDescription(orphansOf(names, skills)) },
        { ...registry.toolLoaders.get("load_skill")!, description: loadSkillDescription(skills) }
      ]
    }
  })

const claude = { kind: "anthropic", api: "anthropic-messages", key: "claude-sonnet-4-5" }

/** The seeded Assistant card's skills, as `CreateWorkshop` writes them from the registered defaults. */
const assistantCard = (registry: ExecutionRegistry["Service"]) =>
  cardSkills(
    { extensions: { rp_harness: { skills: registry.workshopCardSkills.list().map((s) => ({ use: s.id })) } } },
    { entity: "assistant", name: "Assistant" }
  )

describe("built-in skills come with the Assistant card", () => {
  it.effect("its skills cover every deferred workshop tool", () =>
    Effect.gen(function* () {
      const { registry, tools } = yield* workshopTools
      const offer = split(registry, tools, "workshop", claude)
      const skills = skillsFor(runSkills(registry.skills.list(), "workshop", [assistantCard(registry)]), [
        ...offer.deferred
      ])
      assert.strictEqual(skills.length, registry.skills.list().length)
      assert.deepStrictEqual(orphansOf([...offer.deferred], skills), [])
    }).pipe(Effect.provide(ExecutionRegistry.layer))
  )

  it.effect("a card without skills lists every deferred tool for tool_search", () =>
    Effect.gen(function* () {
      const { registry, tools } = yield* workshopTools
      const offer = split(registry, tools, "workshop", claude)
      const plain = cardSkills({}, { entity: "mine", name: "My card" })
      const skills = skillsFor(runSkills(registry.skills.list(), "workshop", [plain]), [...offer.deferred])
      assert.deepStrictEqual(skills, [])
      assert.deepStrictEqual(orphansOf([...offer.deferred], skills), [...offer.deferred])
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
        { kind: "openai-responses", api: "openai-responses", key: "gpt-5.2" }
      ]) {
        const offer = split(registry, tools, "workshop", target)
        assert.strictEqual(offer.deferred.size, 0, target.key)
        assert.strictEqual(offer.tools, tools, target.key)
      }
      assert.strictEqual(split(registry, tools, "rp", claude).deferred.size, 0)
      assert.isAbove(
        split(registry, tools, "workshop", { kind: "openai-responses", api: "openai-responses", key: "gpt-5.4" })
          .deferred.size,
        0
      )
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
    ]
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

const serialize = (
  api: "anthropic-messages" | "openai-responses",
  modelId: string,
  messages: ReadonlyArray<Message>,
  tools: ReadonlyArray<Tool>
) =>
  Effect.promise(async () => {
    const adapter = await import(`@earendil-works/pi-ai/api/${api}`)
    const model: Model<Api> = {
      id: modelId,
      name: "Synthetic",
      api,
      provider: api === "anthropic-messages" ? "anthropic" : "openai",
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

const conversation = (api: "anthropic-messages" | "openai-responses", modelId: string) => {
  const provider = api === "anthropic-messages" ? "anthropic" : "openai"
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
      const target = { kind: "openai-responses", api: "openai-responses", key: "gpt-5.4" }
      const offer = split(registry, tools, "workshop", target)
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

  it("changes nothing without a load plan", () => {
    const payload = { tools: [{ name: "a", cache_control: { type: "ephemeral" } }], messages: [] }
    const copy = structuredClone(payload)
    assert.deepStrictEqual(
      applyAnthropicToolLoading(payload, { api: "anthropic-messages", deferred: [], loads: [] }),
      copy
    )
  })
})

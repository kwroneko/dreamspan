// MCP deferred loading (spec/MCP.md M4, §4.4): a server's "Send its tools" decides over the chat
// kind's profile whether its tools are sent from the start. Automatically leaves them for loading
// above 5 allowed tools; only a wire that carries deferred tools defers anything. A server's skill
// loads its tools (and, in a story, read_result) and brings the server's own instructions only
// while "Use the server's instructions" is on. Synthetic connections; nothing is sent anywhere.
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import type { McpConnection, McpLoading } from "@rp/shared/mcp.ts"
import { planToolLoading } from "../src/agent/loadingPlan.ts"
import {
  mcpLoadingOf,
  mcpLoadingOverrides,
  mcpOfferTools,
  mcpSkillOf,
  READ_RESULT,
  readResultTool
} from "../src/agent/tools/mcp.ts"
import { LOAD_SKILL, TOOL_SEARCH } from "../src/agent/toolLoading.ts"
import type { RolloutTool } from "../src/agent/tools.ts"
import type { Reader } from "../src/db/Database.ts"
import { ExecutionRegistry, toolForKind } from "../src/execution.ts"

const connection = (key: string, tools: number, loading: McpLoading, instructions: string | null = null) =>
  ({
    id: `conn-${key}`,
    name: `Server ${key}`,
    key,
    about: `What ${key} is for.`,
    url: "http://127.0.0.1:1/mcp",
    loading,
    useInstructions: true,
    server: instructions === null ? null : { instructions },
    catalogRevision: 1,
    use: { stories: true, workshops: true, tools: {}, reviewedRevision: 1, offeredKey: key },
    tools: Array.from({ length: tools }, (_, i) => ({
      name: `t${i}`,
      exposed: `mcp_${key}_t${i}`,
      title: null,
      description: `Tool ${i}.`,
      inputSchema: { type: "object", properties: {} },
      outputSchema: null,
      annotations: null,
      firstRevision: 1,
      problem: null
    }))
  }) as unknown as McpConnection

const model = (toolLoading: "auto" | "every" | "dispatcher") =>
  ({ kind: "anthropic", api: "anthropic-messages", key: "claude-sonnet-4-5", toolLoading }) as never

const plan = (
  kind: "rp" | "workshop",
  connections: ReadonlyArray<McpConnection>,
  toolLoading: "auto" | "every" | "dispatcher" = "auto",
  builtins: ReadonlyArray<string> = []
) =>
  Effect.gen(function* () {
    const execution = yield* ExecutionRegistry
    const entries = connections.map((c) => ({ connection: c, grant: "allow" as const }))
    const story = kind === "rp"
    const tools = [
      ...builtins.map((id) => toolForKind(execution, kind, id)!),
      ...mcpOfferTools({} as never, entries),
      ...(story ? [readResultTool as unknown as RolloutTool<never>] : [])
    ]
    return yield* planToolLoading(
      { execution, reader: {} as unknown as Reader["Service"], userId: "synthetic" as never },
      {
        kind,
        tools,
        model: model(toolLoading),
        cards: [],
        skills: connections.map((c) => mcpSkillOf(c, story)),
        loading: mcpLoadingOverrides(entries, story)
      }
    )
  }).pipe(Effect.provide(ExecutionRegistry.layer))

const deferred = (result: Effect.Success<ReturnType<typeof plan>>) => [...result.offer.deferred].sort()
const sent = (result: Effect.Success<ReturnType<typeof plan>>) => result.offer.tools.map((t) => t.id)

describe("MCP deferred loading", () => {
  it("Automatically defers above 5 allowed tools; the other choices are fixed", () => {
    assert.strictEqual(mcpLoadingOf(connection("a", 5, "auto")), "immediate")
    assert.strictEqual(mcpLoadingOf(connection("a", 6, "auto")), "deferred")
    assert.strictEqual(mcpLoadingOf(connection("a", 9, "immediate")), "immediate")
    assert.strictEqual(mcpLoadingOf(connection("a", 1, "deferred")), "deferred")
  })

  it.effect("a story sends a small server's tools from the start and leaves a large one's for loading", () =>
    Effect.gen(function* () {
      const result = yield* plan("rp", [connection("small", 2, "auto"), connection("big", 6, "auto")])
      assert.deepStrictEqual(
        deferred(result),
        Array.from({ length: 6 }, (_, i) => `mcp_big_t${i}`)
      )
      const ids = sent(result)
      for (const id of ["mcp_small_t0", "mcp_small_t1", READ_RESULT, LOAD_SKILL]) assert.include(ids, id)
      // Only the deferred server's skill is listed; loading it loads its tools and read_result.
      assert.deepStrictEqual(
        result.cardSkills.map((s) => s.id),
        ["mcp-big"]
      )
      assert.include(result.cardSkills[0]!.tools, READ_RESULT)
    })
  )

  it.effect("read_result waits for loading when every server's tools do", () =>
    Effect.gen(function* () {
      const result = yield* plan("rp", [connection("big", 6, "auto")])
      assert.include(deferred(result), READ_RESULT)
      assert.notInclude(
        sent(result).filter((id) => !result.offer.deferred.has(id)),
        READ_RESULT
      )
    })
  )

  it.effect("a story with only small servers keeps its exact offer, with no loaders", () =>
    Effect.gen(function* () {
      const result = yield* plan("rp", [connection("small", 3, "auto")])
      assert.strictEqual(result.offer.deferred.size, 0)
      assert.notInclude(sent(result), LOAD_SKILL)
      assert.notInclude(sent(result), TOOL_SEARCH)
    })
  )

  it.effect("a wire that can't carry deferred tools gets every tool from the start", () =>
    Effect.gen(function* () {
      const result = yield* plan("rp", [connection("big", 8, "deferred")], "every")
      assert.strictEqual(result.offer.deferred.size, 0)
      for (let i = 0; i < 8; i++) assert.include(sent(result), `mcp_big_t${i}`)
    })
  )

  it.effect("From the start keeps a large server's tools immediate even in a workshop", () =>
    Effect.gen(function* () {
      const result = yield* plan("workshop", [connection("big", 7, "immediate")], "auto", ["list_library", "read_card"])
      for (let i = 0; i < 7; i++) assert.isFalse(result.offer.deferred.has(`mcp_big_t${i}`))
      // The workshop profile still defers its own tools.
      assert.isTrue(result.offer.deferred.has("read_card"))
      assert.isFalse(result.offer.deferred.has("list_library"))
    })
  )

  it.effect("When the model asks defers even a one-tool server, through the dispatcher too", () =>
    Effect.gen(function* () {
      const result = yield* plan("rp", [connection("one", 1, "deferred")], "dispatcher")
      assert.include(deferred(result), "mcp_one_t0")
    })
  )

  it("a loaded skill brings the server's own instructions only while the user keeps them on", () => {
    const on = connection("a", 1, "deferred", "Call t0 before anything else.")
    assert.include(mcpSkillOf(on).instructions, "Call t0 before anything else.")
    assert.notInclude(mcpSkillOf({ ...on, useInstructions: false } as McpConnection).instructions, "Call t0")
    // The index line is the user's own words, never the server's.
    assert.strictEqual(mcpSkillOf(on).description, "What a is for.")
    assert.notInclude(mcpSkillOf(on).tools, READ_RESULT)
    assert.include(mcpSkillOf(on, true).tools, READ_RESULT)
  })
})

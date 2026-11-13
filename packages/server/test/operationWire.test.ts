// Measure actual provider serializers without contacting a provider.
import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { writeFileSync } from "node:fs"
import { normalizeContext, type Api, type Model, type Tool } from "@earendil-works/pi-ai"
import { foldState } from "@rp/shared/state.ts"
import { ExecutionRegistry, toolForKind } from "../src/execution.ts"
import { severalMessageDefinition } from "../src/agent/tools.ts"
import { prepareTokenizer } from "../src/importer/tokenizer.ts"

// A recommendation for the report, deliberately not wired into production defaults.
const PROPOSED_WORKSHOP_CONTEXT_TOKENS = 32_768

it.live("serializes all offered workshop definitions in every provider format with valid schema references", () =>
  Effect.gen(function* () {
    const registry = yield* ExecutionRegistry
    const plan = registry.orchestrationModes.get("workshop")!.plan({ state: foldState([]), kind: "workshop" })
    const tools = [
      ...plan.tools.map((name) => {
        const tool = toolForKind(registry, "workshop", name)!
        return { name, description: tool.description, parameters: tool.parameters }
      }),
      severalMessageDefinition
    ] as Tool[]
    const rows = yield* Effect.promise(async () => {
      const count = await prepareTokenizer("o200k_base")
      const rows = []
      for (const api of [
        "openai-completions",
        "openai-responses",
        "anthropic-messages",
        "google-generative-ai"
      ] as const) {
        const adapter = await import(`@earendil-works/pi-ai/api/${api}`)
        const model: Model<Api> = {
          id:
            api === "google-generative-ai"
              ? "gemini-2.5-pro"
              : api === "anthropic-messages"
                ? "claude-sonnet-4-5"
                : "gpt-4.1",
          name: "Synthetic measurement",
          api,
          provider: api === "anthropic-messages" ? "anthropic" : api === "google-generative-ai" ? "google" : "openai",
          baseUrl: "http://127.0.0.1:1",
          input: ["text"],
          reasoning: false,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 32768,
          maxTokens: 1024
        }
        let definitions: unknown
        const stream = adapter.streamSimple(
          model,
          normalizeContext({ messages: [{ role: "user", content: "Measure", timestamp: 0 }], tools }),
          {
            apiKey: "synthetic-key",
            onPayload: (payload: { tools?: unknown; config?: { tools?: unknown } }) => {
              definitions = payload.tools ?? payload.config?.tools
              throw new Error("Measurement complete; no network request")
            },
            ...(api === "google-generative-ai"
              ? {}
              : {
                  fetch: () => {
                    throw new Error("A measurement must never send")
                  }
                })
          }
        )
        await stream.result()
        assert.isDefined(definitions, api)
        const serialized = JSON.stringify(definitions)
        rows.push({ api, tools: tools.length, bytes: Buffer.byteLength(serialized), o200kTokens: count(serialized) })
        const references = (value: unknown, root: unknown): void => {
          if (!value || typeof value !== "object") return
          const record = value as Record<string, unknown>
          if (typeof record.$ref === "string" && record.$ref.startsWith("#/")) {
            const target = record.$ref
              .slice(2)
              .split("/")
              .reduce<unknown>(
                (node, key) =>
                  (node as Record<string, unknown> | undefined)?.[key.replaceAll("~1", "/").replaceAll("~0", "~")],
                root
              )
            assert.isDefined(target, `${api}: ${record.$ref}`)
          }
          for (const child of Object.values(record)) references(child, root)
        }
        for (const definition of definitions as Array<Record<string, unknown>>) {
          const fn = (definition.function ?? definition) as Record<string, unknown>
          const schemas = definition.functionDeclarations
            ? (definition.functionDeclarations as Array<Record<string, unknown>>).map(
                (d) => d.parametersJsonSchema ?? d.parameters
              )
            : [fn.parameters ?? fn.input_schema]
          for (const schema of schemas) references(schema, schema)
        }
      }
      return rows
    })
    if (process.env.WORKSHOP_TOOL_MEASUREMENT_OUTPUT)
      writeFileSync(
        process.env.WORKSHOP_TOOL_MEASUREMENT_OUTPUT,
        JSON.stringify({ proposedContextTokens: PROPOSED_WORKSHOP_CONTEXT_TOKENS, rows }, null, 2)
      )
    assert.isTrue(rows.every((row) => row.o200kTokens + 1024 < PROPOSED_WORKSHOP_CONTEXT_TOKENS))
  }).pipe(Effect.provide(ExecutionRegistry.layer))
)

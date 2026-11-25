// Cross-branch contracts: real replacement handles, frozen offers and scoped assemblers.
import { expect, it } from "vitest"
import { Effect } from "effect"
import type { ModelInput } from "../src/assembler/types.ts"
import { makeAssembler } from "../src/assembler/assembler.ts"
import { adaptMacroV1 } from "../src/plugins/macroAdapter.ts"
import { declaredHandles } from "../src/plugins/handles.ts"
import { ExecutionRegistry } from "../src/execution.ts"
import { loadingWireFor, planToolLoading } from "../src/agent/loadingPlan.ts"
import { frozenTool, type ToolContext } from "../src/agent/tools.ts"
import { readMessages } from "../src/agent/tools/historyPart.ts"
import { listNotes, switchNote } from "../src/agent/tools/notesPart.ts"
import { stepsOf } from "../src/agent/steps.ts"
import { assembleFixture, type AssemblyFixture } from "./support/assemblySources.ts"
import { importStPreset } from "../src/formats/preset.ts"
import { cardDoc, presetDoc } from "./support/docs.ts"
import { takeSummaryPrefix } from "../src/lcm/prefix.ts"
import { cutOwnTurnText, ownTurnSelectionError } from "@dreamspan/shared/docs/note.ts"
import { WORKSHOP_SUMMARY_INSTRUCTION } from "@dreamspan/shared/workshopLcm.ts"

for (const [mode, target, expectedWire] of [
  ["every", { kind: "openai-chat", api: "openai-completions", key: "gpt-5.4-mini", toolLoading: "every" }, undefined],
  ["native", { kind: "anthropic", api: "anthropic-messages", key: "claude-sonnet-4-5" }, "anthropic-messages"],
  [
    "router",
    {
      kind: "openrouter",
      api: "openai-completions",
      key: "anthropic/claude-sonnet-4.5",
      settings: { routing: { order: ["anthropic"], allow_fallbacks: false } }
    },
    "openai-completions"
  ],
  [
    "dispatcher",
    { kind: "openai-chat", api: "openai-completions", key: "synthetic", toolLoading: "dispatcher" },
    "dispatcher"
  ],
  [
    "direct Responses default",
    { kind: "openai-responses", api: "openai-responses", key: "gpt-5.4-mini", provider: "openai" },
    "openai-responses"
  ],
  [
    "direct Chat mini default",
    { kind: "openai-chat", api: "openai-completions", key: "gpt-5.4-mini", provider: "openai" },
    "dispatcher"
  ],
  [
    "direct Chat nano default",
    { kind: "openai-chat", api: "openai-completions", key: "gpt-5.4-nano", provider: "openai" },
    "dispatcher"
  ]
] as const)
  it(`copied history/notes definitions, loads, calls and Steps agree under ${mode}`, () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const execution = yield* ExecutionRegistry
          const originals = [readMessages, listNotes, switchNote].map((p) => execution.rolloutTools.get(p.id)!)
          const handles = declaredHandles(
            {
              id: "seam-copies",
              name: "Seam copies",
              api: 1,
              server: "server.ts",
              worker: null,
              client: null,
              surfaces: ["server:rolloutTools", "server:history", "server:notes"],
              replaces: originals.map((t) => `rolloutTools:${t.id}`),
              overrides: [],
              network: false,
              base: null
            },
            "server",
            { rolloutTools: execution.rolloutTools },
            yield* Effect.scope,
            new Map(),
            () => {
              throw new Error("copy fault")
            }
          ) as { rolloutTools: { register: (part: unknown) => Effect.Effect<void, unknown> } }
          for (const part of [readMessages, listNotes, switchNote]) yield* handles.rolloutTools.register(part)
          for (const original of originals) {
            const copy = frozenTool(execution.rolloutTools.get(original.id)!)
            const builtin = frozenTool(original)
            expect(
              JSON.stringify({ name: copy.name, description: copy.description, parameters: copy.parameters })
            ).toBe(
              JSON.stringify({ name: builtin.name, description: builtin.description, parameters: builtin.parameters })
            )
            expect(copy.label).toContain("Seam copies (plugin)")
          }
          // A changed definition and handler must both come from the replacement. The
          // domain policy itself is exercised against real history/notes in pluginCopies.
          for (const part of [readMessages, listNotes, switchNote])
            yield* handles.rolloutTools.register({
              ...part,
              description: `Copied definition ${part.id}`,
              execute: () => Effect.succeed({ text: `Copied result ${part.id}` })
            })
          const model = target as unknown as ModelInput
          expect(loadingWireFor(execution, model)?.id).toBe(expectedWire)
          const tools = [
            execution.rolloutTools.get("list_library")!,
            ...originals.map((t) => execution.rolloutTools.get(t.id)!)
          ]
          const { offer } = yield* planToolLoading(
            { execution, reader: {} as never, userId: "synthetic" as never },
            { kind: "workshop", tools, model, cards: [] }
          )
          const frozen = offer.tools.map((t) => ({
            ...frozenTool(t),
            ...(offer.deferred.has(t.id) ? { deferred: true as const } : {})
          }))
          const loaded = new Set<string>()
          for (const original of originals) {
            const definition = frozen.find((t) => t.name === original.id)!
            expect(definition.description).toBe(`Copied definition ${original.id}`)
            if (expectedWire) {
              expect(definition.deferred).toBe(true)
              const result = yield* execution.toolLoaders
                .get("tool_search")!
                .execute(
                  { offer: { tools: frozen, loaded } } as unknown as ToolContext,
                  { query: `select:${original.id}` } as never
                )
              expect(result.loaded).toEqual([original.id])
              expect(result.text).toContain(`Copied definition ${original.id}`)
              loaded.add(original.id)
            } else expect(definition.deferred).toBeUndefined()
            const result = yield* execution.rolloutTools.get(original.id)!.execute({} as ToolContext, {} as never)
            expect(result.text).toBe(`Copied result ${original.id}`)
            const [step] = stepsOf(
              [
                {
                  role: "assistant",
                  content: [{ type: "toolCall", id: original.id, name: original.id, arguments: {} }],
                  stopReason: "toolUse",
                  timestamp: 1
                },
                {
                  role: "toolResult",
                  toolCallId: original.id,
                  toolName: original.id,
                  content: [{ type: "text", text: result.text }],
                  isError: false,
                  timestamp: 2
                }
              ] as Parameters<typeof stepsOf>[0],
              frozen,
              true
            )
            expect(step).toMatchObject({
              kind: "tool",
              tool: original.id,
              label: definition.label,
              result: result.text
            })
          }
        }).pipe(Effect.provide(ExecutionRegistry.layer))
      )
    ))

it("copied macro output follows summary audiences, corrected thread views and own-turn notes", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const assembler = yield* makeAssembler
        let calls = 0
        for (const name of ["reverse", "lastmessage", "char", "description"]) {
          const entry = assembler.macros.get(name)!
          yield* assembler.macros.register(
            adaptMacroV1(
              {
                ...entry,
                handler: (call) => {
                  calls++
                  return entry.handler(call)
                }
              },
              () => true,
              () => {
                throw new Error("copy fault")
              }
            )
          )
        }
        const f: AssemblyFixture = {
          cards: ["Mira", "Wren"].map((name) => ({
            entity: name,
            doc: cardDoc(name, { description: "Public {{char}}." })
          })),
          participants: ["Mira", "Wren"],
          target: { speaker: "Mira" },
          events: [{ depth: null, event: { scope: null, data: { key: "context.per_speaker", value: "separate" } } }],
          messages: [
            { side: "user", content: "COMMON", knowers: ["Mira", "Wren"] },
            { side: "assistant", speaker: "Mira", content: "THREAD-SECRET", knowers: ["Mira"] }
          ],
          preset: importStPreset(
            JSON.stringify({
              frequency_penalty: 0,
              main_prompt: "{{reverse::cba}} {{description}} Last: {{lastMessage}}",
              group_nudge_prompt: ""
            })
          ).document!,
          notes: [
            {
              entity: "own",
              revision: "own-r",
              doc: {
                schema_version: 1,
                title: "Private",
                owner: { card: "Mira" as never },
                condition: { when: "own_turn" },
                content: "{{reverse::TERCES-NWO}}",
                placement: { mode: "section", section: "context_start", role: "system" },
                on_by_default: true,
                exportable: true
              }
            }
          ]
        }
        const reply = yield* assembleFixture(f, { assembler })
        expect(JSON.stringify(reply.request)).toContain("THREAD-SECRET")
        expect(JSON.stringify(reply.request)).toContain("OWN-SECRET")
        const corrected = yield* assembleFixture(
          { ...f, messages: f.messages.map((m) => ({ ...m, knowers: ["Mira", "Wren"] })) },
          { assembler }
        )
        for (const prefix of [takeSummaryPrefix(reply), takeSummaryPrefix(corrected)]) {
          const options = {
            summarizing: true,
            summaryJob: {
              id: "summary",
              clipTokens: 1000,
              inputs: [],
              tail: "Summarize.",
              style: "direct",
              audience: ["Wren"],
              prefix
            }
          } as const
          const input = { ...f, target: { speaker: "Wren" } }
          const copied = yield* assembleFixture(input, { ...options, assembler })
          const builtin = yield* assembleFixture(input, options)
          expect(copied.request).toEqual(builtin.request)
          const text = JSON.stringify(copied.request)
          expect(text).toContain("abc")
          expect(text).not.toContain("THREAD-SECRET")
          expect(text).not.toContain("OWN-SECRET")
        }
        // Workshop summary instructions retain master's range/unfinished-request wording
        // while preset macros use exactly the same adapter as story summaries.
        const workshop = {
          ...f,
          notes: [],
          messages: [
            { side: "user" as const, content: "Workshop read {{reverse::cba}}", macroMode: "template" as const }
          ]
        }
        const options = {
          summarizing: true,
          summaryJob: {
            id: "workshop",
            clipTokens: 1000,
            inputs: [],
            tail: WORKSHOP_SUMMARY_INSTRUCTION.replace("{{words}}", "200"),
            style: "direct"
          }
        } as const
        const copied = yield* assembleFixture(workshop, { ...options, assembler })
        expect(copied.request).toEqual((yield* assembleFixture(workshop, options)).request)
        expect(JSON.stringify(copied.request)).toContain("no result in this excerpt")
        expect(JSON.stringify(copied.request)).toContain("Workshop read abc")
        expect(calls).toBeGreaterThan(0)
      })
    )
  ))

it("a cut beside a copied macro preserves surrounding whitespace and parser boundaries", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const assembler = yield* makeAssembler
        const entry = assembler.macros.get("reverse")!
        let calls = 0
        yield* assembler.macros.register(
          adaptMacroV1(
            {
              ...entry,
              handler: (call) => {
                calls++
                return entry.handler(call)
              }
            },
            () => true,
            () => {
              throw new Error("copy fault")
            }
          )
        )
        const text = "  Untouched  prose.\n\n{{reverse::cba}} Secret.\n\nLast.  "
        const at = text.indexOf("Secret.")
        expect(ownTurnSelectionError(text, at, 7)).toBeNull()
        expect(ownTurnSelectionError(text, text.indexOf("cba"), 2)).not.toBeNull()
        const remaining = cutOwnTurnText(text, at, 7)
        expect(remaining).toBe("  Untouched  prose.\n\n{{reverse::cba}}\n\nLast.  ")
        const f = {
          cards: [{ entity: "Mira", doc: cardDoc("Mira", { description: remaining }) }],
          participants: ["Mira"],
          messages: [],
          preset: presetDoc([{ identifier: "main", content: "{{description}}" }])
        }
        const copied = yield* assembleFixture(f, { assembler })
        expect(copied.request).toEqual((yield* assembleFixture(f)).request)
        expect(JSON.stringify(copied.request)).toContain("abc")
        expect(JSON.stringify(copied.request)).not.toContain("Secret.")
        expect(calls).toBeGreaterThan(0)
      })
    )
  ))

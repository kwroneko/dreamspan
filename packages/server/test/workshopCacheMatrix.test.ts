import { expect, it } from "vitest"
import { newChatNote } from "@dreamspan/shared/editing.ts"
import type { ChatId, SlotId } from "@dreamspan/shared/chat.ts"
import { Effect, Layer } from "effect"
import { normalizeContext, type AssistantMessage, type Model, type ToolResultMessage } from "@earendil-works/pi-ai"
import type { ModelInput } from "../src/assembler/types.ts"
import { cachePrefixDigests } from "../src/assembler/breakpoints.ts"
import { providerRequest, sentWire, wireContext } from "../src/assembler/wire.ts"
import { rolloutRequest } from "../src/agent/wire.ts"
import { workshopHistory } from "../src/agent/workshopHistory.ts"
import { layer as builtins } from "../src/providers/builtins.ts"
import { empty, ProviderRegistry } from "../src/providers/registry.ts"
import { applyShims } from "../src/providers/shims.ts"
import { assembleFixture, historyAfterDispatch, type FixtureMessage } from "./support/assemblySources.ts"
import { cardDoc, presetDoc } from "./support/docs.ts"
import { studyFixture, studyModel } from "./support/cacheStudy.ts"

const cases = [
  ["anthropic", "anthropic-messages", "claude-sonnet-4-5", "auto", true],
  ["anthropic-vertex", "anthropic-messages", "claude-sonnet-4-5", "auto", true],
  ["anthropic-bedrock", "anthropic-messages", "claude-sonnet-4-5", "explicit", false],
  ["openai-responses-bedrock", "openai-responses", "us.openai.gpt-5.6", "explicit", false],
  ["openai-responses-bedrock", "openai-responses", "us.openai.gpt-5.5", "explicit", false],
  ["openai-chat-bedrock", "openai-completions", "openai.gpt-oss-120b", "explicit", false],
  ["openai-responses", "openai-responses", "gpt-5.5", "auto", true],
  ["openai-chat", "openai-completions", "gpt-5.5", "auto", true],
  ["openrouter", "openai-completions", "anthropic/claude-sonnet-4.5", "auto", true],
  ["openrouter", "openai-completions", "anthropic/claude-sonnet-4.5", "explicit", false],
  ["openrouter", "openai-completions", "google/gemini-3-pro", "auto", true],
  ["openrouter", "openai-completions", "qwen/qwen-plus", "auto", true],
  ["deepseek", "openai-completions", "deepseek-reasoner", "auto", true],
  ["google", "google-generative-ai", "gemini-2.5-pro", "auto", true]
] as const

type Wire = Record<string, unknown>

const withoutMarkers = (value: unknown) =>
  JSON.parse(
    JSON.stringify(value, (key, item) =>
      key === "cache_control" || key === "prompt_cache_breakpoint" ? undefined : item
    )
  ) as unknown

const rowsOf = (payload: Wire) => (payload.messages ?? payload.input ?? payload.contents) as Array<Wire>
const through = (payload: Wire, text: string) => {
  const rows = rowsOf(payload)
  const index = rows.findIndex((row) => JSON.stringify(row).includes(text))
  expect(index, text).toBeGreaterThanOrEqual(0)
  return withoutMarkers(rows.slice(0, index + 1))
}
const marked = (payload: Wire, field: string) =>
  rowsOf(payload).flatMap((row, index) => (JSON.stringify(row).includes(field) ? [index] : []))

const countField = (value: unknown, field: string) => JSON.stringify(value).split(`"${field}":`).length - 1
const tailOf = (n: number) => `WORKSHOP_END_${n}`
const read = (n: number) => `TOOL_RESULT_${n}`
const user = (n: number): FixtureMessage => ({ side: "user", content: `USER_MESSAGE_${n}` })

for (const [kind, api, key, cacheBreakpoints, lookback] of cases) {
  it(`${kind} ${key} ${cacheBreakpoints} retains workshop history and places cache checkpoints`, async () => {
    const env = builtins.pipe(Layer.provideMerge(empty))
    await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* ProviderRegistry
        const entry = registry.kinds.get(kind)!
        const provider = entry.piProvider
        const bedrockOpenAI = kind.startsWith("openai") && kind.endsWith("bedrock")
        const responsesBedrock = kind === "openai-responses-bedrock"
        const newerResponses = responsesBedrock && key.endsWith("5.6")
        const claudeRouter = kind === "openrouter" && key.startsWith("anthropic/")
        const router = kind === "openrouter"
        const anthropic = api === "anthropic-messages"
        const cacheLayout = {
          lookback,
          maxMarkers: 4,
          ...(bedrockOpenAI ? { marker: "prompt_cache_breakpoint" as const } : {})
        }
        const model: ModelInput = {
          ...studyModel,
          api,
          kind,
          key,
          cacheBreakpoints,
          cacheLayout
        }
        const sdk: Model<typeof api> = {
          id: key,
          name: "Synthetic",
          api,
          provider,
          baseUrl: "https://example.invalid",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 32768,
          maxTokens: 500
        }
        const tool = {
          name: "read_fixture",
          description: "Read a synthetic fixture.",
          parameters: { type: "object", properties: {} }
        }
        const assistant = (
          content: AssistantMessage["content"],
          stopReason: AssistantMessage["stopReason"]
        ): AssistantMessage => ({
          role: "assistant",
          api,
          model: key,
          provider,
          content,
          stopReason,
          timestamp: 0,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
          }
        })
        const pair = (n: number): [AssistantMessage, ToolResultMessage] => {
          const id = `call_${n}`
          return [
            assistant(
              [
                ...(kind === "deepseek"
                  ? [
                      {
                        type: "thinking" as const,
                        thinking: "Read the fixture first.",
                        thinkingSignature: "reasoning_content"
                      }
                    ]
                  : []),
                { type: "text", text: `PROGRESS_${n}` },
                { type: "toolCall", id, name: tool.name, arguments: { n } }
              ],
              "toolUse"
            ),
            {
              role: "toolResult",
              toolName: tool.name,
              toolCallId: id,
              content: [{ type: "text", text: read(n) }],
              isError: false,
              timestamp: 0
            }
          ]
        }
        const trace1 = [...pair(1), ...pair(2), assistant([{ type: "text", text: "FINAL_1" }], "stop")]
        const trace2 = [...pair(3), assistant([{ type: "text", text: "FINAL_2" }], "stop")]
        const preset = presetDoc([
          { identifier: "main", content: "Permanent workshop instructions. ".repeat(260) },
          { identifier: "chatHistory", content: "" },
          { identifier: "depthZero", content: "" },
          { identifier: "directionPrompt", content: "GUIDANCE {{direction}}" }
        ])
        const withSummary = kind === "anthropic-vertex" || kind === "anthropic-bedrock" || newerResponses
        const summary = {
          ...studyFixture().summaries![0]!,
          firstSlotId: "slot-0" as SlotId,
          lastSlotId: "slot-1" as SlotId,
          from: 1,
          to: 2,
          slotCount: 2,
          content: "ACTIVE_LCM_SUMMARY"
        }
        const build = (
          n: number,
          messages: Array<FixtureMessage>,
          start?: ReturnType<typeof historyAfterDispatch>,
          m = model,
          workshop = true
        ) =>
          assembleFixture(
            {
              messages: withSummary
                ? [
                    { side: "user", content: "SUMMARIZED_USER" },
                    { side: "assistant", content: "SUMMARIZED_REPLY" },
                    ...messages
                  ]
                : messages,
              ...(withSummary ? { summaries: [summary] } : {}),
              events: [
                ...(withSummary ? studyFixture().events! : []),
                {
                  depth: null,
                  event: { scope: null, data: { key: "note.activate", value: { note: "author-note" as never } } }
                }
              ],
              cards: [{ entity: "fixture-card", doc: cardDoc("Fixture") }],
              participants: ["fixture-card"],
              model: m,
              notes: [
                {
                  entity: "author-note",
                  revision: `author-note-${n}`,
                  doc: {
                    ...newChatNote("chat-1" as ChatId, "Author’s Note"),
                    content: `AUTHOR_NOTE_${n}`,
                    placement: { mode: "depth", depth: 0, role: "system" }
                  }
                }
              ],
              ...(start ? { historyStart: start } : {}),
              target: { direction: `GUIDANCE_${n}` },
              preset: {
                ...preset,
                prompts: preset.prompts.map((p) =>
                  p.identifier === "depthZero"
                    ? {
                        ...p,
                        content: `DEPTH_ZERO_${n}`,
                        role: "system",
                        injection_depth: 0,
                        injection_position: "absolute"
                      }
                    : p
                )
              }
            },
            workshop
              ? {
                  agent: {
                    workshop: true,
                    instructions: tailOf(n),
                    speakerCardOnly: false,
                    turnNotes: [`TURN_NOTE_${n}`]
                  }
                }
              : {}
          )
        const one = yield* build(1, [user(1)])
        const twoPath = [user(1), { side: "assistant" as const, content: "FINAL_1", workshopHistory: trace1 }, user(2)]
        const two = yield* build(2, twoPath, historyAfterDispatch(one))
        const three = yield* build(
          3,
          [...twoPath, { side: "assistant", content: "FINAL_2", workshopHistory: trace2 }, user(3)],
          historyAfterDispatch(two)
        )
        const switched = yield* build(2, twoPath, undefined, { ...model, key: key + "-other" })
        const rp = yield* build(2, twoPath, undefined, model, false)
        expect(rp.request.messages.every((m) => !m.workshopMessage)).toBe(true)
        expect(switched.request.messages.filter((m) => m.workshopMessage?.role === "toolResult")).toHaveLength(2)
        expect(JSON.stringify(switched.request.messages)).not.toContain("thinkingSignature")

        const capture = (snapshot: typeof one, suffix: Array<AssistantMessage | ToolResultMessage> = []) =>
          Effect.promise(async () => {
            const frozen = providerRequest(snapshot.request, model)
            const wire = rolloutRequest(frozen, api, suffix, [tool] as never, {
              explicitTail: cacheBreakpoints === "explicit",
              replayReasoning: true,
              reasoningTarget: { api, kind, provider, key }
            })
            let final: Wire | undefined
            const adapter = await import(`@earendil-works/pi-ai/api/${api}`)
            const stream = adapter.streamSimple(sdk, normalizeContext(wire.context), {
              apiKey: "synthetic",
              cacheRetention: "short",
              sessionId: "workshop-matrix",
              onPayload: (body: Wire) => {
                const target = { kind, api, provider: bedrockOpenAI ? "openai-bedrock" : kind, model: key }
                const request = {
                  messages: wire.context.messages,
                  breakpoints: wire.breakpoints,
                  ...(wire.stable ? { stable: wire.stable } : {}),
                  target,
                  cacheLayout,
                  cacheRetention: "short" as const,
                  sessionId: "workshop-matrix",
                  settings: { promptCacheKey: true }
                }
                const transformed = registry.transforms
                  .list()
                  .filter((t) => t.appliesTo(target))
                  .reduce((payload, t) => t.transform(payload, request), { ...body, ...wire.payload })
                final = applyShims(registry.shims.list(), transformed, target).payload
                throw new Error("Captured before transport")
              }
            })
            await stream.result()
            expect(final).toBeDefined()
            return final!
          })

        const a1 = yield* capture(one)
        const b1 = yield* capture(one, pair(1))
        const c1 = yield* capture(one, [...pair(1), ...pair(2)])
        const a2 = yield* capture(two)
        const b2 = yield* capture(two, pair(3))
        const a3 = yield* capture(three)
        const swipe = yield* capture(two)
        expect(swipe).toEqual(a2)
        expect(through(a1, "USER_MESSAGE_1")).toEqual(through(a2, "USER_MESSAGE_1"))
        expect(through(a2, "USER_MESSAGE_2")).toEqual(through(a3, "USER_MESSAGE_2"))
        expect(through(a1, tailOf(1))).toEqual(through(b1, tailOf(1)))
        expect(through(b1, read(1))).toEqual(through(c1, read(1)))
        expect(through(a2, tailOf(2))).toEqual(through(b2, tailOf(2)))
        expect(through(a2, "USER_MESSAGE_2")).toEqual(through(b2, "USER_MESSAGE_2"))

        for (const [payload, n] of [
          [a1, 1],
          [b1, 1],
          [c1, 1],
          [a2, 2],
          [b2, 2],
          [a3, 3]
        ] as const) {
          const rows = rowsOf(payload)
          const wireText = JSON.stringify(rows)
          if (withSummary) {
            expect(wireText).toContain("ACTIVE_LCM_SUMMARY")
            expect(wireText).not.toContain("SUMMARIZED_USER")
            expect(wireText).not.toContain("SUMMARIZED_REPLY")
            expect(wireText.indexOf("ACTIVE_LCM_SUMMARY")).toBeLessThan(wireText.indexOf("USER_MESSAGE_1"))
          }
          for (const part of [tailOf(n), `DEPTH_ZERO_${n}`, `GUIDANCE_${n}`, `TURN_NOTE_${n}`, `AUTHOR_NOTE_${n}`]) {
            expect(wireText.split(part)).toHaveLength(2)
            expect(wireText.indexOf(part)).toBeGreaterThan(wireText.indexOf(`USER_MESSAGE_${n}`))
          }
          for (let earlier = 1; earlier < n; earlier++) {
            expect(wireText).not.toContain(tailOf(earlier))
            expect(wireText).not.toContain(`AUTHOR_NOTE_${earlier}`)
          }
          if (n >= 2) {
            expect(wireText).toContain(read(1))
            expect(wireText).toContain(read(2))
            expect(wireText.indexOf(read(2))).toBeLessThan(wireText.indexOf("USER_MESSAGE_2"))
          }
          if (anthropic || claudeRouter) expect(countField(payload, "cache_control")).toBeLessThanOrEqual(4)
          if (bedrockOpenAI && !newerResponses) expect(countField(payload, "prompt_cache_breakpoint")).toBe(0)
          if (kind.startsWith("openai") || kind === "deepseek") expect(payload.prompt_cache_key).toBe("workshop-matrix")
        }

        const at = (payload: Wire, text: string) => rowsOf(payload).findIndex((m) => JSON.stringify(m).includes(text))
        const check = (payload: Wire, field: string, expected: string[], extra = false) => {
          const indices = expected.map((name) => at(payload, name))
          expect(indices.every((index) => index >= 0)).toBe(true)
          if (extra) expect(marked(payload, field)).toEqual(expect.arrayContaining(indices))
          else expect(marked(payload, field)).toEqual(indices.sort((a, b) => a - b))
        }
        if (anthropic || claudeRouter) {
          const field = "cache_control"
          check(a1, field, [...(withSummary ? ["ACTIVE_LCM_SUMMARY"] : []), "USER_MESSAGE_1", tailOf(1)], claudeRouter)
          check(
            a2,
            field,
            [
              ...(lookback ? (withSummary ? ["ACTIVE_LCM_SUMMARY"] : []) : ["USER_MESSAGE_1"]),
              "USER_MESSAGE_2",
              tailOf(2)
            ],
            claudeRouter
          )
          check(
            b1,
            field,
            ["USER_MESSAGE_1", ...(lookback ? (withSummary ? ["ACTIVE_LCM_SUMMARY"] : []) : [tailOf(1)]), read(1)],
            claudeRouter
          )
          check(
            c1,
            field,
            ["USER_MESSAGE_1", ...(lookback ? (withSummary ? ["ACTIVE_LCM_SUMMARY"] : []) : [read(1)]), read(2)],
            claudeRouter
          )
          check(
            b2,
            field,
            ["USER_MESSAGE_2", ...(lookback ? (withSummary ? ["ACTIVE_LCM_SUMMARY"] : []) : [tailOf(2)]), read(3)],
            claudeRouter
          )
        } else if (newerResponses) {
          check(a2, "prompt_cache_breakpoint", ["ACTIVE_LCM_SUMMARY", "USER_MESSAGE_1", "USER_MESSAGE_2"])
          check(b2, "prompt_cache_breakpoint", ["ACTIVE_LCM_SUMMARY", "USER_MESSAGE_2", tailOf(2)])
          expect(countField(b2, "prompt_cache_breakpoint")).toBe(3)
          expect(
            marked(b2, "prompt_cache_breakpoint").every((i) => rowsOf(b2)[i]!.type !== "function_call_output")
          ).toBe(true)
        } else if (router) {
          check(a2, "cache_control", ["USER_MESSAGE_2"])
          check(b2, "cache_control", [read(3)])
        }
        const inspected = sentWire(a2, wireContext(two.request, model))
        expect(inspected.messages.some((m) => m.role === "tool" && m.content.includes(read(1)))).toBe(true)
        expect(inspected.messages.some((m) => m.content.includes(`Tool call: ${tool.name}`))).toBe(true)
        if (kind === "deepseek") expect(JSON.stringify(a2)).toContain('"reasoning_content":"Read the fixture first."')
        if (!lookback)
          expect(two.request.cacheHistoryCandidate?.digest).toBe(
            cachePrefixDigests(two.request.messages)[two.request.cacheHistoryCandidate?.message ?? -1]
          )
      }).pipe(Effect.provide(env))
    )
  })
}

it("extracts only a legacy carried version's own tool trace", () => {
  const assistant = { role: "assistant", content: [{ type: "text", text: "Earlier turn." }] } as const
  const newTurn = { role: "assistant", content: [{ type: "text", text: "Selected reply." }] } as const
  const trace = workshopHistory(
    [
      { role: "rpRequest", timestamp: 0 },
      assistant,
      { role: "rpUser", message: { role: "user", content: "New user." }, timestamp: 0 },
      newTurn,
      { role: "rpApp", content: "Send the reply.", timestamp: 0, nudge: 1 },
      newTurn
    ] as never,
    "selected"
  )
  expect(trace.map((m) => m.content)).toEqual([newTurn.content])
})

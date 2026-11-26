import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { CacheSimulator, cacheClasses } from "./support/cacheSimulator.ts"
import { studyFixture, studyModel, studyRequests, compareCaches } from "./support/cacheStudy.ts"
import { assembleFixture, historyAfterDispatch } from "./support/assemblySources.ts"
import { placeBreakpoints, cachePrefixDigests } from "../src/assembler/breakpoints.ts"
import { markWireSources, providerRequest, sentWire, wireContext } from "../src/assembler/wire.ts"
import { applyAnthropicBreakpoints, applyBedrockBreakpoints } from "../src/providers/breakpoints.ts"
import { withHistoryCheckpoint } from "../src/db/historyStart.ts"

const blocks = (n: number) => Array.from({ length: n }, (_, i) => ({ digest: `prefix-${i}`, tokens: 1024 }))
describe("provider cache simulator", () => {
  it("distinguishes exact reads from 20-position lookback, including the off-by-one boundary", () => {
    for (const [distance, expected] of [
      [19, 1024],
      [20, 0]
    ] as const) {
      const sim = new CacheSimulator(cacheClasses[0]!)
      sim.request(blocks(30), [0], 0, false)
      expect(sim.request(blocks(30), [distance], 1, false).read).toBe(expected)
    }
    const sim = new CacheSimulator(cacheClasses[1]!)
    sim.request(blocks(4), [1], 0, false)
    expect(sim.request(blocks(4), [2], 1, false).read).toBe(0)
    expect(sim.request(blocks(4), [1, 3], 2, false).read).toBe(2048)
  })
  it("enforces cumulative floors, marker limits, TTL refresh/expiry and delta pricing", () => {
    const rules = { ...cacheClasses[1]!, maxMarkers: 1, minTokens: 2048, ttlS: 10 }
    const sim = new CacheSimulator(rules)
    expect(sim.request(blocks(3), [0], 0, false).write).toBe(0)
    expect(sim.request(blocks(3), [1, 2], 0, false).write).toBe(2048)
    expect(sim.request(blocks(3), [1], 9, false).read).toBe(2048)
    const hit = sim.request(blocks(3), [1], 18, false)
    expect(hit.cost).toBe(2048 * 0.1 + 1024)
    expect(sim.request(blocks(3), [1], 28, false).read).toBe(0)
  })
})
it("repeats only a byte-identical historical checkpoint through the real assembler and rebuild pins", async () => {
  const first = studyFixture()
  const fixture = { ...first, model: { ...studyModel, cacheLayout: { lookback: false, summarySplit: true } } }
  const before = await Effect.runPromise(assembleFixture(fixture))
  const next = {
    ...fixture,
    historyStart: historyAfterDispatch(before),
    messages: [
      ...fixture.messages,
      { side: "assistant" as const, content: "Synthetic reply" },
      { side: "user" as const, content: "Synthetic next question" }
    ]
  }
  const after = await Effect.runPromise(assembleFixture(next))
  expect(
    before.request.breakpoints.some(
      (b) => b.reason === "summary" && before.request.messages[b.message]!.content.includes('level="3"')
    )
  ).toBe(true)
  const previous = historyAfterDispatch(before)!.state!.cacheHistory!
  const digests = cachePrefixDigests(after.request.messages)
  const repeated = after.request.breakpoints.filter((b) => b.reason === "history")
  expect(repeated).toHaveLength(2)
  expect(digests[repeated[1]!.message]).toBe(previous)
  const rebuild = await Effect.runPromise(assembleFixture(next, { frozen: after.frozen }))
  expect(rebuild.request).toEqual(after.request)
  const changed = await Effect.runPromise(
    assembleFixture({
      ...next,
      messages: next.messages.map((m, i) => (i === 2100 ? { ...m, content: "An amended ancestor" } : m))
    })
  )
  expect(changed.request.breakpoints.filter((b) => b.reason === "history")).toHaveLength(1)
  const auto = await Effect.runPromise(assembleFixture({ ...next, model: { ...studyModel, cacheBreakpoints: "auto" } }))
  expect(providerRequest(auto.request, auto.inputs.model!).breakpoints).toEqual([])
  expect(auto.historyStart?.state?.cacheHistory).toBeUndefined()
  const lookback = await Effect.runPromise(assembleFixture(studyFixture()))
  expect(lookback.historyStart?.state?.cacheHistory).toBeUndefined()
})
it("spends exact-position markers on current and repeated history before splitting summary tiers", () => {
  const messages = [
    { kind: "prefix" },
    { kind: "summary", summaryLevel: 3 },
    { kind: "summary", summaryLevel: 1 },
    { kind: "history" },
    { kind: "history" },
    { kind: "volatile" }
  ] as const
  expect(placeBreakpoints(messages, true, { lookback: false, summarySplit: true }).slice(0, 2)).toEqual([
    { message: 0, reason: "prefix" },
    { message: 4, reason: "history" }
  ])
  expect(
    placeBreakpoints(messages, true, { lookback: false, summarySplit: true, previousHistory: 3 }).slice(0, 3)
  ).toEqual([
    { message: 0, reason: "prefix" },
    { message: 4, reason: "history" },
    { message: 3, reason: "history" }
  ])
})
it("only advances the history checkpoint once the final payload includes its marker", async () => {
  const model = { ...studyModel, cacheLayout: { lookback: false, summarySplit: true } }
  const snapshot = await Effect.runPromise(assembleFixture({ ...studyFixture(), model }))
  const state = snapshot.historyStart!.state!
  const checkpoint = snapshot.request.cacheHistoryCandidate!
  expect(state.cacheHistory).toBeUndefined()
  const mapping = wireContext(snapshot.request, model)
  const wire = providerRequest(snapshot.request, model)
  const marker = { type: "ephemeral" }
  for (const maxMarkers of [2, 4]) {
    const payload = {
      system: [{ type: "text", text: wire.context.systemPrompt, cache_control: marker }],
      messages: mapping.messages.slice(1).map((message, i, all) => ({
        role: message.role,
        content: [{ type: "text", text: message.content, ...(i === all.length - 1 ? { cache_control: marker } : {}) }]
      }))
    }
    markWireSources(payload, mapping)
    applyAnthropicBreakpoints(payload, wire.context.messages, wire.breakpoints, { maxMarkers })
    const sent = sentWire(payload, mapping, undefined, checkpoint)
    const next = withHistoryCheckpoint(state, sent.historyCheckpointSent)
    expect(next.cacheHistory).toBe(maxMarkers === 2 ? undefined : checkpoint.digest)
  }
})

it("retains the older summary tier without marking pinned lore", () => {
  const messages = ["prefix", "pinned", "summary", "summary", "history", "volatile"].map((kind, i) => ({
    kind: kind as "prefix" | "pinned" | "summary" | "history" | "volatile",
    summaryLevel: i === 2 ? 3 : i === 3 ? 1 : 0
  }))
  expect(placeBreakpoints(messages, false, { summarySplit: true })).toContainEqual({ message: 2, reason: "summary" })
  expect(placeBreakpoints(messages).some((b) => b.reason === "pinned")).toBe(false)
})
it("shows exact-position new-reply improvement while preserving swipes", async () => {
  const rows = compareCaches(await studyRequests("", 4, 3))
  const pick = (layout: string, group: string) =>
    rows.find((r) => r.provider === cacheClasses[2]!.name && r.layout === layout && r.group === group)!
  expect(pick("recommended", "new").readPct).toBeGreaterThan(pick("current", "new").readPct)
  expect(pick("recommended", "new").relativeCost).toBeLessThan(pick("current", "new").relativeCost)
  expect(pick("recommended", "swipe").readPct).toBeGreaterThan(99)
})
it("detects random and clock macros in prefix prompts, including card templates", async () => {
  for (const macro of ["{{roll::1d6}}", "{{random::a::b}}", "{{time}}", "{{date}}", "{{isotime}}"]) {
    const snapshot = await Effect.runPromise(assembleFixture(studyFixture(macro)))
    expect(
      snapshot.issues.some((i) => i.kind === "cache_breakpoints"),
      macro
    ).toBe(true)
    expect(snapshot.request.breakpoints.some((b) => b.reason === "history")).toBe(true)
  }
})
it("injects bounded explicit-only Chat and Responses checkpoints, with cumulative floors", () => {
  for (const responses of [false, true]) {
    const transcript = Array.from({ length: 6 }, (_, i) => ({
      role: "user" as const,
      content: `${i}:` + "x".repeat(4200),
      timestamp: 0
    }))
    const items = transcript.map((m) => ({
      role: "user",
      content: [{ type: responses ? "input_text" : "text", text: m.content }]
    }))
    const payload = responses ? { input: items } : { messages: items }
    applyBedrockBreakpoints(payload, transcript, [3, 2, 0, 1], responses)
    const marked = items.flatMap((m, i) => (m.content.some((b) => "prompt_cache_breakpoint" in b) ? [i] : []))
    expect(marked).toEqual(responses ? [0, 2, 3] : [0, 2, 3, 5])
  }
})

it("keeps seeded pick stable and observes volatile macros nested in card templates", async () => {
  const picked = await Effect.runPromise(assembleFixture(studyFixture("{{pick::one::two}}")))
  expect(picked.issues.some((i) => i.kind === "cache_breakpoints")).toBe(false)
  const fixture = studyFixture()
  const nested = {
    ...fixture,
    cards: fixture.cards.map((c) => ({ ...c, doc: { ...c.doc, description: "A nested {{roll::1d6}}." } })),
    preset: {
      ...fixture.preset,
      prompts: fixture.preset.prompts.map((p) =>
        p.identifier === "main" ? { ...p, content: p.content + "{{description}}" } : p
      )
    }
  }
  const snapshot = await Effect.runPromise(assembleFixture(nested))
  expect(snapshot.issues.some((i) => i.kind === "cache_breakpoints")).toBe(true)
})

it("uses a markable Responses history boundary and respects smaller wire budgets", () => {
  expect(
    placeBreakpoints(
      [
        { kind: "prefix", role: "system" },
        { kind: "history", role: "user" },
        { kind: "history", role: "assistant" },
        { kind: "volatile", role: "user" }
      ],
      false,
      { inputOnly: true }
    )[0]
  ).toEqual({ message: 1, reason: "history" })
  const transcript = [{ role: "user" as const, content: "x".repeat(5000), timestamp: 0 }]
  const small = { input: [{ role: "user", content: transcript[0]!.content }] }
  applyBedrockBreakpoints(small, transcript, [0], true, { minTokens: 2000 })
  expect(typeof small.input[0]!.content).toBe("string")
  const occupied = {
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: "x".repeat(5000), prompt_cache_breakpoint: { mode: "explicit" } }]
      }
    ]
  }
  applyBedrockBreakpoints(occupied, transcript, [0], true, { maxMarkers: 2 })
  expect(occupied.input[0]!.content).toHaveLength(1)
})

it("suppresses explicit OpenAI-compatible markers when cache retention is off", async () => {
  const snapshot = await Effect.runPromise(assembleFixture(studyFixture()))
  for (const api of ["openai-completions", "openai-responses"]) {
    const model = { ...studyModel, api, settings: { ...studyModel.settings, cacheRetention: "none" as const } }
    const wire = providerRequest(snapshot.request, model)
    expect(wire.breakpoints).toEqual([])
    const payload = { ...wire.payload }
    applyBedrockBreakpoints(payload, wire.context.messages, wire.breakpoints, api === "openai-responses")
    expect(JSON.stringify(payload)).not.toContain("prompt_cache_breakpoint")
  }
})

it("accepts configured Chat budgets above four while retaining the Responses ceiling", async () => {
  const { CacheLayout } = await import("@dreamspan/shared/providers.ts")
  const { Schema } = await import("effect")
  expect(Schema.decodeUnknownSync(CacheLayout)({ maxMarkers: 5 })).toEqual({ maxMarkers: 5 })
  for (const responses of [false, true]) {
    const transcript = Array.from({ length: 7 }, (_, i) => ({
      role: "user" as const,
      content: `${i}:` + "x".repeat(4200),
      timestamp: 0
    }))
    const items = transcript.map((m) => ({
      role: "user",
      content: [{ type: responses ? "input_text" : "text", text: m.content }]
    }))
    const parameters = { type: "object", properties: { prompt_cache_breakpoint: { type: "string" } } }
    const payload = responses
      ? { input: items, tools: [{ type: "function", name: "synthetic", parameters }] }
      : { messages: items, tools: [{ type: "function", function: { name: "synthetic", parameters } }] }
    applyBedrockBreakpoints(payload, transcript, [4, 3, 2, 1], responses, { maxMarkers: 5 })
    const marked = items.flatMap((m, i) => (m.content.some((b) => "prompt_cache_breakpoint" in b) ? [i] : []))
    expect(marked).toEqual(responses ? [2, 3, 4] : [1, 2, 3, 4, 6])
  }
})

it("keeps leading system prompts intact unless a structural pinned-lore boundary exists", async () => {
  const snapshot = await Effect.runPromise(assembleFixture(studyFixture()))
  const request = {
    ...snapshot.request,
    summaryStart: 3,
    messages: [
      { role: "system" as const, content: "Stable instructions." },
      { role: "system" as const, content: "A changing prefix instruction." },
      { role: "user" as const, content: "Synthetic question." }
    ],
    breakpoints: [{ message: 0, reason: "prefix" as const }]
  }
  const ordinary = providerRequest(request, studyModel)
  expect(ordinary.context.systemPrompt).toContain("A changing prefix instruction.")
  const pinned = providerRequest({ ...request, pinnedStart: 1 }, studyModel)
  expect(pinned.context.systemPrompt).not.toContain("A changing prefix instruction.")
})

it("requires an encoding capability before the registered OpenAI extension changes a payload", async () => {
  const builtins = await import("../src/providers/builtins.ts")
  const { ProviderRegistry } = await import("../src/providers/registry.ts")
  await Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* ProviderRegistry
      const transform = registry.transforms.get("bedrock-openai-explicit-breakpoints")!
      const messages = [{ role: "user" as const, content: "x".repeat(5000), timestamp: 0 }]
      const payload = { messages: [{ role: "user", content: messages[0]!.content }] }
      const request = { target: { kind: "openai-chat", api: "openai-completions" }, messages, breakpoints: [0] }
      transform.transform(payload, request)
      expect(JSON.stringify(payload)).not.toContain("prompt_cache_breakpoint")
      transform.transform(payload, { ...request, cacheLayout: { marker: "prompt_cache_breakpoint" } })
      expect(JSON.stringify(payload)).toContain("prompt_cache_breakpoint")
    }).pipe(Effect.scoped, Effect.provide(builtins.layer))
  )
})

it("restores continuity caching when LCM freezes a volatile prefix", async () => {
  const { takeSummaryPrefix, applySummaryPrefix } = await import("../src/lcm/prefix.ts")
  const fixture = { ...studyFixture("{{speaker}}"), target: { speaker: "mira" } }
  const first = await Effect.runPromise(assembleFixture(fixture, { random: () => 0.1 }))
  const next = await Effect.runPromise(assembleFixture(fixture, { summarizing: true, random: () => 0.9 }))
  expect(next.request.breakpoints).toEqual([])
  expect(applySummaryPrefix(next)).toBe(next)
  const pinned = applySummaryPrefix(next, takeSummaryPrefix(first))
  expect(pinned.request.messages[0]).toEqual(first.request.messages[0])
  const end = Math.max(-1, ...pinned.pieces.filter((p) => p.source.kind === "summary").flatMap((p) => p.messages))
  expect(end).toBeGreaterThan(0)
  expect(pinned.request.breakpoints).toContainEqual({ message: end, reason: "summary" })
  const summaries = next.pieces.filter((p) => p.source.kind === "summary")
  const children = summaries
    .slice(-2)
    .flatMap((p) =>
      p.source.kind === "summary" ? [{ summaryId: p.source.id as never, revisionId: p.source.revision as never }] : []
    )
  const condensation = applySummaryPrefix(
    {
      ...next,
      summaryJob: {
        id: "synthetic-condensation",
        clipTokens: 4000,
        inputs: [],
        children,
        tail: "Condense the final two summaries.",
        style: "direct"
      }
    },
    takeSummaryPrefix(first)
  )
  const continuityEnd = Math.max(...summaries.slice(0, -2).flatMap((p) => p.messages))
  expect(condensation.request.breakpoints).toContainEqual({ message: continuityEnd, reason: "summary" })
  expect(condensation.request.breakpoints).not.toContainEqual({ message: end, reason: "summary" })
})

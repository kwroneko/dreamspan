// Deterministic study requests come from the product assembler, never hand-built prompts.
import { Effect, Schema, Scope, Exit } from "effect"
import { Summary } from "@dreamspan/shared/lcm.ts"
import { providerRequest } from "../../src/assembler/wire.ts"
import { importStPreset } from "../../src/formats/preset.ts"
import { cachePrefixDigests, placeBreakpoints, summaryLevelOf } from "../../src/assembler/breakpoints.ts"
import type { ContextSnapshot, ModelInput } from "../../src/assembler/types.ts"
import type { Stability } from "../../src/assembler/st.ts"
import { planMaintenance } from "../../src/lcm/maintenance.ts"
import { makeAssembler } from "../../src/assembler/assembler.ts"
import { assembleFixture, type AssemblyFixture, type FixtureMessage } from "./assemblySources.ts"
import { cardDoc } from "./docs.ts"
import { CacheSimulator, cacheClasses, type CacheBlock } from "./cacheSimulator.ts"

export const studyModel: ModelInput = {
  connectionId: "synthetic",
  modelId: "synthetic",
  kind: "anthropic",
  api: "anthropic-messages",
  key: "synthetic",
  prefill: "none",
  cacheBreakpoints: "explicit",
  context: 131072,
  presetOverride: null,
  settings: { context_target: 100000, samplers: { openai_max_context: 131072, openai_max_tokens: 200 } }
}
const summary = (from: number, to: number, level: number, epoch = 0) =>
  Schema.decodeUnknownSync(Summary)({
    id: `summary-${from}-${to}-${epoch}`,
    chatId: "chat-1",
    level,
    firstSlotId: `slot-${from - 1}`,
    lastSlotId: `slot-${to - 1}`,
    from,
    to,
    slotCount: to - from + 1,
    revisionNumber: 1,
    revisionId: `rev-${from}-${to}-${epoch}`,
    content: `Synthetic tier ${level} ${from} ${to} ${epoch}. ` + "continuity ".repeat(180),
    tokens: 500,
    origin: "generated",
    status: "complete",
    error: null,
    batchId: null,
    rowVersion: 1,
    fresh: true,
    inputs: [],
    children: []
  })
export const studyFixture = (volatile = "", depth = 4): AssemblyFixture => ({
  messages: Array.from({ length: 2400 }, (_, i) => ({
    side: i % 2 ? "user" : "assistant",
    content: `Turn ${i}. ` + "The synthetic ferry crossed the river. ".repeat(8)
  })),
  cards: [{ entity: "mira", doc: cardDoc("Mira") }],
  participants: ["mira"],
  model: studyModel,
  preset: importStPreset(
    JSON.stringify({
      main_prompt: "Synthetic instructions. ".repeat(260) + volatile,
      group_nudge_prompt: "",
      frequency_penalty: 0,
      prompts: [
        {
          identifier: "main",
          name: "Main",
          role: "system",
          content: "Synthetic instructions. ".repeat(260) + volatile,
          system_prompt: true
        },
        { identifier: "chatHistory", marker: true }
      ],
      prompt_order: [
        {
          character_id: 100001,
          order: [
            { identifier: "main", enabled: true },
            { identifier: "chatHistory", enabled: true }
          ]
        }
      ]
    })
  ).document!,
  notes: [
    {
      entity: "note",
      revision: "note-1",
      doc: {
        schema_version: 1,
        title: "Synthetic direction",
        content: "Remember the ferry.",
        placement: { mode: "depth", depth, role: "system" },
        owner: { card: "mira" as never },
        on_by_default: true,
        exportable: false
      }
    }
  ],
  summaries: [
    summary(1, 1000, 3),
    summary(1001, 1600, 2),
    summary(1601, 1700, 1),
    summary(1701, 1800, 1),
    summary(1801, 1900, 1),
    summary(1901, 2000, 1)
  ],
  events: [
    {
      depth: null,
      event: {
        scope: null,
        data: {
          key: "lcm.settings",
          value: { enabled: true, recentTarget: 48000, recentMax: 64000, layerTarget: 12000, layerMax: 18000 }
        }
      }
    }
  ]
})

export interface StudyRequest {
  readonly group: "new" | "swipe" | "cut" | "condense"
  readonly moved: boolean
  readonly time: number
  readonly blocks: ReadonlyArray<CacheBlock>
  readonly metadata: ReadonlyArray<{ readonly kind: Stability; readonly summaryLevel: number; readonly role?: string }>
  readonly sdkPrefix: number
  readonly current: ReadonlyArray<number>
  readonly snapshot: ContextSnapshot
}
export const studyRequests = async (volatile = "", depth = 4, turns = 30): Promise<ReadonlyArray<StudyRequest>> => {
  const scope = Effect.runSync(Scope.make())
  const assembler = Effect.runSync(Scope.provide(scope)(makeAssembler))
  let metadata: StudyRequest["metadata"] = []
  const stage = assembler.stages.get("breakpoints")!
  Effect.runSync(
    Scope.provide(scope)(
      assembler.stages.register({
        ...stage,
        run: (assembly) => {
          metadata = (assembly.messages ?? []).map((m) => ({
            kind: m.kind,
            role: m.role,
            summaryLevel: summaryLevelOf(assembly.pieces, m.pieces)
          }))
          return stage.run(assembly)
        }
      })
    )
  )
  let fixture = studyFixture(volatile, depth)
  const base = fixture.messages
  const result: StudyRequest[] = []
  let prior: ContextSnapshot | undefined
  let clock = 0
  const summaries = [...fixture.summaries!]
  const assemble = async (group: StudyRequest["group"], swipe: number) => {
    const snapshot = await Effect.runPromise(
      assembleFixture(
        {
          ...fixture,
          summaries,
          historyStart: prior?.historyStart,
          now: Date.UTC(2026, 0, 1) + clock * 1000,
          target: { ordinal: swipe }
        },
        { assembler, random: () => ((clock * 7919) % 104729) / 104729 }
      )
    )
    const digests = cachePrefixDigests(snapshot.request.messages)
    const wire = providerRequest(snapshot.request, studyModel)
    result.push({
      group,
      moved:
        prior !== undefined &&
        (snapshot.historyMove !== "unchanged" || prior.historyStart?.depth !== snapshot.historyStart?.depth),
      time: clock,
      snapshot,
      metadata,
      blocks: snapshot.request.messages.map((m, i) => ({
        digest: digests[i]!,
        tokens: Math.ceil(m.content.length / 4) + 4
      })),
      sdkPrefix: wire.context.systemPrompt ? snapshot.request.messages.length - wire.context.messages.length - 1 : -1,
      current: snapshot.request.breakpoints.map((b) => b.message)
    })
    prior = snapshot
    clock += 12
  }
  await assemble("new", 0)
  for (let turn = 0; turn < turns; turn++) {
    const newMessages: FixtureMessage[] = [
      { side: "assistant", content: `Reply ${turn}. ` + "Synthetic prose. ".repeat(70) },
      { side: "user", content: `Question ${turn}. ` + "Synthetic question. ".repeat(12) }
    ]
    fixture = { ...fixture, messages: [...fixture.messages, ...newMessages] }
    let group: StudyRequest["group"] = "new"
    if (turn > 0 && turn % 6 === 0) {
      const from = summaries.at(-1)!.to + 1
      summaries.push(summary(from, from + 11, 1))
      group = "cut"
    }
    if (turn === 18) {
      fixture = {
        ...fixture,
        events: [
          {
            depth: null,
            event: {
              scope: null,
              data: {
                key: "lcm.settings",
                value: { enabled: true, recentTarget: 18000, recentMax: 22000, layerTarget: 12000, layerMax: 18000 }
              }
            }
          }
        ]
      }
      group = "cut"
    }
    if (turn > 0 && turn % 12 === 0) {
      const planned = planMaintenance({
        summaries: summaries.map((s) => ({ ...s, batchLive: false })),
        layer: summaries,
        liveJobs: [],
        held: [],
        hasContent: () => true,
        forced: new Set(),
        reason: "reply",
        settings: {
          fanout: 4,
          condenseTarget: 500,
          eagerMinChildren: 2,
          absorbMaxChildren: 8,
          layerCost: summaries.length * 500,
          layerTarget: 12000,
          layerMax: 18000,
          lastFinishedEager: false
        }
      }).condensations[0]
      if (!planned) throw new Error("Synthetic layer must offer a real LCM condensation")
      const old = summaries.filter((s) => planned.children.includes(s.id))
      const first = summaries.findIndex((s) => s.id === old[0]!.id)
      summaries.splice(first, old.length, summary(old[0]!.from, old.at(-1)!.to, planned.level, turn))
      group = "condense"
    }
    // Three siblings replay the same 2400-message ancestor and diverge in the recent suffix.
    if (turn === 10 || turn === 20) fixture = { ...fixture, messages: [...base, ...newMessages] }
    await assemble(group, 0)
    if (turn % 2 === 0) for (let swipe = 1; swipe <= 20 + (turn % 31); swipe++) await assemble("swipe", swipe)
  }
  await Effect.runPromise(Scope.close(scope, Exit.void))
  return result
}
const layouts = [
  "current",
  "repeat",
  "split-a",
  "split-b",
  "split-c",
  "split-d",
  "repeat+split",
  "recommended"
] as const
export const compareCaches = (requests: ReadonlyArray<StudyRequest>) => {
  const rows: Array<{
    provider: string
    layout: string
    group: string
    replies: number
    readPct: number
    writePerReply: number
    relativeCost: number
  }> = []
  for (const rules of cacheClasses)
    for (const layout of layouts) {
      const simulator = new CacheSimulator(rules)
      const totals = new Map<string, { input: number; read: number; write: number; cost: number; n: number }>()
      let previousHistory: string | undefined
      for (const req of requests) {
        const previous = req.blocks.findIndex((b) => b.digest === previousHistory)
        const current = placeBreakpoints(req.metadata, req.moved, { inputOnly: rules.name === "Responses AWS" })
        const history = current.find((b) => b.reason === "history")?.message ?? -1
        const split =
          placeBreakpoints(req.metadata, req.moved, { summarySplit: true }).find((b) => b.reason === "summary")
            ?.message ?? -1
        let markers = current.map((b) => b.message)
        let automaticFinal = rules.automaticFinal
        if (layout === "repeat") markers = [history, previous, ...markers.filter((i) => i !== history)]
        if (layout.startsWith("split-")) {
          const replace = { "split-a": "prefix", "split-b": "summary", "split-c": "history" }[
            layout as "split-a" | "split-b" | "split-c"
          ]
          if (layout === "split-d") {
            markers.push(split)
            automaticFinal = false
          } else markers = current.map((b) => (b.reason === replace ? split : b.message))
        }
        if (layout === "recommended" || layout === "repeat+split")
          markers = placeBreakpoints(req.metadata, req.moved, {
            inputOnly: rules.name === "Responses AWS",
            lookback: rules.mode === "lookback",
            summarySplit: layout === "repeat+split",
            previousHistory: previous
          }).map((b) => b.message)
        // The prefix is an SDK marker on Messages. It consumes a slot before injection.
        if (rules.name.startsWith("Anthropic") && layout !== "split-a") {
          markers = [req.sdkPrefix, ...markers]
        }
        const value = simulator.request(req.blocks, markers, req.time, automaticFinal)
        const total = totals.get(req.group) ?? { input: 0, read: 0, write: 0, cost: 0, n: 0 }
        total.input += value.input
        total.read += value.read
        total.write += value.write
        total.cost += value.cost
        total.n++
        totals.set(req.group, total)
        previousHistory = req.blocks[history]?.digest
      }
      for (const [group, v] of totals)
        rows.push({
          provider: rules.name,
          layout,
          group,
          replies: v.n,
          readPct: (v.read / v.input) * 100,
          writePerReply: v.write / v.n,
          relativeCost: v.cost / v.input
        })
    }
  return rows
}

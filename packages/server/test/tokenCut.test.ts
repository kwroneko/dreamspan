import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { prepareTokenizer } from "../src/importer/tokenizer.ts"
import { builtinTextCounters, type TextTokenCounter } from "../src/providers/textCounters.ts"
import { prepareTextTokens } from "../src/assembler/textTokens.ts"
import { tokensOf } from "../src/assembler/st.ts"
import { lastBreakpoint, prefixChange, tokensBetween } from "../src/assembler/warmth.ts"
import { schemaPrefillBudget } from "../src/assembler/prefill.ts"
import { importStPreset } from "../src/formats/preset.ts"
import { assembleFixture, type AssemblyFixture } from "./support/assemblySources.ts"
import { cardDoc } from "./support/docs.ts"

const fixture = (content: string, key = "gpt-4o"): AssemblyFixture => ({
  cards: [{ entity: "mira", doc: cardDoc("Mira") }],
  participants: ["mira"],
  messages: Array.from({ length: 12 }, (_, i) => ({ side: i % 2 ? "assistant" : "user", content })),
  preset: importStPreset(JSON.stringify({ openai_max_context: 600, openai_max_tokens: 40 })).document!,
  model: {
    connectionId: "connection",
    modelId: "model",
    kind: "openai-chat",
    api: "openai-completions",
    key,
    prefill: "none",
    context: null,
    presetOverride: null,
    cacheBreakpoints: "auto"
  }
})

describe("tokenizer context cuts", () => {
  it("reads older windows while their real token counts still fit", async () => {
    const base = fixture("x".repeat(120))
    const snapshot = await Effect.runPromise(
      assembleFixture({
        ...base,
        messages: Array.from({ length: 450 }, () => ({ side: "user", content: "x".repeat(120) })),
        preset: { ...base.preset, samplers: { ...base.preset.samplers, openai_max_context: 12_000 } }
      })
    )
    expect(snapshot.historyStart!.depth).toBe(0)
    expect(snapshot.request.messages.filter((m) => m.content === "x".repeat(120))).toHaveLength(450)
  })
  for (const [key, encoding] of [
    ["gpt-4o", "o200k_base"],
    ["gpt-4", "cl100k_base"],
    ["meta-llama/llama-3.1-8b-instruct", "llama3"]
  ] as const) {
    it(`fits history using ${key}'s tokenizer`, async () => {
      const count = await prepareTokenizer(encoding)
      const compact = await Effect.runPromise(assembleFixture(fixture("x".repeat(120), key)))
      const dense = await Effect.runPromise(assembleFixture(fixture("😀".repeat(45), key)))
      expect(compact.historyStart!.depth).toBe(0)
      expect(dense.historyStart!.depth).toBeGreaterThan(0)
      for (const snapshot of [compact, dense]) {
        const tokens = 3 + snapshot.request.messages.reduce((sum, m) => sum + tokensOf(m, count), 0)
        expect(tokens + 40).toBeLessThanOrEqual(600)
      }
    })
  }

  it("counts cache prefixes and changed wire suffixes with the selected tokenizer", async () => {
    const before = await Effect.runPromise(assembleFixture(fixture("x".repeat(120))))
    const after = await Effect.runPromise(assembleFixture(fixture("😀".repeat(45))))
    const count = await Effect.runPromise(prepareTextTokens(builtinTextCounters, after.inputs.model))
    const end = lastBreakpoint(before)
    expect(tokensBetween(before, 0, end, count)).toBe(
      before.request.messages.slice(0, end + 1).reduce((n, m) => n + tokensOf(m, count), 0)
    )
    expect(tokensBetween(before, 0, end, count)).not.toBe(tokensBetween(before, 0, end))
    const changed = prefixChange(before, after, () => ({ label: "Synthetic message" }), count)!
    expect(changed.tokens).toBeGreaterThan(0)
    expect(changed.tokens).not.toBe(prefixChange(before, after, () => ({ label: "Synthetic message" }))!.tokens)
    expect(prefixChange(before, before, () => ({ label: "Synthetic message" }), count)).toBeNull()
    expect(schemaPrefillBudget("😀".repeat(45), count)).not.toEqual(schemaPrefillBudget("😀".repeat(45)))
  })

  it("refuses a newest message whose real tokens exceed the available history", async () => {
    const base = fixture("")
    await expect(
      Effect.runPromise(
        assembleFixture({
          ...base,
          messages: [{ side: "user", content: "😀".repeat(600) }]
        })
      )
    ).rejects.toMatchObject({ reason: "budget" })
  })

  it("uses the newest local preparation, memoizes fragments and never prepares remote counters", async () => {
    let calls = 0
    const local: TextTokenCounter = {
      id: "synthetic",
      remote: false,
      label: () => "Synthetic",
      appliesTo: () => true,
      count: () => Effect.succeed([]),
      prepare: async () => () => ++calls
    }
    const remote: TextTokenCounter = {
      ...local,
      id: "remote",
      remote: true,
      prepare: async () => {
        throw new Error("No network")
      }
    }
    const count = await Effect.runPromise(
      prepareTextTokens([...builtinTextCounters, local, remote], fixture("").model!)
    )
    expect(count("first")).toBe(1)
    expect(count("first")).toBe(1)
    expect(count("second")).toBe(2)
    expect(calls).toBe(2)
  })

  it("uses a real local approximation for unknown models and survives tokenizer failure", async () => {
    const count = await Effect.runPromise(prepareTextTokens(builtinTextCounters, fixture("", "unknown").model!))
    expect(count("x".repeat(120))).toBe((await prepareTokenizer("o200k_base"))("x".repeat(120)))
    const failed: TextTokenCounter = {
      id: "failed",
      remote: false,
      label: () => "Failed",
      appliesTo: () => true,
      count: () => Effect.succeed([]),
      prepare: async () => {
        throw new Error("Unavailable")
      }
    }
    const fallback = await Effect.runPromise(prepareTextTokens([failed], null))
    expect(fallback("123456789")).toBe(3)
  })
})

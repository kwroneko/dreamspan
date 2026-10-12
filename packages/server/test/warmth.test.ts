import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { prefixChange, lastBreakpoint, tokensBetween } from "../src/assembler/warmth.ts"
import type { ModelInput, Source } from "../src/assembler/types.ts"
import { importStPreset } from "../src/formats/preset.ts"
import { assembleFixture, type AssemblyFixture } from "./support/assemblySources.ts"
import { cardDoc } from "./support/docs.ts"

const model: ModelInput = {
  connectionId: "c",
  modelId: "m",
  kind: "anthropic",
  api: "anthropic-messages",
  key: "mock-model",
  prefill: "assistant",
  cacheBreakpoints: "explicit",
  context: 200000,
  presetOverride: null
}
const fixture: AssemblyFixture = {
  cards: [{ entity: "mira", doc: cardDoc("Mira", { description: "x" }) }],
  participants: ["mira"],
  messages: [{ side: "user", content: "Hello" }],
  model,
  preset: importStPreset(JSON.stringify({ frequency_penalty: 0, use_sysprompt: false })).document!
}
const describe = (source: Source) => ({ kind: source.kind, label: "Synthetic source", slotId: null })

it.effect("compares the provider's system conversion", () =>
  Effect.gen(function* () {
    const last = yield* assembleFixture(fixture)
    const next = yield* assembleFixture({
      ...fixture,
      preset: importStPreset(JSON.stringify({ frequency_penalty: 0, use_sysprompt: true })).document!
    })
    assert.isNotNull(prefixChange(last, next, describe))
  })
)
it.effect("without breakpoints never claims a reusable prefix", () =>
  Effect.gen(function* () {
    const last = yield* assembleFixture(fixture)
    const noPrefix = { ...last, request: { ...last.request, breakpoints: [] } }
    assert.isNotNull(prefixChange(noPrefix, noPrefix, describe))
  })
)
it.effect("counts the next uncached suffix when a card expands", () =>
  Effect.gen(function* () {
    const last = yield* assembleFixture(fixture)
    const next = yield* assembleFixture({
      ...fixture,
      cards: [{ entity: "mira", doc: cardDoc("Mira", { description: "x".repeat(4000) }) }]
    })
    const change = prefixChange(last, next, describe)!
    assert.strictEqual(
      change.tokens,
      tokensBetween(
        next,
        next.request.messages.findIndex((m, i) => m.content !== last.request.messages[i]?.content),
        lastBreakpoint(next)
      )
    )
    assert.isAbove(change.tokens, 1000)
  })
)
it.effect("identifies unchanged history pieces removed by the budget", () =>
  Effect.gen(function* () {
    const messages = Array.from({ length: 40 }, (_, i) => ({
      side: i % 2 ? ("assistant" as const) : ("user" as const),
      content: `Synthetic turn ${i}. ${"long ".repeat(20)}`
    }))
    const bounded = {
      ...fixture,
      messages,
      preset: importStPreset(JSON.stringify({ openai_max_context: 800, openai_max_tokens: 100 })).document!
    }
    const last = yield* assembleFixture(bounded)
    const next = yield* assembleFixture({
      ...bounded,
      messages: [...messages, { side: "user", content: `Another synthetic turn. ${"long ".repeat(20)}` }]
    })
    assert.include(prefixChange(last, next, describe)!.reason, "context reached its maximum")
  })
)

it.effect("reports an amendment only when the same version's text changes", () =>
  Effect.gen(function* () {
    const last = yield* assembleFixture(fixture)
    const next = yield* assembleFixture({ ...fixture, messages: [{ side: "user", content: "Changed text" }] })
    assert.equal(prefixChange(last, next, describe)!.reason, "Synthetic source was amended.")
  })
)

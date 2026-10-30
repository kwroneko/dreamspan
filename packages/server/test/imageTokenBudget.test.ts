// Images in the context budget (ARCHITECTURE §15): an image's estimate counts with its
// message's text, so an expensive image moves the history's start, and images past the
// model's last-N limit count nothing. In-memory fixtures; synthetic cards.
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import type { CardDoc } from "@rp/shared/docs/card.ts"
import { importCard } from "../src/formats/cardImport.ts"
import { importStPreset } from "../src/formats/preset.ts"
import { tokensOf } from "../src/assembler/st.ts"
import { fitSummaryOutput } from "../src/lcm/requestBudget.ts"
import type { ContextSnapshot, ModelInput } from "../src/assembler/types.ts"
import { assembleFixture, type AssemblyFixture, type FixtureMessage } from "./support/assemblySources.ts"
import { json, run } from "./formats/support.ts"

const card = (name: string): CardDoc =>
  run(importCard(json({ spec: "chara_card_v2", spec_version: "2.0", data: { name, description: `${name}.` } }))).card

const model = (fields: Partial<ModelInput>): ModelInput => ({
  connectionId: "connection",
  modelId: "model",
  kind: "openai-chat",
  api: "openai-completions",
  key: "gpt-4o",
  prefill: "none",
  cacheBreakpoints: "auto",
  context: null,
  presetOverride: null,
  vision: true,
  ...fields
})

const image = (n: number) => ({ mediaId: `media-${n}`, sha256: String(n).padStart(64, "0"), width: 1024, height: 1024 })

const fixture = (messages: ReadonlyArray<FixtureMessage>, fields: Partial<ModelInput>): AssemblyFixture => ({
  messages,
  cards: [
    { entity: "mira", doc: card("Mira") },
    { entity: "tobin", doc: card("Tobin") }
  ],
  participants: ["mira"],
  persona: "tobin",
  preset: importStPreset(
    JSON.stringify({ frequency_penalty: 0, group_nudge_prompt: "", openai_max_context: 20_000, openai_max_tokens: 200 })
  ).document!,
  model: model(fields)
})

const history = (withImage: ReadonlyArray<number>) =>
  Array.from({ length: 20 }, (_, i): FixtureMessage => ({
    side: i % 2 === 0 ? "assistant" : "user",
    content: `message ${i} ${"word ".repeat(40)}`,
    ...(withImage.includes(i) ? { images: [image(i)] } : {})
  }))

const assembled = (f: AssemblyFixture) => Effect.runPromise(assembleFixture(f)) as Promise<ContextSnapshot>
const sentText = (snapshot: ContextSnapshot) =>
  snapshot.request.messages
    .filter((m) => m.content.includes("message "))
    .map((m) => /message (\d+)/.exec(m.content)![1])

describe("images in the context budget", () => {
  it("move the history's start when the model's formula makes them expensive", async () => {
    // gpt-4o: 765 tokens for 1024×1024; gpt-4o-mini: 2,833 + 4 × 5,667 = 25,501.
    const cheap = await assembled(fixture(history([5]), { key: "gpt-4o" }))
    expect(sentText(cheap)).toHaveLength(20)
    const withImage = cheap.request.messages.find((m) => m.images?.length)!
    expect(withImage.images![0]!.estimate).toMatchObject({ tokens: 765, basis: "formula" })
    expect(tokensOf(withImage)).toBe(tokensOf({ ...withImage, images: [] }) + 765)

    const expensive = await assembled(fixture(history([5]), { key: "gpt-4o-mini" }))
    const sent = sentText(expensive)
    expect(sent.length).toBeLessThan(20)
    expect(sent).not.toContain("5")
    expect(sent.at(-1)).toBe("19")
    expect(expensive.request.messages.some((m) => m.images?.length)).toBe(false)
  })

  it("count nothing for images past the model's last-N limit", async () => {
    const snapshot = await assembled(fixture(history([3, 7, 11, 15]), { key: "gpt-4o", maxImages: 2 }))
    const images = snapshot.request.messages.flatMap((m) => m.images ?? [])
    expect(images.map((i) => i.estimate?.sent !== false)).toEqual([false, false, true, true])
    const total = snapshot.request.messages.reduce((n, m) => n + tokensOf(m), 0)
    const text = snapshot.request.messages.reduce((n, m) => n + tokensOf({ ...m, images: [] }), 0)
    expect(total - text).toBe(2 * 765)
  })

  it("budget an unknown model's image at the reserve, and say it's unknown", async () => {
    const snapshot = await assembled(fixture(history([19]), { key: "local-vision" }))
    const estimate = snapshot.request.messages.flatMap((m) => m.images ?? [])[0]!.estimate!
    expect(estimate).toMatchObject({ tokens: null, basis: "unknown" })
    const message = snapshot.request.messages.find((m) => m.images?.length)!
    expect(tokensOf(message) - tokensOf({ ...message, images: [] })).toBe(1024)
  })

  it("leave a summary request's output only what its images leave", async () => {
    const snapshot = await assembled(fixture(history([19]), { key: "gpt-4o", context: 3_000 }))
    expect(snapshot.request.messages.some((m) => m.images?.length)).toBe(true)
    const input = snapshot.request.messages.reduce((n, m) => n + tokensOf(m), 0)
    expect(input).toBeGreaterThan(765)
    const fitted = await Effect.runPromise(fitSummaryOutput(snapshot))
    expect(fitted.request.samplers.max_tokens).toBe(Math.min(snapshot.request.samplers.max_tokens, 3_000 - input))
    expect(fitted.request.samplers.max_tokens).toBeLessThan(3_000 - (input - 765))
  })
})

// Images in the context budget (ARCHITECTURE §15): an image's estimate counts with its
// message's text, so an expensive image moves the history's start, and images past the
// model's last-N limit count nothing. In-memory fixtures; synthetic cards.
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import type { CardDoc } from "@rp/shared/docs/card.ts"
import { importCard } from "../src/formats/cardImport.ts"
import { importStPreset } from "../src/formats/preset.ts"
import { tokensOf } from "../src/assembler/st.ts"
import { defaultLeafPlanner, slotCost } from "../src/lcm/planning.ts"
import type { LcmSlot } from "../src/db/lcmPath.ts"
import { prefixChange } from "../src/assembler/warmth.ts"
import { wireContext, markWireSources, sentWire, chatCompletionsFields } from "../src/assembler/wire.ts"
import { createHash } from "node:crypto"
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
  it("counts the images dispatch sends when Newest message is placed before History", async () => {
    const f = fixture(history([3, 19]), { maxImages: 1 })
    const snapshot = await assembled({
      ...f,
      preset: {
        ...f.preset!,
        order: f.preset!.order.flatMap((entry) =>
          entry.identifier === "chatHistory" ? [{ identifier: "newestMessage", enabled: true }, entry] : [entry]
        )
      }
    })
    const images = snapshot.request.messages.flatMap((message) => message.images ?? [])
    expect(images.map((image) => [image.mediaId, image.estimate?.sent !== false])).toEqual([
      ["media-19", false],
      ["media-3", true]
    ])
  })

  it("keeps the newest turn when its image is left out by the final request's limit", async () => {
    const f = fixture(
      [
        { side: "user", content: "Earlier drawing", images: [{ ...image(0), width: 1, height: 1 }] },
        { side: "user", content: "Newest drawing", images: [image(1)] }
      ],
      { key: "gpt-4o-mini", maxImages: 1 }
    )
    const snapshot = await assembled({
      ...f,
      preset: {
        ...f.preset!,
        order: f.preset!.order.flatMap((entry) =>
          entry.identifier === "chatHistory" ? [{ identifier: "newestMessage", enabled: true }, entry] : [entry]
        )
      }
    })
    expect(snapshot.request.messages.some((message) => message.content.includes("Newest drawing"))).toBe(true)
    expect(snapshot.request.messages.flatMap((message) => message.images ?? []).map((image) => image.estimate)).toEqual(
      [expect.objectContaining({ tokens: 25501, sent: false }), expect.objectContaining({ tokens: 8500 })]
    )
  })

  it("fails explicitly when the newest image cannot fit the history target", async () => {
    await expect(assembled(fixture(history([19]), { key: "gpt-4o-mini" }))).rejects.toMatchObject({
      reason: "budget",
      message: expect.stringMatching(/image.*25,?501.*limit/i)
    })
  })

  it("allows a preset to omit history deliberately without calling it a budget failure", async () => {
    const f = fixture(history([19]), { key: "gpt-4o-mini" })
    const snapshot = await assembled({
      ...f,
      preset: {
        ...f.preset!,
        order: f.preset!.order.map((entry) =>
          entry.identifier === "chatHistory" ? { ...entry, enabled: false } : entry
        )
      }
    })
    expect(snapshot.request.messages.some((message) => message.images?.length)).toBe(false)
  })

  it("fails explicitly rather than dropping oversized newest text", async () => {
    await expect(assembled(fixture([{ side: "user", content: "x".repeat(100_000) }], {}))).rejects.toMatchObject({
      reason: "budget",
      message: expect.stringMatching(/newest message/i)
    })
  })

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

  it("rejects an oversized summary chunk instead of summarizing after dropping its images", async () => {
    await expect(
      Effect.runPromise(assembleFixture(fixture(history([19]), { key: "gpt-4o-mini" }), { summarizing: true }))
    ).rejects.toMatchObject({
      reason: "budget",
      message: expect.stringMatching(/summary chunk.*images need about 25,501/i)
    })
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

describe("images in cache estimates", () => {
  it("detects earlier image removal in a captured request and counts the uncached images", async () => {
    const bytes = Buffer.from("synthetic image bytes")
    const oldImage = { ...image(3), sha256: createHash("sha256").update(bytes).digest("hex") }
    const messages = history([]).map((message, i) => (i === 3 ? { ...message, images: [oldImage] } : message))
    const last = await assembled(fixture(messages, {}))
    const hydrated = {
      ...last.request,
      messages: last.request.messages.map((message) => ({
        ...message,
        images: (message.images ?? []).map((image) => ({
          ...image,
          data: bytes.toString("base64"),
          mimeType: "image/png"
        }))
      }))
    }
    const payload = chatCompletionsFields(hydrated, "openai-chat", "gpt-4o")
    const sources = wireContext(last.request, last.inputs.model!)
    markWireSources(payload, sources)
    const wire = sentWire(payload, sources)
    assertNoImageData(wire, bytes.toString("base64"))
    const captured = { ...last, wire }
    expect(prefixChange(captured, last, () => ({ label: "Message" }))).toBeNull()
    const next = await assembled(fixture(history([]), {}))
    expect(prefixChange(captured, next, () => ({ label: "Message" }))).toMatchObject({
      reason: expect.stringMatching(/image/i),
      tokens: expect.any(Number)
    })
  })

  it.each(["anthropic-messages", "google-generative-ai", "openai-responses"])(
    "preserves image identity through %s capture",
    async (api) => {
      const bytes = Buffer.from("synthetic image")
      const sha256 = createHash("sha256").update(bytes).digest("hex")
      const fields = api === "google-generative-ai" ? { api, kind: "google", key: "gemini-3-pro-preview" } : { api }
      const last = await assembled(
        fixture([{ side: "user", content: "Look", images: [{ ...image(0), sha256 }] }], fields)
      )
      const sources = wireContext(last.request, last.inputs.model!)
      const messages = sources.messages.map((message) => {
        const images = message.inputs.flatMap((i) => last.request.messages[i]?.images ?? [])
        const parts = [
          { type: "text", text: message.content },
          ...images.map(() =>
            api === "anthropic-messages"
              ? { type: "image", source: { type: "base64", data: bytes.toString("base64"), media_type: "image/png" } }
              : api === "google-generative-ai"
                ? { inlineData: { data: bytes.toString("base64"), mimeType: "image/png" } }
                : {
                    type: "input_image",
                    image_url: `data:image/png;base64,${bytes.toString("base64")}`,
                    detail: "auto"
                  }
          )
        ]
        return { role: message.role, ...(api === "google-generative-ai" ? { parts } : { content: parts }) }
      })
      const payload =
        api === "google-generative-ai"
          ? { contents: messages }
          : api === "openai-responses"
            ? { input: messages }
            : { messages }
      markWireSources(payload, sources)
      const wire = sentWire(payload, sources)
      assertNoImageData(wire, bytes.toString("base64"))
      expect(prefixChange({ ...last, wire }, last, () => ({ label: "Message" }))).toBeNull()
      const changed = await assembled(fixture([{ side: "user", content: "Look" }], fields))
      expect(prefixChange({ ...last, wire }, changed, () => ({ label: "Message" }))).not.toBeNull()
    }
  )
})
const assertNoImageData = (wire: unknown, base64: string) => {
  expect(JSON.stringify(wire)).not.toContain(base64)
  expect(JSON.stringify(wire)).not.toContain('"images"')
}

it("leaf planning counts image tokens even when the text would fit the recent window", () => {
  const raw = Array.from({ length: 4 }, (_, i) => ({
    id: `slot-${i}` as LcmSlot["id"],
    parent: null,
    depth: i,
    versionId: `version-${i}` as LcmSlot["versionId"],
    amendCount: 0,
    generating: 0,
    merged: 0,
    children: 1,
    content: "Look",
    images: [{ mediaId: `image-${i}`, estimate: { tokens: 765, basis: "formula" as const } }]
  })) satisfies LcmSlot[]
  const input = {
    raw,
    recent: { target: 1000, maximum: 2000 },
    leafInput: 700,
    target: 100,
    covered: new Set<string>(),
    held: new Set<string>(),
    limit: 10
  }
  expect(slotCost(raw[0]!)).toBe(769)
  expect(defaultLeafPlanner.plan(input).map((chunk) => chunk.inputs.length)).toEqual([1, 1])
  expect(defaultLeafPlanner.plan({ ...input, raw: raw.map((slot) => ({ ...slot, images: [] })) })).toEqual([])
})

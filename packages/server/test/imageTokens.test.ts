// Image token formulas against the providers' documented examples (read 2026-10-30), the
// header sizes they work from, the counting endpoints (mocked: no network), and calibration.
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import {
  anthropicImageTokens,
  anthropicResize,
  anthropicTier,
  builtinImageTokenRules,
  calibratedTokens,
  geminiImageTokens,
  mistralImageTokens,
  openAIImageTokens,
  openAIPatchTokens,
  ruleEstimate
} from "@rp/shared/imageTokens.ts"
import { describeImage } from "../src/importer/images.ts"
import { builtinImageCounters } from "../src/providers/imageCounters.ts"
import { imageSample, payloadImages, reportedImageTokens } from "../src/providers/imageSamples.ts"
import { estimateImage } from "../src/assembler/imageTokens.ts"
import { wireDigest } from "../src/assembler/wire.ts"
import { tokensOf } from "../src/assembler/st.ts"

const size = (width: number, height: number) => ({ width, height })

describe("Anthropic's patch formula", () => {
  // https://platform.claude.com/docs/en/build-with-claude/vision, "Resolution and token cost".
  const table: ReadonlyArray<[number, number, number, number]> = [
    [200, 200, 64, 64],
    [1000, 1000, 1296, 1296],
    [1092, 1092, 1521, 1521],
    [1920, 1080, 1560, 2691],
    [2000, 1500, 1564, 3888],
    [3840, 2160, 1560, 4784]
  ]
  it("matches the documented table on both tiers", () => {
    for (const [w, h, standard, high] of table) {
      assert.strictEqual(anthropicImageTokens(size(w, h), "claude-haiku-4-5"), standard, `${w}x${h} standard`)
      assert.strictEqual(anthropicImageTokens(size(w, h), "claude-opus-5-5"), high, `${w}x${h} high`)
    }
  })
  it("resizes as the reference implementation does", () => {
    assert.deepStrictEqual(anthropicResize(1920, 1080, 1568, 1568), [1456, 819])
    // The table says 1269×952; the reference implementation gives 1270×952. Both cost 46×34 = 1,564.
    assert.deepStrictEqual(anthropicResize(2000, 1500, 1568, 1568), [1270, 952])
    assert.deepStrictEqual(anthropicResize(3840, 2160, 2576, 4784), [2576, 1449])
    // The A4 scan: resized on the standard tier, not on the high-resolution one (2,145 tokens).
    assert.deepStrictEqual(anthropicResize(1075, 1520, 1568, 1568), [924, 1307])
    assert.strictEqual(anthropicImageTokens(size(1075, 1520), "claude-opus-4-7"), 2145)
  })
  it("puts Claude 4.7 and later on the high-resolution tier", () => {
    const tier = (model: string) => anthropicTier(model).tier
    assert.strictEqual(tier("claude-3-5-sonnet-20241022"), "standard")
    assert.strictEqual(tier("claude-sonnet-4-20250514"), "standard")
    assert.strictEqual(tier("claude-opus-4-1-20250805"), "standard")
    assert.strictEqual(tier("claude-haiku-4-5"), "standard")
    assert.strictEqual(tier("claude-opus-4-7"), "high")
    assert.strictEqual(tier("anthropic/claude-opus-4.7"), "high")
    assert.strictEqual(tier("claude-fable-5-1"), "high")
  })
})

describe("OpenAI's formulas", () => {
  // https://developers.openai.com/api/docs/guides/images-vision, "Calculating costs".
  it("counts tiles for tile models, base tokens alone at low detail", () => {
    assert.strictEqual(openAIImageTokens(size(1024, 1024), "gpt-4o")?.tokens, 765)
    assert.strictEqual(openAIImageTokens(size(2048, 4096), "gpt-4o")?.tokens, 1105)
    assert.strictEqual(openAIImageTokens(size(4096, 4096), "gpt-4.1", "low")?.tokens, 85)
    assert.strictEqual(openAIImageTokens(size(1024, 1024), "gpt-4o-mini")?.tokens, 2833 + 4 * 5667)
    assert.strictEqual(openAIImageTokens(size(1024, 1024), "gpt-5.1")?.tokens, 70 + 4 * 140)
    assert.strictEqual(openAIImageTokens(size(512, 512), "o3")?.tokens, 75 + 150)
  })
  it("counts patches for patch models: the documented gpt-6-astra examples at high detail", () => {
    assert.strictEqual(openAIImageTokens(size(1024, 1024), "gpt-6-astra", "high")?.tokens, 1229)
    assert.strictEqual(openAIImageTokens(size(2048, 2048), "gpt-6-astra", "high")?.tokens, 3000)
    assert.strictEqual(openAIImageTokens(size(4096, 512), "gpt-6-astra", "high")?.tokens, 2458)
    // The budget step's own example: 2048×2048 shrinks to 1600×1600, 2,500 patches.
    assert.strictEqual(openAIPatchTokens(size(2048, 2048), { maxDimension: 65535, budget: 2500 }, 1), 2500)
  })
  it("sizes `auto`, which we send, per model", () => {
    // gpt-6-astra's auto is original: no resize, so 2048×2048 is 4,096 patches.
    assert.strictEqual(openAIImageTokens(size(2048, 2048), "gpt-6-astra")?.tokens, Math.ceil(4096 * 1.2))
    // gpt-5.4's auto is high: the 2,500-patch budget.
    assert.strictEqual(openAIImageTokens(size(2048, 2048), "gpt-5.4-mini")?.tokens, 3000)
    // gpt-4.1-mini: 6,144 patches within 2048 px, multiplier 1.62.
    assert.strictEqual(openAIImageTokens(size(1024, 1024), "gpt-4.1-mini")?.tokens, Math.ceil(1024 * 1.62))
    assert.isNull(openAIImageTokens(size(1024, 1024), "llava-1.6"))
    // No published sizing row: never label an invented sizing assumption as a formula.
    assert.isNull(openAIImageTokens(size(1024, 1024), "gpt-5-mini"))
    assert.isNull(openAIImageTokens(size(1024, 1024), "o4-mini"))
  })
})

describe("Gemini and Mistral", () => {
  // https://ai.google.dev/gemini-api/docs/tokens; https://ai.google.dev/gemini-api/docs/media-resolution
  it("tiles before Gemini 3 and bills a fixed figure from Gemini 3", () => {
    assert.strictEqual(geminiImageTokens(size(384, 384), "gemini-2.5-flash")!.tokens, 258)
    // Google's example: 960×540, crop unit 360, 3×2 tiles.
    assert.strictEqual(geminiImageTokens(size(960, 540), "gemini-2.5-pro")!.tokens, 6 * 258)
    assert.strictEqual(geminiImageTokens(size(4000, 3000), "gemini-3-pro-preview")!.tokens, 1120)
  })
  // https://docs.mistral.ai/studio/conversations/vision
  it("uses Mistral's approximate per-pixel figures", () => {
    assert.strictEqual(mistralImageTokens(size(1540, 1540), "mistral-medium-latest").tokens, 3025)
    assert.strictEqual(mistralImageTokens(size(2048, 2048), "pixtral-12b").tokens, 4096)
  })
})

describe("the built-in rules", () => {
  const rule = (kind: string, model: string, w = 1024, h = 1024) =>
    ruleEstimate(builtinImageTokenRules, size(w, h), { kind, api: "openai-completions", model })
  it("route a router's model to its upstream's formula", () => {
    assert.strictEqual(rule("openrouter", "openai/gpt-4o")?.tokens, 765)
    assert.strictEqual(rule("openrouter", "anthropic/claude-sonnet-4.5", 1000, 1000)?.tokens, 1296)
    assert.strictEqual(rule("openrouter", "google/gemini-2.5-flash", 384, 384)?.tokens, 258)
    assert.isNull(rule("openrouter", "meta-llama/llama-3.2-11b-vision-instruct"))
    assert.isNull(rule("openai-chat", "qwen2.5-vl-7b"))
    assert.isNull(rule("google", "gemini-latest", 384, 384))
    assert.isNull(rule("google", "gemma-3", 384, 384))
  })
  it("give DeepSeek's cap as a bound, not a figure", () => {
    const deepseek = rule("deepseek", "deepseek-flash")
    assert.deepInclude(deepseek, { tokens: null, bound: 1024 })
  })
  it("prefer a newer rule, as a plugin's would be", () => {
    const plugin = { id: "mine", appliesTo: () => true, estimate: () => ({ tokens: 7 }) }
    const got = ruleEstimate([...builtinImageTokenRules, plugin], size(10, 10), {
      kind: "anthropic",
      api: "anthropic-messages",
      model: "claude-opus-4-7"
    })
    assert.strictEqual(got?.tokens, 7)
  })
})

describe("an image's estimate", () => {
  const target = { kind: "openai-chat", api: "openai-completions", model: "local-vision" }
  const image = { mediaId: "m", sha256: "a".repeat(64), width: 1000, height: 500 }
  it("is a count first, then a formula, then calibration, else unknown and never zero", () => {
    const facts = { counts: [{ sha256: image.sha256, detail: "auto", tokens: 812 }], samples: [] }
    assert.deepInclude(estimateImage(image, target, builtinImageTokenRules, facts), { tokens: 812, basis: "counted" })
    const none = { counts: [], samples: [] }
    const unknown = estimateImage(image, target, builtinImageTokenRules, none)
    assert.deepInclude(unknown, { tokens: null, basis: "unknown" })
    assert.include(unknown.note, "first request with an image")
    const calibrated = estimateImage(image, target, builtinImageTokenRules, {
      counts: [],
      samples: [{ images: 1, pixels: 1000 * 500, tokens: 576 }]
    })
    assert.deepInclude(calibrated, { tokens: 576, basis: "calibrated" })
    const formula = estimateImage(image, { ...target, model: "gpt-4o" }, builtinImageTokenRules, none)
    assert.deepInclude(formula, { basis: "formula", detail: "auto" })
    // The budget counts an unknown image at the reserve, and an unsent one not at all.
    assert.strictEqual(tokensOf({ content: "", images: [{ estimate: unknown }] }), 1024)
    assert.strictEqual(tokensOf({ content: "", images: [{ estimate: { ...formula, sent: false } }] }), 0)
  })
  it("calibrates per pixel when the samples' sizes differ", () => {
    // 100 tokens plus one per 1,000 pixels.
    const samples = [
      { images: 1, pixels: 100_000, tokens: 200 },
      { images: 2, pixels: 600_000, tokens: 800 }
    ]
    assert.strictEqual(calibratedTokens(samples, size(1000, 1000)), 1100)
    assert.strictEqual(calibratedTokens([{ images: 2, pixels: 0, tokens: 1152 }], size(10, 10)), 576)
  })
})

describe("image sizes from headers", () => {
  it("reads JPEG, GIF, WebP, BMP and AVIF sizes", () => {
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x1c, 0x03, 0x20, 0x03
    ])
    assert.deepInclude(describeImage(jpeg), { mime: "image/jpeg", width: 800, height: 540 })
    const gif = Buffer.from([...Buffer.from("GIF89a"), 0x40, 0x01, 0xf0, 0x00, 0, 0, 0, 0])
    assert.deepInclude(describeImage(gif), { mime: "image/gif", width: 320, height: 240 })
    const webp = Buffer.alloc(32)
    webp.write("RIFF", 0, "latin1")
    webp.write("WEBP", 8, "latin1")
    webp.write("VP8X", 12, "latin1")
    webp.writeUIntLE(1919, 24, 3)
    webp.writeUIntLE(1079, 27, 3)
    assert.deepInclude(describeImage(webp), { mime: "image/webp", width: 1920, height: 1080 })
    const lossless = Buffer.alloc(32)
    lossless.write("RIFF", 0, "latin1")
    lossless.write("WEBP", 8, "latin1")
    lossless.write("VP8L", 12, "latin1")
    lossless[20] = 0x2f
    lossless.writeUInt32LE((99 & 0x3fff) | ((49 & 0x3fff) << 14), 21)
    assert.deepInclude(describeImage(lossless), { width: 100, height: 50 })
    const bmp = Buffer.alloc(30)
    bmp.write("BM", 0, "latin1")
    bmp.writeInt32LE(640, 18)
    bmp.writeInt32LE(-480, 22)
    assert.deepInclude(describeImage(bmp), { mime: "image/bmp", width: 640, height: 480 })
    const avif = Buffer.alloc(64)
    avif.write("ftypavif", 4, "latin1")
    avif.write("ispe", 36, "latin1")
    avif.writeUInt32BE(1024, 44)
    avif.writeUInt32BE(768, 48)
    assert.deepInclude(describeImage(avif), { mime: "image/avif", width: 1024, height: 768 })
    assert.deepInclude(describeImage(Buffer.from([0xff, 0xd8, 0xff])), { width: null, height: null })
  })
})

describe("the counting endpoints", () => {
  const image = { data: Buffer.from("synthetic").toString("base64"), mimeType: "image/png" }
  const fake = (respond: (url: string, body: Record<string, unknown>) => Record<string, unknown>) => {
    const calls: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = []
    const fetch = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      calls.push({ url, body, headers: init.headers as Record<string, string> })
      return new Response(JSON.stringify(respond(url, body)), { status: 200 })
    }) as unknown as typeof globalThis.fetch
    return { fetch, calls }
  }
  const request = (fetch: typeof globalThis.fetch, baseUrl: string, model: string) => ({
    baseUrl,
    apiKey: "sk-synthetic",
    headers: {},
    fetch,
    scrub: (text: string) => text,
    model,
    image,
    detail: "auto"
  })
  const counter = (id: string) => builtinImageCounters.find((c) => c.id === id)!
  const withImage = (body: Record<string, unknown>) => JSON.stringify(body).includes(image.data)

  it.effect("Anthropic: the image is the difference of two counts", () =>
    Effect.gen(function* () {
      const { fetch, calls } = fake((_url, body) => ({ input_tokens: withImage(body) ? 1529 : 8 }))
      const tokens = yield* counter("anthropic-count-tokens").count(
        request(fetch, "https://api.anthropic.com", "claude-opus-4-7")
      )
      assert.strictEqual(tokens, 1521)
      assert.isTrue(calls.every((c) => c.url === "https://api.anthropic.com/v1/messages/count_tokens"))
      assert.strictEqual(calls[0]!.headers["x-api-key"], "sk-synthetic")
    })
  )
  it.effect("Gemini: countTokens with an inline image", () =>
    Effect.gen(function* () {
      const { fetch, calls } = fake((_url, body) => ({ totalTokens: withImage(body) ? 1124 : 4 }))
      const tokens = yield* counter("google-count-tokens").count(
        request(fetch, "https://generativelanguage.googleapis.com/v1beta", "models/gemini-3-pro-preview")
      )
      assert.strictEqual(tokens, 1120)
      assert.include(calls[0]!.url, "/models/gemini-3-pro-preview:countTokens")
    })
  )
  it.effect("OpenAI: Responses input_tokens, only on OpenAI's own API", () =>
    Effect.gen(function* () {
      const { fetch, calls } = fake((_url, body) => ({ input_tokens: withImage(body) ? 772 : 7 }))
      const openai = counter("openai-input-tokens")
      assert.strictEqual(yield* openai.count(request(fetch, "https://api.openai.com/v1", "gpt-4o")), 765)
      assert.strictEqual(calls[0]!.url, "https://api.openai.com/v1/responses/input_tokens")
      assert.include(JSON.stringify(calls[0]!.body), '"detail":"auto"')
      const target = { kind: "openai-chat", api: "openai-completions", model: "gpt-4o" }
      assert.isTrue(openai.appliesTo({ ...target, baseUrl: "https://api.openai.com/v1" }))
      assert.isFalse(openai.appliesTo({ ...target, baseUrl: "http://127.0.0.1:8080/v1" }))
      assert.isFalse(openai.appliesTo({ ...target, kind: "openrouter", baseUrl: "https://openrouter.ai/api/v1" }))
    })
  )
  it.effect("rejects a zero image count instead of storing a silent zero", () =>
    Effect.gen(function* () {
      const { fetch } = fake(() => ({ input_tokens: 8 }))
      const error = yield* Effect.flip(
        counter("anthropic-count-tokens").count(request(fetch, "https://api.anthropic.com", "synthetic"))
      )
      assert.include(error.message, "zero")
    })
  )
  it.effect("a failed count fails, scrubbed", () =>
    Effect.gen(function* () {
      const fetch = (async () =>
        new Response("bad sk-synthetic", { status: 400 })) as unknown as typeof globalThis.fetch
      const error = yield* Effect.flip(
        counter("anthropic-count-tokens").count({
          ...request(fetch, "https://api.anthropic.com", "claude-opus-4-7"),
          scrub: (text) => text.replaceAll("sk-synthetic", "…")
        })
      )
      assert.notInclude(error.message, "sk-synthetic")
    })
  )
})

describe("ledger calibration samples", () => {
  const png = (w: number, h: number) => {
    const bytes = Buffer.alloc(33)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes)
    bytes.write("IHDR", 12, "latin1")
    bytes.writeUInt32BE(w, 16)
    bytes.writeUInt32BE(h, 20)
    return bytes.toString("base64")
  }
  it("reads the sent images from every wire shape", () => {
    const sent = payloadImages({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "a".repeat(40) },
            { type: "image_url", image_url: { url: `data:image/png;base64,${png(100, 50)}` } },
            { type: "image", source: { type: "base64", media_type: "image/png", data: png(10, 10) } }
          ]
        }
      ],
      contents: [{ parts: [{ inlineData: { mimeType: "image/png", data: png(20, 5) } }] }],
      input: [{ content: [{ type: "input_image", image_url: `data:image/png;base64,${png(2, 2)}` }] }]
    })
    assert.strictEqual(sent.images, 4)
    assert.strictEqual(sent.pixels, 5000 + 100 + 100 + 4)
    // Ten tokens of text, three per message of each list.
    assert.strictEqual(sent.text, 10 + 3 * 3)
  })
  it("prefers the provider's own image figure, else derives it from the input count", () => {
    assert.strictEqual(reportedImageTokens({ prompt_tokens_details: { image_tokens: 256 } }), 256)
    assert.strictEqual(
      reportedImageTokens({
        promptTokensDetails: [
          { modality: "TEXT", tokenCount: 9 },
          { modality: "IMAGE", tokenCount: 258 }
        ]
      }),
      258
    )
    const sent = { images: 1, pixels: 4, text: 19 }
    assert.deepStrictEqual(imageSample(sent, 600, { prompt_tokens_details: { image_tokens: 576 } }), {
      images: 1,
      pixels: 4,
      tokens: 576,
      source: "reported"
    })
    assert.deepInclude(imageSample(sent, 600, null), { tokens: 581, source: "derived" })
    assert.isNull(imageSample({ ...sent, pixels: null }, 600, null))
    assert.isNull(imageSample(sent, 10, null))
  })
})

describe("image estimate review regressions", () => {
  it("reserves for images missing their estimate and rejects zero calibration", () => {
    assert.strictEqual(tokensOf({ content: "", images: [{}] }), 1024)
    assert.isNull(calibratedTokens([{ images: 1, pixels: 100, tokens: 0 }], size(10, 10)))
    assert.isNull(
      imageSample({ images: 1, pixels: 100, text: 10 }, 100, { prompt_tokens_details: { image_tokens: 0 } })
    )
  })
  it("keeps narrow image estimates positive and finite", () => {
    assert.isTrue(Number.isFinite(geminiImageTokens(size(1000, 1), "gemini-2.5-pro")!.tokens))
    assert.isAbove(openAIImageTokens(size(1, 100_000), "gpt-5.4")!.tokens!, 0)
  })
  it("includes sent image content and detail in wire digests, independent of media id", () => {
    const text = { role: "user" as const, content: "Look" }
    const image = {
      mediaId: "one",
      sha256: "a".repeat(64),
      estimate: { tokens: 10, basis: "formula" as const, detail: "auto" }
    }
    const digest = (images: (typeof image)[]) => wireDigest({ ...text, images })
    assert.notStrictEqual(digest([image]), digest([]))
    assert.notStrictEqual(digest([image]), digest([{ ...image, sha256: "b".repeat(64) }]))
    assert.notStrictEqual(digest([image]), digest([{ ...image, estimate: { ...image.estimate, detail: "low" } }]))
    assert.strictEqual(digest([image]), digest([{ ...image, mediaId: "another" }]))
  })
})

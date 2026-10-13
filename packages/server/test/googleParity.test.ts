// Compare the real HTTP boundary with the pinned pi-ai + genai implementation.
import { assert, it } from "@effect/vitest"
import type { Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai"
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript"
import { streamSimple as upstream } from "@earendil-works/pi-ai/api/google-generative-ai"
import { streamSimple } from "../src/providers/google.ts"
import { classify } from "../src/providers/errors.ts"
import { startMockProvider } from "./support/mockProvider.ts"

const model: Model<"google-generative-ai"> = {
  id: "gemini-2.5-flash-lite",
  name: "Synthetic",
  api: "google-generative-ai",
  provider: "google",
  baseUrl: "",
  reasoning: true,
  input: ["text"],
  contextWindow: 100000,
  maxTokens: 1024,
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 }
}
const context: Context = { messages: [{ role: "user", content: "Synthetic input", timestamp: 0 }] }
const stop = { candidates: [{ content: { parts: [{ text: "Synthetic answer ☃" }] }, finishReason: "STOP" }] }
const wire = (value: unknown, delimiter = "\n") => `data: ${JSON.stringify(value)}${delimiter}${delimiter}`
const compare = async (body: string, options: SimpleStreamOptions = {}, id = model.id, ctx = context) => {
  const mock = await startMockProvider(async (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" })
    if (body.startsWith("{")) {
      res.end(body)
      return
    }
    const bytes = Buffer.from(body)
    // Flush each byte so split CRLF and multibyte UTF-8 exercise the incremental parser.
    for (const byte of bytes) {
      res.write(Buffer.from([byte]))
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    res.end()
  })
  try {
    const results = []
    for (const adapter of [upstream, streamSimple]) {
      const before = mock.requests().length
      const events = adapter({ ...model, id, baseUrl: mock.url + "/v1beta" }, normalizeContext(ctx), {
        apiKey: "synthetic-parity-key",
        maxRetries: 0,
        ...options,
        ...(adapter === streamSimple ? { fetch } : {})
      })
      const types = []
      for await (const event of events) types.push(event.type)
      const result = await events.result()
      results.push({
        result,
        request: mock.requests()[before],
        classification: classify(
          result,
          {
            status: 200,
            retryAfterMs: null,
            category: null
          },
          undefined,
          types.includes("text_delta")
        )
      })
    }
    return { sdk: results[0]!, app: results[1]! }
  } finally {
    await mock.close()
  }
}

for (const [name, body, detail] of [
  ["empty EOF", "", "ended without a finish reason"],
  [
    "raw JSON error",
    JSON.stringify({ error: { code: 503, status: "UNAVAILABLE", message: "Synthetic overloaded model" } }),
    "Synthetic overloaded model"
  ],
  [
    "SSE error",
    wire({ error: { code: 503, status: "UNAVAILABLE", message: "Synthetic overloaded model" } }),
    "Synthetic overloaded model"
  ],
  [
    "raw nonretryable error",
    JSON.stringify({ error: { code: 400, status: "INVALID_ARGUMENT", message: "Synthetic invalid field" } }),
    "Synthetic invalid field"
  ]
])
  it(`Google ${name} preserves details and pi-ai retry classification`, async () => {
    const { sdk, app } = await compare(body!)
    assert.equal(app.result.stopReason, "error")
    assert.include(app.result.errorMessage!, detail!)
    assert.equal(app.classification?.reason, sdk.classification?.reason)
  })

for (const delimiter of ["\n", "\r\n", "\r"])
  it(`Google streams fragmented ${JSON.stringify(delimiter)} records`, async () => {
    const { sdk, app } = await compare(
      wire({ candidates: [{ content: { parts: [{ text: "First" }] } }] }, delimiter) + wire(stop, delimiter)
    )
    assert.equal(app.result.stopReason, "stop")
    assert.deepEqual(JSON.parse(JSON.stringify(app.result.content)), JSON.parse(JSON.stringify(sdk.result.content)))
  })

for (const [name, config, id] of [
  ["service tier", { serviceTier: "flex" }, model.id],
  [
    "SDK generation fields",
    {
      temperature: 0.2,
      topP: 0.9,
      topK: 20,
      candidateCount: 1,
      maxOutputTokens: 512,
      stopSequences: ["END"],
      responseLogprobs: true,
      logprobs: 2,
      presencePenalty: 0.1,
      frequencyPenalty: 0.2,
      seed: 123,
      responseMimeType: "application/json",
      responseJsonSchema: { type: "object", properties: { answer: { type: "string" } } }
    },
    model.id
  ],
  ["speech shorthand", { speechConfig: "Kore" }, model.id],
  ["system parts", { systemInstruction: [{ text: "Synthetic" }, { text: "system" }] }, model.id],
  [
    "tools and safety",
    {
      tools: [{ functionDeclarations: [{ name: "lookup", parametersJsonSchema: { type: "object", properties: {} } }] }],
      toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["lookup"] } },
      safetySettings: [{ category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" }]
    },
    model.id
  ],
  ["short cached content", { cachedContent: "synthetic-123" }, model.id],
  ["qualified cached content", { cachedContent: "cachedContents/synthetic-123" }, model.id],
  ["tuned model", {}, "tunedModels/synthetic-123"],
  ["qualified model", {}, "models/gemini-2.5-flash"],
  ["system instruction", { systemInstruction: "Synthetic system" }, model.id]
] as const)
  it(`Google maps SDK ${name} to the same REST request`, async () => {
    const { sdk, app } = await compare(
      wire(stop),
      {
        onPayload: (p) => {
          const params = p as { config: Record<string, unknown> }
          return { ...params, config: { ...params.config, ...config } }
        }
      },
      id
    )
    assert.equal(app.result.stopReason, "stop")
    assert.equal(app.request!.path, sdk.request!.path)
    assert.deepEqual(app.request!.body, sdk.request!.body)
  })

it("Google exposes the request signal in the SDK-shaped payload hook", async () => {
  const signal = new AbortController().signal
  const seen: unknown[] = []
  await compare(wire(stop), {
    signal,
    onPayload: (p) => {
      seen.push((p as { config: { abortSignal?: unknown } }).config.abortSignal)
    }
  })
  assert.deepEqual(seen, [signal, signal])
})

for (const id of ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite"])
  for (const reasoning of ["minimal", "low", "medium", "high"] as const)
    for (const custom of [false, true])
      it(`Google ${id} ${reasoning} ${custom ? "custom" : "default"} budget matches pi-ai`, async () => {
        const { sdk, app } = await compare(
          wire(stop),
          { reasoning, ...(custom ? { thinkingBudgets: { [reasoning]: 3072 } } : {}) },
          id
        )
        assert.deepEqual(app.request!.body, sdk.request!.body)
      })

for (const config of [
  { labels: { synthetic: "yes" } },
  { routingConfig: {} },
  { imageConfig: { outputMimeType: "image/png" } },
  { toolConfig: { functionCallingConfig: { streamFunctionCallArguments: true } } }
])
  it(`Google rejects SDK options unsupported by Developer REST: ${JSON.stringify(config)}`, async () => {
    const { sdk, app } = await compare(wire(stop), {
      onPayload: (p) => {
        const params = p as { config: Record<string, unknown> }
        return { ...params, config: { ...params.config, ...config } }
      }
    })
    assert.equal(sdk.result.stopReason, "error")
    assert.equal(app.result.stopReason, "error")
    assert.isUndefined(app.request)
    assert.include(app.result.errorMessage!, "Unsupported Google")
  })
it("Google rejects unknown config fields rather than sending them as generation parameters", async () => {
  const { app } = await compare(wire(stop), {
    onPayload: (p) => {
      const params = p as { config: Record<string, unknown> }
      return { ...params, config: { ...params.config, syntheticUnknown: true } }
    }
  })
  assert.isUndefined(app.request)
  assert.include(app.result.errorMessage!, "Unsupported Google config.syntheticUnknown")
})

for (const id of ["../escape", "models/%2e%2e/escape", "https://example.invalid/model", "models/test?key=other"])
  it(`Google rejects model paths that could alter routing: ${id}`, async () => {
    const mock = await startMockProvider((_req, res) => {
      res.end(wire(stop))
    })
    try {
      const events = streamSimple({ ...model, baseUrl: mock.url }, normalizeContext(context), {
        apiKey: "synthetic-key",
        fetch,
        onPayload: (p) => ({ ...(p as Record<string, unknown>), model: id })
      })
      const result = await events.result()
      assert.equal(result.stopReason, "error")
      assert.include(result.errorMessage!, "Invalid Google model resource name")
      assert.equal(mock.requests().length, 0)
    } finally {
      await mock.close()
    }
  })

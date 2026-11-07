// Claude on AWS Bedrock (providers/bedrock.ts) against recorded shapes: AWS's SigV4 test vector
// and signatures cross-checked with AWS's own signer, the event-stream framing, and a reply
// through a mock Bedrock endpoint (the address, body, both kinds of auth, the no-lookback cache
// markers, usage and errors). Nothing here has reached a real Bedrock account.
import { assert, describe, it } from "@effect/vitest"
import type { ServerResponse } from "node:http"
import { Effect } from "effect"
import { encodeEventStreamMessage, eventStreamMessages, parseAwsKey, signV4 } from "../src/providers/bedrock.ts"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { anthropicSse, startMockProvider, type Handler, type Recorded } from "./support/mockProvider.ts"

const resource = (handler: Handler) =>
  Effect.acquireRelease(
    Effect.promise(() => startMockProvider(handler)),
    (m) => Effect.promise(() => m.close())
  )

const exampleKey = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" }
const MODEL = "us.anthropic.claude-haiku-4-5-20251001-v1:0"

describe("SigV4", () => {
  it("signs AWS's get-vanilla test case", () => {
    const signed = signV4({
      method: "GET",
      url: new URL("https://example.amazonaws.com/"),
      headers: {},
      body: "",
      credentials: exampleKey,
      region: "us-east-1",
      service: "service",
      now: new Date("2015-08-30T12:36:00Z")
    })
    assert.strictEqual(
      signed.authorization,
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31"
    )
    assert.strictEqual(signed["x-amz-date"], "20150830T123600Z")
    assert.notProperty(signed, "host")
  })

  // Values from @smithy/signature-v4 (the AWS SDK's signer) for the same requests.
  const bedrockRequest = (sessionToken?: string, region = "us-west-2", model = MODEL) =>
    signV4({
      method: "POST",
      url: new URL(
        `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(model)}/invoke-with-response-stream`
      ),
      headers: { "content-type": "application/json", accept: "application/vnd.amazon.eventstream" },
      body: JSON.stringify({
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 10,
        messages: [{ role: "user", content: "Hi" }]
      }),
      credentials: { ...exampleKey, ...(sessionToken ? { sessionToken } : {}) },
      region,
      service: "bedrock",
      now: new Date("2026-11-07T12:34:56Z")
    })

  it("signs a Bedrock request as AWS's signer does, the model ID's colon encoded twice", () => {
    assert.strictEqual(
      bedrockRequest().authorization,
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261107/us-west-2/bedrock/aws4_request, SignedHeaders=accept;content-type;host;x-amz-date, Signature=c31b186ff0256d55db47b261e6a9df8319c295fc9d7ca6e356294391f8f9d6c6"
    )
  })

  it("signs a temporary key's session token", () => {
    const signed = bedrockRequest(
      "FQoGZXIvYXdzEXAMPLETOKEN",
      "eu-central-1",
      "anthropic.claude-sonnet-4-5-20250929-v1:0"
    )
    assert.strictEqual(signed["x-amz-security-token"], "FQoGZXIvYXdzEXAMPLETOKEN")
    assert.strictEqual(
      signed.authorization,
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261107/eu-central-1/bedrock/aws4_request, SignedHeaders=accept;content-type;host;x-amz-date;x-amz-security-token, Signature=8936291c09b854c6fd41b32787d88766ca40fdb6a38965c2628f9365ff90ca7b"
    )
  })

  it("reads an access key as ID:SECRET, optionally :SESSION_TOKEN", () => {
    assert.deepEqual(parseAwsKey(" AKID:secret "), { accessKeyId: "AKID", secretAccessKey: "secret" })
    assert.deepEqual(parseAwsKey("AKID:secret:token"), {
      accessKeyId: "AKID",
      secretAccessKey: "secret",
      sessionToken: "token"
    })
    assert.isNull(parseAwsKey("just-a-bedrock-api-key"))
    assert.isNull(parseAwsKey("a:b:c:d"))
  })
})

const chunks = async function* (bytes: Uint8Array, size: number) {
  for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, at + size)
}

const collect = async (body: AsyncIterable<Uint8Array>) => {
  const out: Array<{ headers: Record<string, unknown>; payload: string }> = []
  for await (const message of eventStreamMessages(body))
    out.push({ headers: { ...message.headers }, payload: new TextDecoder().decode(message.payload) })
  return out
}

describe("AWS event streams", () => {
  const frames = [
    encodeEventStreamMessage({ ":event-type": "chunk", ":message-type": "event" }, new TextEncoder().encode('{"a":1}')),
    encodeEventStreamMessage({ ":event-type": "chunk", ":message-type": "event" }, new TextEncoder().encode('{"b":2}'))
  ]
  const joined = new Uint8Array(frames[0]!.length + frames[1]!.length)
  joined.set(frames[0]!)
  joined.set(frames[1]!, frames[0]!.length)

  it("reads messages across any chunk boundary", async () => {
    for (const size of [1, 7, 13, joined.length]) {
      const messages = await collect(chunks(joined, size))
      assert.deepEqual(
        messages.map((m) => [m.headers[":event-type"], m.payload]),
        [
          ["chunk", '{"a":1}'],
          ["chunk", '{"b":2}']
        ],
        `chunks of ${size}`
      )
    }
  })

  it("refuses a corrupted or cut-off stream", async () => {
    const corrupted = joined.slice()
    corrupted[20] = corrupted[20]! ^ 0xff
    await assertRejects(collect(chunks(corrupted, 64)), /checksum/)
    await assertRejects(collect(chunks(joined.subarray(0, joined.length - 3), 64)), /mid-message/)
  })
})

const assertRejects = async (promise: Promise<unknown>, pattern: RegExp) => {
  const error = await promise.then(
    () => null,
    (e: unknown) => e
  )
  assert.match(String(error), pattern)
}

// --- A mock Bedrock endpoint -----------------------------------------------------------------

const anthropicEvents = (usage: Record<string, number>) => [
  {
    type: "message_start",
    message: {
      id: "msg_bdrk_1",
      type: "message",
      role: "assistant",
      model: "claude-haiku-4-5-20251001",
      content: [],
      usage: { input_tokens: 12, output_tokens: 1, ...usage }
    }
  },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "The tide is out." } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
  { type: "message_stop", "amazon-bedrock-invocationMetrics": { inputTokenCount: 12, outputTokenCount: 5 } }
]

const bedrockStream = (res: ServerResponse, events: ReadonlyArray<unknown>) => {
  res.writeHead(200, { "content-type": "application/vnd.amazon.eventstream", "x-amzn-requestid": "req-synthetic-1" })
  for (const event of events) {
    const bytes = Buffer.from(JSON.stringify(event)).toString("base64")
    const payload = new TextEncoder().encode(JSON.stringify({ bytes, p: "abcd" }))
    res.write(
      encodeEventStreamMessage(
        { ":event-type": "chunk", ":content-type": "application/json", ":message-type": "event" },
        payload
      )
    )
  }
  res.end()
}

const bedrockReply =
  (usage: Record<string, number> = {}): Handler =>
  (req, res) => {
    if (req.path.includes("/invoke-with-response-stream")) return bedrockStream(res, anthropicEvents(usage))
    res.writeHead(404, { "content-type": "application/json" })
    res.end("{}")
  }

const header = (req: Recorded, name: string) => {
  const value = req.headers[name]
  return Array.isArray(value) ? value.join(",") : value
}

type WireMessage = { role: string; content: unknown }
const markedAt = (messages: ReadonlyArray<WireMessage>) =>
  messages.flatMap((m, i) => (JSON.stringify(m.content).includes("cache_control") ? [i] : []))

describe("a reply through Bedrock", () => {
  it.live("sends no SDK cache markers when the connection chooses None", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* resource(bedrockReply())
      const api = yield* client()
      const { version } = yield* generateReply(api, {
        connection: {
          provider: "anthropic-bedrock",
          kind: "anthropic-bedrock",
          baseUrl: mock.url,
          apiKey: "synthetic-key",
          providerSettings: { cacheBreakpoints: "none" }
        },
        modelKey: MODEL,
        model: {}
      })
      assert.strictEqual(version.status, "complete", JSON.stringify(version.error))
      assert.notInclude(JSON.stringify(mock.requests().at(-1)!.body), "cache_control")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
  it.live("goes to the model's invoke address with the Messages body Bedrock takes and a Bedrock API key", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* resource(bedrockReply({ cache_read_input_tokens: 40, cache_creation_input_tokens: 8 }))
      const api = yield* client()
      const { version } = yield* generateReply(api, {
        connection: {
          provider: "anthropic-bedrock",
          kind: "anthropic-bedrock",
          baseUrl: mock.url,
          apiKey: "bedrock-api-key-synthetic"
        },
        modelKey: MODEL,
        model: {}
      })
      assert.strictEqual(version.status, "complete", JSON.stringify(version.error))
      assert.include(version.content, "The tide is out.")
      const sent = mock.requests().at(-1)!
      assert.strictEqual(sent.method, "POST")
      assert.strictEqual(sent.path, `/model/${encodeURIComponent(MODEL)}/invoke-with-response-stream`)
      assert.strictEqual(header(sent, "authorization"), "Bearer bedrock-api-key-synthetic")
      assert.strictEqual(header(sent, "accept"), "application/vnd.amazon.eventstream")
      assert.isUndefined(header(sent, "x-api-key"))
      assert.isUndefined(header(sent, "anthropic-version"))
      const body = sent.body!
      assert.strictEqual(body.anthropic_version, "bedrock-2023-05-31")
      assert.notProperty(body, "model")
      assert.notProperty(body, "stream")
      assert.isArray(body.messages)
      // Bedrock refuses betas it doesn't know: only ones it documents go, in the body.
      for (const beta of (body.anthropic_beta as Array<string> | undefined) ?? [])
        assert.notInclude(["prompt-caching-2024-07-31", "files-api-2025-04-14"], beta)
      const ledger = yield* api.ListLlmRequests({ limit: 5, before: null })
      const request = ledger.find((r) => r.versionId === version.id)!
      assert.strictEqual(request.provider, "amazon-bedrock")
      assert.strictEqual(request.usageSource, "reported")
      assert.strictEqual(request.counts.cacheRead, 40)
      assert.strictEqual(request.counts.cacheWrite, 8)
      assert.strictEqual(request.counts.output, 5)
      assert.notInclude(JSON.stringify(ledger), "bedrock-api-key-synthetic")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("signs with an AWS access key for the connection's region", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* resource(bedrockReply())
      const api = yield* client()
      const secret = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY"
      yield* generateReply(api, {
        connection: {
          provider: "anthropic-bedrock",
          kind: "anthropic-bedrock",
          baseUrl: mock.url,
          apiKey: `AKIDEXAMPLE:${secret}`,
          providerSettings: { auth: "aws-sigv4", region: "eu-west-3" }
        },
        modelKey: MODEL,
        model: {}
      })
      const sent = mock.requests().at(-1)!
      const date = header(sent, "x-amz-date")!
      const expected = signV4({
        method: "POST",
        url: new URL(`${mock.url}${sent.path}`),
        headers: { "content-type": "application/json", accept: "application/vnd.amazon.eventstream" },
        body: JSON.stringify(sent.body),
        credentials: exampleKey,
        region: "eu-west-3",
        service: "bedrock",
        now: new Date(
          `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`
        )
      })
      assert.strictEqual(header(sent, "authorization"), expected.authorization)
      assert.include(header(sent, "authorization")!, `/eu-west-3/bedrock/aws4_request`)
      assert.notInclude(JSON.stringify(sent.headers), secret)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  /** Two replies in a row on `provider`: the cache markers of each request's messages. */
  const twoReplies = (provider: "anthropic" | "anthropic-bedrock") =>
    Effect.gen(function* () {
      const mock = yield* resource(
        provider === "anthropic" ? (_req, res) => anthropicSse(res, anthropicEvents({})) : bedrockReply()
      )
      const api = yield* client()
      const f = yield* generateReply(api, {
        connection: { provider, kind: provider, baseUrl: mock.url, apiKey: "synthetic-key" },
        modelKey: provider === "anthropic" ? "claude-haiku-4-5" : MODEL,
        model: {}
      })
      const first = mock.requests().at(-1)!.body!.messages as Array<WireMessage>
      const sent = yield* posted(
        api.SendMessage({
          chatId: f.chat.id,
          parentSlotId: f.version.slotId,
          branch: false,
          content: "The lantern swings."
        })
      )
      const { entry } = yield* posted(
        api.Generate({ chatId: f.chat.id, parentSlotId: sent.entry.slotId, branch: false })
      )
      yield* eventually(() => finished(f.events, entry.version.id)?.status === "complete")
      const second = mock.requests().at(-1)!.body!
      assert.isAtMost(JSON.stringify(second).split('"cache_control"').length - 1, 4)
      return { first: markedAt(first), second: markedAt(second.messages as Array<WireMessage>) }
    })

  it.live("marks the previous request's history again, since Bedrock looks no earlier for a cache hit", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const bedrock = yield* twoReplies("anthropic-bedrock")
      // The last marker of each is the request's own end; the one before it, the history's.
      const history = bedrock.first.at(-2)!
      assert.include(bedrock.second, history, "the first request's history marker is repeated")
      assert.isAbove(bedrock.second.at(-2)!, history, "and the new history is marked")
      // Anthropic reads back from a moved marker, so it repeats none.
      const anthropic = yield* twoReplies("anthropic")
      assert.notInclude(anthropic.second, anthropic.first.at(-2)!)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("reads Bedrock's errors as Anthropic's", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* resource((_req, res) => {
        res.writeHead(403, {
          "content-type": "application/json",
          "x-amzn-errortype": "AccessDeniedException:http://internal.amazon.com/coral/com.amazon.bedrock/"
        })
        res.end(JSON.stringify({ message: "You don't have access to the model with the specified model ID." }))
      })
      const api = yield* client()
      const { version } = yield* generateReply(api, {
        connection: {
          provider: "anthropic-bedrock",
          kind: "anthropic-bedrock",
          baseUrl: mock.url,
          apiKey: "bedrock-api-key-synthetic"
        },
        modelKey: MODEL,
        model: {}
      })
      assert.strictEqual(version.status, "failed")
      assert.strictEqual(version.error?.class, "auth")
      assert.include(version.error?.message, "access to the model")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})

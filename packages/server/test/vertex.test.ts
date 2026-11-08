// Claude on Google Vertex AI (providers/vertex.ts) against recorded shapes: a synthetic service
// account's JWT, checked with its public key; the token exchange and its cache; the rawPredict
// address and body; Google's errors; and a reply through a mock Vertex endpoint. Nothing here has
// reached a real Google Cloud project, nor Google's token endpoint.
import { assert, describe, it } from "@effect/vitest"
import { createVerify, generateKeyPairSync } from "node:crypto"
import { Effect } from "effect"
import {
  accessToken,
  clearVertexTokens,
  GOOGLE_TOKEN_URL,
  parseServiceAccount,
  serviceAccountJwt,
  VERTEX_VERSION,
  vertexKind,
  vertexModelId
} from "../src/providers/vertex.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { generateReply } from "./support/generation.ts"
import { anthropicSse, startMockProvider, type Handler } from "./support/mockProvider.ts"

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString()

const keyFile = (fields: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "service_account",
    project_id: "lantern-project-123",
    private_key_id: "0123456789abcdef0123456789abcdef01234567",
    private_key: pem,
    client_email: "mira@lantern-project-123.iam.gserviceaccount.com",
    client_id: "100000000000000000000",
    token_uri: "https://attacker.example/token",
    ...fields
  })

const account = parseServiceAccount(keyFile())!

const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString()) as Record<string, unknown>

interface Call {
  readonly url: string
  readonly init: RequestInit
}

/** A fetch standing in for Google: the token endpoint, then Vertex's reply or `vertex`. */
const google = (vertex: (call: Call) => Response = () => new Response("{}"), tokens = { n: 0 }) => {
  const calls: Array<Call> = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const call = { url: String(input), init: init ?? {} }
    calls.push(call)
    if (call.url === GOOGLE_TOKEN_URL) {
      tokens.n++
      return Response.json({ access_token: `ya29.synthetic-${tokens.n}`, expires_in: 3599, token_type: "Bearer" })
    }
    return vertex(call)
  }
  return { calls, fetch, tokens }
}

const sdkRequest = (body: Record<string, unknown>, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-api-key": "should-not-go",
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "fine-grained-tool-streaming-2025-05-14",
    "x-stainless-lang": "js",
    ...headers
  },
  body: JSON.stringify(body)
})

const transport = (fetch: typeof globalThis.fetch, settings: Record<string, unknown> = {}, apiKey = keyFile()) =>
  vertexKind.transport!(fetch, { apiKey, baseUrl: "https://aiplatform.googleapis.com", settings })

describe("a service account's sign-in", () => {
  it("reads a key file and refuses anything else", () => {
    assert.deepEqual(account, {
      clientEmail: "mira@lantern-project-123.iam.gserviceaccount.com",
      privateKey: pem,
      privateKeyId: "0123456789abcdef0123456789abcdef01234567",
      projectId: "lantern-project-123"
    })
    assert.isNull(parseServiceAccount("sk-ant-synthetic"))
    assert.isNull(parseServiceAccount(keyFile({ type: "authorized_user" })))
    assert.isNull(parseServiceAccount(JSON.stringify({ client_email: "a@b" })))
  })

  it("signs an hour's RS256 JWT for Google's token endpoint, whatever the key file names", () => {
    const now = new Date("2026-11-07T12:00:00Z")
    const jwt = serviceAccountJwt(account, now)
    const [header, claims, signature] = jwt.split(".") as [string, string, string]
    assert.deepEqual(decode(header), { alg: "RS256", typ: "JWT", kid: account.privateKeyId })
    assert.deepEqual(decode(claims), {
      iss: account.clientEmail,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      aud: "https://oauth2.googleapis.com/token",
      iat: 1794052800,
      exp: 1794056400
    })
    const verified = createVerify("RSA-SHA256")
      .update(`${header}.${claims}`)
      .verify(publicKey, Buffer.from(signature, "base64url"))
    assert.isTrue(verified)
  })

  it("exchanges the JWT once and reuses the token until a minute before it expires", async () => {
    clearVertexTokens()
    const g = google()
    let now = Date.parse("2026-11-07T12:00:00Z")
    const clock = () => now
    const [a, b] = await Promise.all([accessToken(g.fetch, account, clock), accessToken(g.fetch, account, clock)])
    assert.strictEqual(a, "ya29.synthetic-1")
    assert.strictEqual(b, a, "one exchange at a time")
    assert.strictEqual(g.calls.length, 1)
    const sent = g.calls[0]!
    assert.strictEqual(sent.url, "https://oauth2.googleapis.com/token")
    assert.strictEqual(sent.init.method, "POST")
    const form = new URLSearchParams(String(sent.init.body))
    assert.strictEqual(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer")
    assert.strictEqual(decode(form.get("assertion")!.split(".")[1]!).iss, account.clientEmail)
    assert.notInclude(String(sent.init.body), "PRIVATE KEY")
    now += 3599_000 - 61_000
    assert.strictEqual(await accessToken(g.fetch, account, clock), "ya29.synthetic-1")
    now += 2_000
    assert.strictEqual(await accessToken(g.fetch, account, clock), "ya29.synthetic-2")
    assert.strictEqual(g.calls.length, 2)
  })

  it("forgets a refused exchange, so the next request tries again", async () => {
    clearVertexTokens()
    let refuse = true
    const fetch: typeof globalThis.fetch = async () =>
      refuse
        ? Response.json({ error: "invalid_grant", error_description: "Invalid JWT Signature." }, { status: 400 })
        : Response.json({ access_token: "ya29.after", expires_in: 3599 })
    const error = await accessToken(fetch, account).catch((e: unknown) => e)
    assert.match(String(error), /Google refused the service account key \(invalid_grant: Invalid JWT Signature\.\)/)
    refuse = false
    assert.strictEqual(await accessToken(fetch, account), "ya29.after")
  })
})

describe("the Vertex request", () => {
  it("goes to the model's streamRawPredict address with the body less its model and Vertex's version", async () => {
    clearVertexTokens()
    const g = google()
    const send = transport(g.fetch, { region: "us-east5" })
    await send("https://aiplatform.googleapis.com/v1/messages", {
      ...sdkRequest({ model: "claude-haiku-4-5@20251001", max_tokens: 10, stream: true, messages: [] })
    })
    const sent = g.calls.at(-1)!
    assert.strictEqual(
      sent.url,
      "https://aiplatform.googleapis.com/v1/projects/lantern-project-123/locations/us-east5/publishers/anthropic/models/claude-haiku-4-5%4020251001:streamRawPredict"
    )
    const body = JSON.parse(String(sent.init.body)) as Record<string, unknown>
    assert.deepEqual(body, { anthropic_version: VERTEX_VERSION, max_tokens: 10, stream: true, messages: [] })
    const headers = new Headers(sent.init.headers)
    assert.strictEqual(headers.get("authorization"), "Bearer ya29.synthetic-1")
    assert.strictEqual(headers.get("anthropic-beta"), "fine-grained-tool-streaming-2025-05-14")
    for (const name of ["x-api-key", "anthropic-version", "x-stainless-lang"]) assert.isNull(headers.get(name))
  })

  it("takes the connection's project over the key file's, rawPredict unstreamed, and global by default", async () => {
    clearVertexTokens()
    const g = google()
    await transport(g.fetch, { project: "other-project-9" })("https://aiplatform.googleapis.com/v1/messages", {
      ...sdkRequest({ model: "claude-sonnet-4-6", max_tokens: 10, messages: [] })
    })
    assert.match(
      g.calls.at(-1)!.url,
      /\/v1\/projects\/other-project-9\/locations\/global\/publishers\/anthropic\/models\/claude-sonnet-4-6:rawPredict$/
    )
  })

  it("refuses without a usable key or project, sending nothing", async () => {
    clearVertexTokens()
    const g = google()
    const notAKey = await transport(
      g.fetch,
      {},
      "sk-ant-synthetic"
    )("https://aiplatform.googleapis.com/v1/messages", {
      ...sdkRequest({ model: "m", messages: [] })
    })
    assert.strictEqual(notAKey.status, 401)
    const noProject = await transport(
      g.fetch,
      {},
      keyFile({ project_id: "" })
    )("https://aiplatform.googleapis.com/v1/messages", sdkRequest({ model: "m", messages: [] }))
    assert.strictEqual(noProject.status, 400)
    assert.include(((await noProject.json()) as { error: { message: string } }).error.message, "project")
    assert.strictEqual(g.calls.length, 0)
  })

  it("reads Google's errors as Anthropic's, and passes Anthropic's through", async () => {
    clearVertexTokens()
    const cases: Array<[Response, number, string, string]> = [
      [
        Response.json(
          [{ error: { code: 429, message: "Quota exceeded for aiplatform.", status: "RESOURCE_EXHAUSTED" } }],
          { status: 429, headers: { "retry-after": "7" } }
        ),
        429,
        "rate_limit_error",
        "Quota exceeded"
      ],
      [
        Response.json(
          { error: { code: 403, message: "Permission denied on resource project.", status: "PERMISSION_DENIED" } },
          { status: 403 }
        ),
        403,
        "permission_error",
        "Permission denied"
      ],
      [
        Response.json({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, { status: 529 }),
        529,
        "overloaded_error",
        "Overloaded"
      ]
    ]
    for (const [reply, status, type, message] of cases) {
      const g = google(() => reply)
      const response = await transport(g.fetch)("https://aiplatform.googleapis.com/v1/messages", {
        ...sdkRequest({ model: "claude-haiku-4-5@20251001", messages: [] })
      })
      assert.strictEqual(response.status, status)
      const body = (await response.json()) as { type: string; error: { type: string; message: string } }
      assert.strictEqual(body.type, "error")
      assert.strictEqual(body.error.type, type)
      assert.include(body.error.message, message)
      if (status === 429) assert.strictEqual(response.headers.get("retry-after"), "7")
    }
  })

  it("reads a refused sign-in as an authentication error", async () => {
    clearVertexTokens()
    const fetch: typeof globalThis.fetch = async () =>
      Response.json({ error: "invalid_grant", error_description: "Invalid JWT Signature." }, { status: 400 })
    const response = await transport(fetch)("https://aiplatform.googleapis.com/v1/messages", {
      ...sdkRequest({ model: "claude-haiku-4-5@20251001", messages: [] })
    })
    assert.strictEqual(response.status, 401)
    const body = (await response.json()) as { error: { type: string; message: string } }
    assert.strictEqual(body.error.type, "authentication_error")
    assert.include(body.error.message, "Invalid JWT Signature")
  })

  it("names models as Vertex does: the date after an @, and no undated alias of a dated model", () => {
    const ids = ["claude-haiku-4-5", "claude-haiku-4-5-20251001", "claude-sonnet-4-6"]
    assert.strictEqual(vertexModelId("claude-haiku-4-5-20251001", ids), "claude-haiku-4-5@20251001")
    assert.isNull(vertexModelId("claude-haiku-4-5", ids))
    assert.strictEqual(vertexModelId("claude-sonnet-4-6", ids), "claude-sonnet-4-6")
  })
})

const resource = (handler: Handler) =>
  Effect.acquireRelease(
    Effect.promise(() => startMockProvider(handler)),
    (m) => Effect.promise(() => m.close())
  )

describe("a reply through Vertex", () => {
  it.live("reaches the model's address with the cached token, and reads Anthropic's events back", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      // The token is taken ahead, so the reply never reaches Google's token endpoint.
      clearVertexTokens()
      const g = google()
      yield* Effect.promise(() => accessToken(g.fetch, account))
      const mock = yield* resource((_req, res) =>
        anthropicSse(res, [
          {
            type: "message_start",
            message: {
              id: "msg_vrtx_1",
              type: "message",
              role: "assistant",
              model: "claude-haiku-4-5-20251001",
              content: [],
              usage: { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 30, cache_creation_input_tokens: 6 }
            }
          },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "The tide is out." } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
          { type: "message_stop" }
        ])
      )
      const api = yield* client()
      const { version } = yield* generateReply(api, {
        connection: {
          provider: "anthropic-vertex",
          kind: "anthropic-vertex",
          baseUrl: mock.url,
          apiKey: keyFile(),
          providerSettings: { region: "europe-west1" }
        },
        modelKey: "claude-haiku-4-5@20251001",
        model: {}
      })
      assert.strictEqual(version.status, "complete", JSON.stringify(version.error))
      assert.include(version.content, "The tide is out.")
      assert.strictEqual(g.calls.length, 1, "no second exchange")
      const sent = mock.requests().at(-1)!
      assert.strictEqual(
        sent.path,
        "/v1/projects/lantern-project-123/locations/europe-west1/publishers/anthropic/models/claude-haiku-4-5%4020251001:streamRawPredict"
      )
      assert.strictEqual(sent.headers.authorization, "Bearer ya29.synthetic-1")
      assert.isUndefined(sent.headers["x-api-key"])
      assert.strictEqual(sent.body!.anthropic_version, VERTEX_VERSION)
      assert.notProperty(sent.body!, "model")
      assert.include(JSON.stringify(sent.body), "cache_control")
      const ledger = yield* api.ListLlmRequests({ limit: 5, before: null })
      const request = ledger.find((r) => r.versionId === version.id)!
      assert.strictEqual(request.provider, "google-vertex")
      assert.strictEqual(request.counts.cacheRead, 30)
      assert.strictEqual(request.counts.cacheWrite, 6)
      assert.notInclude(JSON.stringify(ledger), "PRIVATE KEY")
      assert.notInclude(JSON.stringify(ledger), "ya29.")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})

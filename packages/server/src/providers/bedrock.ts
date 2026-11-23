// Claude on Amazon Bedrock (the `anthropic-bedrock` provider). Bedrock serves Anthropic's Messages
// API through InvokeModelWithResponseStream: the same request body (less `model` and `stream`, with
// `anthropic_version` and the betas in it), a different address, AWS signing or a Bedrock API key,
// and the same events wrapped in AWS's binary event-stream framing. So the request is built by
// pi-ai's Anthropic adapter, exactly as for Anthropic (every Messages transform, cache marker and
// usage observer applies), and this kind's transport rewrites it on the way out and the events on
// the way back, inside the controlled fetch: routing, redirects and the request's secrets stay ours.
//
// pi-ai's own Bedrock support (`bedrock-converse-stream`) is the Converse API through the AWS SDK,
// which takes no fetch, reads AWS's ambient configuration and has its own cache-point format; it
// isn't used. Not yet checked against a live Bedrock account (recorded shapes only, from AWS's API
// reference and Anthropic's Bedrock SDK): see ARCHITECTURE §6 "Anthropic on AWS Bedrock".
import { createHash, createHmac } from "node:crypto"
import { crc32 } from "node:zlib"
import { awsRegionOf } from "@dreamspan/shared/providerDefinitions.ts"
import { Effect } from "effect"
import { defaultCacheRelease } from "./cacheStagger.ts"
import { piCatalogs, withCatalog } from "./catalog.ts"
import type { KindTransportRequest, ProviderKindEntry } from "./registry.ts"
import { anthropicMessagesApi } from "./sdk.ts"

// --- AWS Signature Version 4 ----------------------------------------------------------------
// https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html

export interface AwsCredentials {
  readonly accessKeyId: string
  readonly secretAccessKey: string
  readonly sessionToken?: string
}

/** An access key as stored: `ACCESS_KEY_ID:SECRET_ACCESS_KEY`, optionally `:SESSION_TOKEN`. */
export const parseAwsKey = (key: string): AwsCredentials | null => {
  const [accessKeyId, secretAccessKey, sessionToken, ...rest] = key.trim().split(":")
  if (!accessKeyId || !secretAccessKey || rest.length > 0) return null
  return { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) }
}

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex")
const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest()
/** RFC 3986 percent-encoding, as SigV4 canonicalizes paths and queries. */
const rfc3986 = (text: string) =>
  encodeURIComponent(text).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

/**
 * The headers that sign a request: `x-amz-date`, the session token if any, and `authorization`.
 * `headers` are signed as given (lowercase names); `host` comes from the URL. Paths are encoded
 * again, as SigV4 does for every service but S3.
 */
export const signV4 = (input: {
  readonly method: string
  readonly url: URL
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
  readonly credentials: AwsCredentials
  readonly region: string
  readonly service: string
  readonly now: Date
}): Record<string, string> => {
  const amzDate = input.now.toISOString().replace(/[:-]|\.\d{3}/g, "")
  const day = amzDate.slice(0, 8)
  const signed: Record<string, string> = {
    ...Object.fromEntries(Object.entries(input.headers).map(([name, value]) => [name.toLowerCase(), value])),
    host: input.url.host,
    "x-amz-date": amzDate,
    ...(input.credentials.sessionToken ? { "x-amz-security-token": input.credentials.sessionToken } : {})
  }
  const names = Object.keys(signed).sort()
  const canonicalHeaders = names.map((name) => `${name}:${signed[name]!.trim().replace(/\s+/g, " ")}\n`).join("")
  const path = input.url.pathname.split("/").map(rfc3986).join("/") || "/"
  const query = [...input.url.searchParams]
    .map(([key, value]) => [rfc3986(key), rfc3986(value)] as const)
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join("&")
  const canonical = [input.method, path, query, canonicalHeaders, names.join(";"), sha256(input.body)].join("\n")
  const scope = `${day}/${input.region}/${input.service}/aws4_request`
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n")
  const key = ["aws4_request"].reduce(
    (k, part) => hmac(k, part),
    hmac(hmac(hmac(`AWS4${input.credentials.secretAccessKey}`, day), input.region), input.service)
  )
  const signature = createHmac("sha256", key).update(toSign).digest("hex")
  const { host: _host, ...sent } = signed
  return {
    ...sent,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`
  }
}

// --- AWS event streams --------------------------------------------------------------------
// https://docs.aws.amazon.com/transcribe/latest/dg/streaming-setting-up.html (the framing):
// total length, headers length, prelude CRC, headers, payload, message CRC; big-endian.

export interface EventStreamMessage {
  readonly headers: Readonly<Record<string, string | number | boolean>>
  readonly payload: Uint8Array
}

const decodeMessage = (bytes: Uint8Array): EventStreamMessage => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const total = view.getUint32(0)
  const headersLength = view.getUint32(4)
  if (
    view.getUint32(8) !== crc32(bytes.subarray(0, 8)) ||
    view.getUint32(total - 4) !== crc32(bytes.subarray(0, total - 4))
  )
    throw new Error("Bedrock's event stream failed its checksum")
  const headers: Record<string, string | number | boolean> = {}
  const text = new TextDecoder()
  let at = 12
  const end = 12 + headersLength
  while (at < end) {
    const nameLength = bytes[at]!
    const name = text.decode(bytes.subarray(at + 1, at + 1 + nameLength))
    at += 1 + nameLength
    const type = bytes[at]!
    at += 1
    // Booleans have no value bytes; then byte, short, int, long, bytes, string, timestamp, UUID.
    const sizes: Record<number, number> = { 0: 0, 1: 0, 2: 1, 3: 2, 4: 4, 5: 8, 8: 8, 9: 16 }
    if (type === 6 || type === 7) {
      const length = view.getUint16(at)
      headers[name] = text.decode(bytes.subarray(at + 2, at + 2 + length))
      at += 2 + length
      continue
    }
    const size = sizes[type]
    if (size === undefined) throw new Error(`Bedrock's event stream has an unknown header type ${type}`)
    if (type <= 1) headers[name] = type === 0
    else if (type === 2) headers[name] = view.getInt8(at)
    else if (type === 3) headers[name] = view.getInt16(at)
    else if (type === 4) headers[name] = view.getInt32(at)
    else if (type === 5 || type === 8) headers[name] = Number(view.getBigInt64(at))
    at += size
  }
  return { headers, payload: bytes.subarray(end, total - 4) }
}

/** The messages of an event stream, across any chunk boundaries. */
export async function* eventStreamMessages(body: AsyncIterable<Uint8Array>): AsyncGenerator<EventStreamMessage> {
  let buffer = new Uint8Array(0)
  for await (const chunk of body) {
    const joined = new Uint8Array(buffer.length + chunk.length)
    joined.set(buffer)
    joined.set(chunk, buffer.length)
    buffer = joined
    while (buffer.length >= 12) {
      const total = new DataView(buffer.buffer, buffer.byteOffset).getUint32(0)
      if (total < 16) throw new Error("Bedrock's event stream has a malformed message")
      if (buffer.length < total) break
      yield decodeMessage(buffer.subarray(0, total))
      buffer = buffer.subarray(total)
    }
  }
  if (buffer.length > 0) throw new Error("Bedrock's event stream ended mid-message")
}

/** Encodes one message: for tests' recorded responses. */
export const encodeEventStreamMessage = (headers: Readonly<Record<string, string>>, payload: Uint8Array) => {
  const encoder = new TextEncoder()
  const parts = Object.entries(headers).flatMap(([name, value]) => {
    const n = encoder.encode(name)
    const v = encoder.encode(value)
    const head = new Uint8Array(1 + n.length + 1 + 2)
    head[0] = n.length
    head.set(n, 1)
    head[1 + n.length] = 7
    new DataView(head.buffer).setUint16(2 + n.length, v.length)
    return [head, v]
  })
  const headersLength = parts.reduce((sum, part) => sum + part.length, 0)
  const total = 12 + headersLength + payload.length + 4
  const bytes = new Uint8Array(total)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, total)
  view.setUint32(4, headersLength)
  view.setUint32(8, crc32(bytes.subarray(0, 8)))
  let at = 12
  for (const part of parts) bytes.set(part, (at += part.length) - part.length)
  bytes.set(payload, at)
  view.setUint32(total - 4, crc32(bytes.subarray(0, total - 4)))
  return bytes
}

// --- Bedrock's keys -----------------------------------------------------------------------

/**
 * The headers that authorize a request to Bedrock's runtime, for every model it serves: `headers`
 * signed with the connection's AWS access key (SigV4, service `bedrock`, the connection's Region),
 * or sent with its Bedrock API key as a bearer token.
 */
export const bedrockAuthHeaders = (
  request: KindTransportRequest,
  signed: {
    readonly method: string
    readonly url: URL
    readonly headers: Readonly<Record<string, string>>
    readonly body: string
  }
): Record<string, string> => {
  if (request.apiKey === null) throw new Error("This connection has no key.")
  if (request.settings.auth !== "aws-sigv4") return { ...signed.headers, authorization: `Bearer ${request.apiKey}` }
  const credentials = parseAwsKey(request.apiKey)
  if (!credentials) throw new Error("The AWS access key isn't in the form ACCESS_KEY_ID:SECRET_ACCESS_KEY.")
  return signV4({
    ...signed,
    credentials,
    region: request.settings.region ?? awsRegionOf(request.baseUrl) ?? "us-east-1",
    service: "bedrock",
    now: new Date()
  })
}

/** An access key ID or a secret alone is still a secret. */
export const bedrockSecretsOf = (key: string) => key.split(":").filter((part) => part.length >= 8)

// --- The transport ------------------------------------------------------------------------

/** Betas Bedrock documents for Claude; it refuses unknown ones, so the rest are left out. */
const BEDROCK_BETAS = new Set([
  "interleaved-thinking-2025-05-14",
  "fine-grained-tool-streaming-2025-05-14",
  "context-1m-2025-08-07",
  "token-efficient-tools-2025-02-19",
  "output-128k-2025-02-19",
  // Preserved thinking's controls (thinkingBinding.ts `dropOnMismatch`), which Bedrock documents.
  "thinking-binding-controls-2026-08-01"
])

/** Bedrock's exception names as Anthropic's error types, so errors read as Anthropic's do. */
const errorType = (exception: string) =>
  /throttl|toomanyrequests|modelnotready/i.test(exception)
    ? "rate_limit_error"
    : /serviceunavailable|overloaded/i.test(exception)
      ? "overloaded_error"
      : /validation/i.test(exception)
        ? "invalid_request_error"
        : /accessdenied/i.test(exception)
          ? "permission_error"
          : /unrecognizedclient|signature|token|credential|expired/i.test(exception)
            ? "authentication_error"
            : /notfound/i.test(exception)
              ? "not_found_error"
              : "api_error"

export const messageOf = (text: string) => {
  try {
    const parsed = JSON.parse(text) as { message?: unknown; Message?: unknown }
    const message = parsed.message ?? parsed.Message
    return typeof message === "string" ? message : text
  } catch {
    return text
  }
}

const sse = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`

/** The SSE Anthropic's SDK reads, from Bedrock's event stream. */
const toSse = (body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> => {
  const messages = eventStreamMessages(body)
  const encoder = new TextEncoder()
  const text = new TextDecoder()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await messages.next()
        if (next.done) return controller.close()
        const { headers, payload } = next.value
        if (headers[":message-type"] === "exception" || headers[":message-type"] === "error") {
          const exception = String(headers[":exception-type"] ?? headers[":error-code"] ?? "")
          const message = messageOf(text.decode(payload)) || exception
          controller.enqueue(
            encoder.encode(sse("error", { type: "error", error: { type: errorType(exception), message } }))
          )
          return controller.close()
        }
        if (headers[":event-type"] !== "chunk") return
        const chunk = JSON.parse(text.decode(payload)) as { bytes?: string }
        if (typeof chunk.bytes !== "string") return
        const event = JSON.parse(Buffer.from(chunk.bytes, "base64").toString("utf8")) as { type?: string }
        controller.enqueue(encoder.encode(sse(event.type ?? "message", event)))
      } catch (error) {
        controller.error(error)
      }
    },
    cancel: (reason) => messages.return(undefined).then(() => body.cancel(reason).catch(() => undefined))
  })
}

export const requestUrl = (input: string | URL | Request) =>
  new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)

/** Headers of the SDK's own that Bedrock has no use for: the key, Anthropic's versions and betas. */
const dropped = /^(x-api-key|authorization|anthropic-.*|x-stainless-.*|content-length|accept)$/i

/**
 * Wraps the controlled fetch: a Messages request from Anthropic's SDK becomes the Bedrock
 * request for its model, signed with an AWS access key or sent with a Bedrock API key, and the
 * answer comes back as the SDK expects it. Anything else the SDK asks for isn't served here.
 */
const bedrockTransport =
  (fetch: typeof globalThis.fetch, request: KindTransportRequest): typeof globalThis.fetch =>
  async (input, init) => {
    const url = requestUrl(input)
    if (!/\/v1\/messages$/.test(url.pathname) || typeof init?.body !== "string") {
      return new Response(
        JSON.stringify({
          type: "error",
          error: { type: "not_found_error", message: "Bedrock doesn't serve this request." }
        }),
        { status: 404, headers: { "content-type": "application/json" } }
      )
    }
    if (request.apiKey === null) throw new Error("This connection has no key.")
    const { model, stream, ...body } = JSON.parse(init.body) as Record<string, unknown>
    const given = new Headers(init.headers)
    const betas = (given.get("anthropic-beta") ?? "")
      .split(",")
      .map((beta) => beta.trim())
      .filter((beta) => BEDROCK_BETAS.has(beta))
    const payload = JSON.stringify({
      anthropic_version: "bedrock-2023-05-31",
      ...body,
      ...(betas.length > 0 ? { anthropic_beta: betas } : {})
    })
    const target = new URL(
      `${request.baseUrl.replace(/\/+$/, "")}/model/${encodeURIComponent(String(model))}/${stream ? "invoke-with-response-stream" : "invoke"}`
    )
    const headers: Record<string, string> = {}
    given.forEach((value, name) => {
      if (!dropped.test(name)) headers[name] = value
    })
    const signed = {
      "content-type": "application/json",
      accept: stream ? "application/vnd.amazon.eventstream" : "application/json"
    }
    Object.assign(headers, bedrockAuthHeaders(request, { method: "POST", url: target, headers: signed, body: payload }))
    const response = await fetch(target.href, { method: "POST", headers, body: payload, signal: init.signal ?? null })
    const requestId = response.headers.get("x-amzn-requestid")
    const answered = (status: number, kind: string, body: string | ReadableStream<Uint8Array>) =>
      new Response(body, {
        status,
        headers: {
          "content-type": kind,
          ...(requestId ? { "request-id": requestId } : {}),
          ...(response.headers.get("retry-after") ? { "retry-after": response.headers.get("retry-after")! } : {})
        }
      })
    if (!response.ok) {
      const text = await response.text()
      const exception = (response.headers.get("x-amzn-errortype") ?? "").split(":")[0] ?? ""
      return answered(
        response.status,
        "application/json",
        JSON.stringify({ type: "error", error: { type: errorType(exception), message: messageOf(text) || exception } })
      )
    }
    if (!stream || response.body === null) return answered(response.status, "application/json", await response.text())
    return answered(200, "text/event-stream", toSse(response.body))
  }

// --- The kind -----------------------------------------------------------------------------

const loadCatalog = piCatalogs["amazon-bedrock"]!

/**
 * Anthropic Messages on Bedrock. Its models are pi-ai's Bedrock catalog's Claude IDs (inference
 * profiles such as `us.anthropic.claude-sonnet-5-5` and base model IDs): listing Bedrock's models
 * is another AWS service at another address, which the key isn't allowed to go to.
 */
export const bedrockKind: ProviderKindEntry = {
  id: "anthropic-bedrock",
  label: "Anthropic Messages on AWS Bedrock",
  piProvider: "amazon-bedrock",
  api: "anthropic-messages",
  streams: anthropicMessagesApi(),
  acceptsFetch: true,
  defaultBaseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
  keyOptional: false,
  catalog: loadCatalog,
  cacheRelease: defaultCacheRelease,
  listsCatalog: true,
  transport: bedrockTransport,
  secretsOf: bedrockSecretsOf,
  listModels: () =>
    Effect.promise(() => loadCatalog().catch(() => ({}))).pipe(
      Effect.map((catalog) =>
        Object.keys(catalog)
          .filter((key) => /(?:^|\.)anthropic\.claude/.test(key))
          .map((key) => ({ key, upstream: {} }))
      ),
      Effect.flatMap((listed) => withCatalog(bedrockKind, listed))
    )
}

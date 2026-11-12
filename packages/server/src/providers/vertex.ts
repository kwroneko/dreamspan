// Claude on Google Cloud's Vertex AI (the `anthropic-vertex` provider). Vertex serves Anthropic's
// Messages API at the model's own address, `…/v1/projects/{project}/locations/{region}/publishers/
// anthropic/models/{model}:streamRawPredict` (`:rawPredict` unstreamed), with the same request body
// less `model` and with `anthropic_version: "vertex-2023-10-16"` in it, and the same SSE back. So,
// as for Bedrock, pi-ai's Anthropic adapter builds the request (every Messages transform, cache
// marker and usage observer applies) and this kind's transport moves it, inside the controlled fetch.
//
// The key is a service account's JSON key file. It never leaves the server: it signs a JWT that
// Google's token endpoint exchanges for an hour's access token, kept in memory until a minute
// before it expires. The token endpoint is fixed, never read from the key file.
//
// Sources: https://platform.claude.com/docs/en/build-with-claude/claude-on-vertex-ai (addresses,
// body, model IDs), https://developers.google.com/identity/protocols/oauth2/service-account (the
// JWT exchange). Not yet checked against a live Google Cloud project: recorded shapes only
// (ARCHITECTURE §6 "Anthropic on Google Vertex").
import { createHash, createSign } from "node:crypto"
import { Effect } from "effect"
import { messageOf, requestUrl } from "./bedrock.ts"
import { defaultCacheRelease } from "./cacheStagger.ts"
import { piCatalogs, withCatalog } from "./catalog.ts"
import type { Catalog, KindTransportRequest, ProviderKindEntry } from "./registry.ts"
import { anthropicMessagesApi } from "./sdk.ts"

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
const SCOPE = "https://www.googleapis.com/auth/cloud-platform"
export const VERTEX_VERSION = "vertex-2023-10-16"

export interface ServiceAccount {
  readonly clientEmail: string
  readonly privateKey: string
  readonly privateKeyId: string | null
  readonly projectId: string | null
}

/** A service account's JSON key file, or null when it isn't one. */
export const parseServiceAccount = (key: string): ServiceAccount | null => {
  try {
    const parsed = JSON.parse(key) as Record<string, unknown>
    const { client_email, private_key, private_key_id, project_id, type } = parsed
    if (typeof client_email !== "string" || typeof private_key !== "string") return null
    if (type !== undefined && type !== "service_account") return null
    return {
      clientEmail: client_email,
      privateKey: private_key,
      privateKeyId: typeof private_key_id === "string" ? private_key_id : null,
      projectId: typeof project_id === "string" && project_id !== "" ? project_id : null
    }
  } catch {
    return null
  }
}

const base64url = (data: string | Buffer) => Buffer.from(data).toString("base64url")

/** The signed JWT a service account exchanges for an access token (RS256, an hour). */
export const serviceAccountJwt = (account: ServiceAccount, now: Date): string => {
  const iat = Math.floor(now.getTime() / 1000)
  const header = base64url(
    JSON.stringify({ alg: "RS256", typ: "JWT", ...(account.privateKeyId ? { kid: account.privateKeyId } : {}) })
  )
  const claims = base64url(
    JSON.stringify({ iss: account.clientEmail, scope: SCOPE, aud: GOOGLE_TOKEN_URL, iat, exp: iat + 3600 })
  )
  const signature = createSign("RSA-SHA256").update(`${header}.${claims}`).sign(account.privateKey)
  return `${header}.${claims}.${base64url(signature)}`
}

interface Token {
  readonly value: string
  readonly expiresAt: number
}

/** Access tokens by key, in memory only; one exchange at a time per key. */
const tokens = new Map<string, Promise<Token>>()

const tokenKey = (account: ServiceAccount) =>
  createHash("sha256").update(`${account.clientEmail}\n${account.privateKey}`).digest("hex")

class GoogleSignInError extends Error {}

/** An access token for the account: the cached one while it has a minute left, else a new one. */
export const accessToken = async (
  fetch: typeof globalThis.fetch,
  account: ServiceAccount,
  now: () => number = Date.now
): Promise<string> => {
  const key = tokenKey(account)
  const cached = tokens.get(key)
  if (cached) {
    const token = await cached.catch(() => null)
    if (token && token.expiresAt - 60_000 > now()) return token.value
    if (tokens.get(key) === cached) tokens.delete(key)
  }
  const pending = (async (): Promise<Token> => {
    const response = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: serviceAccountJwt(account, new Date(now()))
      }).toString()
    })
    const text = await response.text()
    let body: Record<string, unknown> = {}
    try {
      body = JSON.parse(text) as Record<string, unknown>
    } catch {
      body = {}
    }
    if (!response.ok || typeof body.access_token !== "string") {
      const reason = [body.error, body.error_description].filter((part) => typeof part === "string").join(": ")
      throw new GoogleSignInError(`Google refused the service account key${reason ? ` (${reason})` : ""}.`)
    }
    const seconds = typeof body.expires_in === "number" ? body.expires_in : 3600
    return { value: body.access_token, expiresAt: now() + seconds * 1000 }
  })()
  tokens.set(key, pending)
  pending.catch(() => {
    if (tokens.get(key) === pending) tokens.delete(key)
  })
  return (await pending).value
}

/** Forgets every cached token (tests). */
export const clearVertexTokens = () => tokens.clear()

/** Google's error statuses as Anthropic's error types, so errors read as Anthropic's do. */
const errorType = (status: string, code: number) =>
  status === "UNAUTHENTICATED" || code === 401
    ? "authentication_error"
    : status === "PERMISSION_DENIED" || code === 403
      ? "permission_error"
      : status === "RESOURCE_EXHAUSTED" || code === 429
        ? "rate_limit_error"
        : status === "NOT_FOUND" || code === 404
          ? "not_found_error"
          : status === "UNAVAILABLE" || code === 503 || code === 529
            ? "overloaded_error"
            : status === "INVALID_ARGUMENT" || status === "FAILED_PRECONDITION" || code === 400
              ? "invalid_request_error"
              : "api_error"

const anthropicError = (status: number, type: string, message: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ type: "error", error: { type, message } }), {
    status,
    headers: { "content-type": "application/json", ...headers }
  })

/** Headers of the SDK's own that Vertex has no use for: the key, the version (it's in the body). */
const dropped = /^(x-api-key|authorization|anthropic-version|x-stainless-.*|content-length|host)$/i

/**
 * Wraps the controlled fetch: a Messages request from Anthropic's SDK becomes the Vertex request for
 * its model, project and region, sent with an access token from the connection's service account.
 */
const vertexTransport =
  (fetch: typeof globalThis.fetch, request: KindTransportRequest): typeof globalThis.fetch =>
  async (input, init) => {
    const url = requestUrl(input)
    if (!/\/v1\/messages$/.test(url.pathname) || typeof init?.body !== "string")
      return anthropicError(404, "not_found_error", "Vertex AI doesn't serve this request.")
    const account = request.apiKey === null ? null : parseServiceAccount(request.apiKey)
    if (account === null)
      return anthropicError(
        401,
        "authentication_error",
        "This connection's key isn't a service account’s JSON key file."
      )
    const project = request.settings.project ?? account.projectId
    if (!project)
      return anthropicError(400, "invalid_request_error", "Enter the Google Cloud project: the key file names none.")
    const region = request.settings.region ?? "global"
    const { model, ...body } = JSON.parse(init.body) as Record<string, unknown>
    const payload = JSON.stringify({ anthropic_version: VERTEX_VERSION, ...body })
    const target = new URL(
      `${request.baseUrl.replace(/\/+$/, "")}/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(region)}/publishers/anthropic/models/${encodeURIComponent(String(model))}:${body.stream ? "streamRawPredict" : "rawPredict"}`
    )
    let token: string
    try {
      token = await accessToken(request.aside ?? fetch, account)
    } catch (error) {
      if (error instanceof GoogleSignInError) return anthropicError(401, "authentication_error", error.message)
      throw error
    }
    const headers: Record<string, string> = {}
    new Headers(init.headers).forEach((value, name) => {
      if (!dropped.test(name)) headers[name] = value
    })
    headers["content-type"] = "application/json"
    headers.authorization = `Bearer ${token}`
    const response = await fetch(target.href, { method: "POST", headers, body: payload, signal: init.signal ?? null })
    if (response.ok) return response
    const text = await response.text()
    let parsed: unknown = null
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = null
    }
    // Anthropic's own errors pass through; Google's (`{"error": {code, message, status}}`, at
    // times in a one-element array) are mapped.
    const google = (Array.isArray(parsed) ? parsed[0] : parsed) as {
      type?: unknown
      error?: Record<string, unknown>
    } | null
    if (google?.type === "error") return new Response(text, { status: response.status, headers: response.headers })
    const error = google?.error ?? {}
    const retryAfter = response.headers.get("retry-after")
    return anthropicError(
      response.status,
      errorType(String(error.status ?? ""), Number(error.code ?? response.status)),
      typeof error.message === "string" ? error.message : messageOf(text) || response.statusText,
      retryAfter ? { "retry-after": retryAfter } : {}
    )
  }

// --- The kind -----------------------------------------------------------------------------

/**
 * A model's Vertex ID: Anthropic's, with `@` before the date of a dated ID (`claude-haiku-4-5@20251001`).
 * Anthropic's undated alias of a dated model isn't a Vertex ID, so it's left out (null).
 */
export const vertexModelId = (id: string, all: ReadonlyArray<string>): string | null => {
  const dated = /^(.*)-(\d{8})$/.exec(id)
  if (dated) return `${dated[1]}@${dated[2]}`
  return all.some((other) => other.startsWith(`${id}-`) && /-\d{8}$/.test(other)) ? null : id
}

/** Anthropic's catalog under Vertex's model IDs: pi-ai's Vertex catalog has Gemini only. */
const loadCatalog = async (): Promise<Catalog> => {
  const anthropic = await piCatalogs.anthropic!()
  const ids = Object.keys(anthropic)
  return Object.fromEntries(
    ids.flatMap((id) => {
      const vertex = vertexModelId(id, ids)
      return vertex === null ? [] : [[vertex, { ...anthropic[id]!, id: vertex }]]
    })
  )
}

/** The service account's private key in every form a message could quote it, and its key ID. */
const secretsOf = (key: string) => {
  const account = parseServiceAccount(key)
  if (account === null) return key.length >= 8 ? [key] : []
  const lines = account.privateKey.split(/\r?\n/).filter((line) => line.length >= 8 && !line.startsWith("-----"))
  return [
    key,
    account.privateKey,
    JSON.stringify(account.privateKey).slice(1, -1),
    ...lines,
    ...(account.privateKeyId ? [account.privateKeyId] : [])
  ]
}

/**
 * Anthropic Messages on Vertex AI. Its models are Anthropic's catalog's, under Vertex's IDs:
 * listing Vertex's models is another Google service the key isn't sent to.
 */
export const vertexKind: ProviderKindEntry = {
  id: "anthropic-vertex",
  label: "Anthropic Messages on Google Vertex AI",
  piProvider: "google-vertex",
  api: "anthropic-messages",
  streams: anthropicMessagesApi(),
  acceptsFetch: true,
  defaultBaseUrl: "https://aiplatform.googleapis.com",
  keyOptional: false,
  catalog: loadCatalog,
  cacheRelease: defaultCacheRelease,
  listsCatalog: true,
  transport: vertexTransport,
  secretsOf,
  listModels: () =>
    Effect.promise(() => loadCatalog().catch(() => ({}))).pipe(
      Effect.map((catalog) => Object.keys(catalog).map((key) => ({ key, upstream: {} }))),
      Effect.flatMap((listed) => withCatalog(vertexKind, listed))
    )
}

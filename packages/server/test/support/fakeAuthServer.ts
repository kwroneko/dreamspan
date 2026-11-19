// A local OAuth authorization server for tests (spec/MCP.md §14 M5): dynamic client
// registration, authorization code with PKCE (S256 only), refresh tokens, and resource
// indicators, as the MCP authorization flow uses them. It approves every sign-in at once: a test
// follows the authorization page's redirect itself. Never a third-party server.
import { createHash, randomBytes } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"

export interface FakeAuthState {
  /** How long an access token lives, in seconds. */
  accessTtlS: number
  /** Refresh requests are refused (`invalid_grant`): the user must sign in again. */
  refuseRefresh: boolean
  /** Registration answers 400 with this body, which isn't an OAuth error (a page from elsewhere). */
  registerBody: string | null
}

interface Issued {
  readonly clientId: string
  readonly resource: string | null
  readonly until: number
}

export interface FakeAuthServer {
  readonly url: string
  readonly state: FakeAuthState
  /** Every request's path, with the grant type for token requests ("token:refresh_token"). */
  readonly requests: () => ReadonlyArray<string>
  /** The client registrations made, by client id. */
  readonly clients: () => ReadonlyMap<string, Record<string, unknown>>
  /** Whether an access token is one this server issued and still valid. */
  readonly valid: (token: string) => boolean
  /** The resource an access token was issued for. */
  readonly resourceOf: (token: string) => string | null
  /** Makes every access token issued so far expire now. */
  readonly expireAll: () => void
  readonly close: () => Promise<void>
}

const readBody = (request: IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    const chunks: Array<Buffer> = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    request.on("error", reject)
  })

const json = (response: ServerResponse, status: number, body: unknown) =>
  response
    .writeHead(status, { "content-type": "application/json", "cache-control": "no-store" })
    .end(JSON.stringify(body))

const token = () => randomBytes(24).toString("base64url")

export const startFakeAuthServer = async (initial: Partial<FakeAuthState> = {}): Promise<FakeAuthServer> => {
  const state: FakeAuthState = { accessTtlS: 3600, refuseRefresh: false, registerBody: null, ...initial }
  const recorded: Array<string> = []
  const clients = new Map<string, Record<string, unknown>>()
  const codes = new Map<string, { clientId: string; challenge: string; redirectUri: string; resource: string | null }>()
  const access = new Map<string, Issued>()
  const refresh = new Map<string, { clientId: string; resource: string | null }>()
  let base = ""

  const issue = (clientId: string, resource: string | null) => {
    const accessToken = `at-${token()}`
    const refreshToken = `rt-${token()}`
    access.set(accessToken, { clientId, resource, until: Date.now() + state.accessTtlS * 1000 })
    refresh.set(refreshToken, { clientId, resource })
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: state.accessTtlS,
      refresh_token: refreshToken
    }
  }

  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", base)
    const body = request.method === "POST" ? await readBody(request) : ""
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      recorded.push(url.pathname)
      return json(response, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"]
      })
    }
    if (url.pathname === "/register" && request.method === "POST") {
      recorded.push("/register")
      if (state.registerBody !== null) {
        response.writeHead(400, { "content-type": "text/html" }).end(state.registerBody)
        return
      }
      const metadata = JSON.parse(body) as Record<string, unknown>
      const clientId = `client-${token()}`
      const registered = { ...metadata, client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000) }
      clients.set(clientId, registered)
      return json(response, 201, registered)
    }
    if (url.pathname === "/authorize" && request.method === "GET") {
      recorded.push("/authorize")
      const q = url.searchParams
      const client = clients.get(q.get("client_id") ?? "")
      const redirectUri = q.get("redirect_uri") ?? ""
      if (
        !client ||
        !(client.redirect_uris as Array<string>).includes(redirectUri) ||
        q.get("response_type") !== "code" ||
        q.get("code_challenge_method") !== "S256" ||
        !q.get("code_challenge")
      )
        return json(response, 400, { error: "invalid_request" })
      const code = `code-${token()}`
      codes.set(code, {
        clientId: client.client_id as string,
        challenge: q.get("code_challenge")!,
        redirectUri,
        resource: q.get("resource")
      })
      const back = new URL(redirectUri)
      back.searchParams.set("code", code)
      if (q.get("state") !== null) back.searchParams.set("state", q.get("state")!)
      response.writeHead(302, { location: back.href }).end()
      return
    }
    if (url.pathname === "/token" && request.method === "POST") {
      const form = new URLSearchParams(body)
      const grant = form.get("grant_type")
      recorded.push(`token:${grant}`)
      if (grant === "authorization_code") {
        const entry = codes.get(form.get("code") ?? "")
        codes.delete(form.get("code") ?? "")
        const verifier = form.get("code_verifier") ?? ""
        const challenge = createHash("sha256").update(verifier).digest("base64url")
        if (
          !entry ||
          entry.challenge !== challenge ||
          entry.clientId !== form.get("client_id") ||
          entry.redirectUri !== form.get("redirect_uri")
        )
          return json(response, 400, { error: "invalid_grant" })
        return json(response, 200, issue(entry.clientId, form.get("resource") ?? entry.resource))
      }
      if (grant === "refresh_token") {
        const entry = refresh.get(form.get("refresh_token") ?? "")
        if (state.refuseRefresh || !entry || entry.clientId !== form.get("client_id"))
          return json(response, 400, { error: "invalid_grant" })
        refresh.delete(form.get("refresh_token")!)
        return json(response, 200, issue(entry.clientId, entry.resource))
      }
      return json(response, 400, { error: "unsupported_grant_type" })
    }
    recorded.push(url.pathname)
    response.writeHead(404).end("not found")
  }

  const http = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (!response.headersSent) response.writeHead(500).end(String(error))
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`
  return {
    url: base,
    state,
    requests: () => recorded,
    clients: () => clients,
    valid: (value) => (access.get(value)?.until ?? 0) > Date.now(),
    resourceOf: (value) => access.get(value)?.resource ?? null,
    expireAll: () => {
      for (const [key, entry] of access) access.set(key, { ...entry, until: 0 })
    },
    close: async () => {
      http.closeAllConnections()
      await new Promise<void>((resolve) => http.close(() => resolve()))
    }
  }
}

/** Follows the authorization page as a browser would, approving at once: the callback's query. */
export const approveSignIn = async (authorizationUrl: string) => {
  const response = await fetch(authorizationUrl, { redirect: "manual" })
  const location = response.headers.get("location")
  if (response.status !== 302 || location === null) throw new Error(`no redirect: ${response.status}`)
  const back = new URL(location)
  return { redirect: back, code: back.searchParams.get("code"), state: back.searchParams.get("state") }
}

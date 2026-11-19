// Signing in with an MCP server (spec/MCP.md §2.4): the MCP authorization flow through the SDK's
// `auth()` (protected-resource metadata, the authorization server's metadata, dynamic client
// registration, authorization code with PKCE S256, resource indicators, refresh). The SDK drives
// the protocol; this module gives it a provider that keeps everything in memory for one step,
// so the caller decides what is stored, encrypted, on the user's own use of the connection.
//
// Delta from reference-harness, which has no OAuth: the whole module. Delta from the spec: the client
// registers itself by dynamic registration only. A Client ID Metadata Document needs an https
// address the authorization server can fetch, which a self-hosted instance often lacks.
import { randomBytes } from "node:crypto"
import { lookup } from "node:dns/promises"
import { isIP } from "node:net"
import { auth, type OAuthClientProvider, type OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js"
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js"
import type { TargetAddresses } from "../net/Network.ts"
import { sandboxMayReach } from "../sandbox/network.ts"

/** What the app keeps of one user's sign-in, encrypted on their `mcp_uses` row. */
export interface StoredSignIn {
  /**
   * The server's address the sign-in was made for. Its registration, discovery and tokens are
   * used only while the connection still has this address: another address discovers afresh.
   */
  readonly serverUrl: string
  /** The resource indicator was the server's origin only (a shared user's sign-in, see below). */
  readonly resourceOrigin: boolean
  /** The app's registration with the authorization server, for this redirect address. */
  readonly client: OAuthClientInformationMixed
  readonly redirectUri: string
  readonly tokens: OAuthTokens
  readonly discovery: OAuthDiscoveryState | null
  /** When the access token expires (ms), from `expires_in`; null when the server didn't say. */
  readonly expiresAt: number | null
  readonly signedInAt: number
}

/** A sign-in the browser is away for: what the code exchange will need. */
export interface PendingSignIn {
  readonly serverUrl: string
  readonly resourceOrigin: boolean
  readonly client: OAuthClientInformationMixed
  readonly redirectUri: string
  readonly verifier: string
  readonly discovery: OAuthDiscoveryState | null
  readonly state: string
}

type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>

/** The app as an OAuth client: a public client (PKCE, no secret) that redirects to the app. */
const clientMetadata = (redirectUri: string) => ({
  client_name: "Dreamspan",
  redirect_uris: [redirectUri],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none"
})

/**
 * The app's registrations, by authorization server and redirect address, so signing in again,
 * or another user signing in with the same service, reuses one instead of registering anew
 * (a registration is the app's, a public client with no secret, not a user's). In memory, the
 * most recently used kept.
 */
export const makeClientRegistry = (max = 256) => {
  const clients = new Map<string, OAuthClientInformationMixed>()
  const keyOf = (issuer: string, redirectUri: string) => `${issuer}\u0000${redirectUri}`
  return {
    get: (issuer: string, redirectUri: string) => {
      const key = keyOf(issuer, redirectUri)
      const client = clients.get(key)
      if (client === undefined) return undefined
      clients.delete(key)
      clients.set(key, client)
      return client
    },
    set: (issuer: string, redirectUri: string, client: OAuthClientInformationMixed) => {
      const key = keyOf(issuer, redirectUri)
      clients.delete(key)
      clients.set(key, client)
      while (clients.size > max) clients.delete(clients.keys().next().value!)
    },
    delete: (issuer: string, redirectUri: string) => void clients.delete(keyOf(issuer, redirectUri)),
    size: () => clients.size
  }
}
export type ClientRegistry = ReturnType<typeof makeClientRegistry>

/** A provider over memory: it starts with what the step needs and records what the SDK saves. */
class StepProvider implements OAuthClientProvider {
  client: OAuthClientInformationMixed | undefined
  saved: OAuthTokens | undefined
  verifier = ""
  discovery: OAuthDiscoveryState | undefined
  authorizationUrl: URL | undefined
  readonly stateValue = randomBytes(32).toString("base64url")
  readonly redirectUri: string
  private readonly registry: ClientRegistry | undefined
  /**
   * Present only for a shared user's sign-in: the resource indicator is the server's origin, not
   * its address, whose path and query only the owner sees. The sign-in page's address, which the
   * user's browser opens, then carries nothing of them.
   */
  validateResourceURL?: (serverUrl: string | URL, resource?: string) => Promise<URL | undefined>
  constructor(
    redirectUri: string,
    start: {
      readonly client?: OAuthClientInformationMixed | undefined
      readonly tokens?: OAuthTokens | undefined
      readonly verifier?: string | undefined
      readonly discovery?: OAuthDiscoveryState | null | undefined
      readonly registry?: ClientRegistry | undefined
      readonly resourceOrigin: boolean
    }
  ) {
    this.redirectUri = redirectUri
    this.client = start.client
    this.saved = start.tokens
    this.verifier = start.verifier ?? ""
    this.discovery = start.discovery ?? undefined
    this.registry = start.registry
    if (start.resourceOrigin)
      this.validateResourceURL = async (serverUrl, resource) => {
        // As the SDK: no resource indicator without the server's metadata.
        if (resource === undefined) return undefined
        const origin = new URL(serverUrl).origin
        if (new URL(resource).origin !== origin) throw new Error("The server's sign-in details name another server.")
        return new URL(origin)
      }
  }
  private get issuer() {
    return this.discovery?.authorizationServerUrl
  }
  get redirectUrl() {
    return this.redirectUri
  }
  get clientMetadata() {
    return clientMetadata(this.redirectUri)
  }
  state() {
    return this.stateValue
  }
  clientInformation() {
    // Discovery has run by now: the registration for the service it found, if the app has one.
    if (this.client === undefined && this.issuer !== undefined)
      this.client = this.registry?.get(this.issuer, this.redirectUri)
    return this.client
  }
  saveClientInformation(information: OAuthClientInformationMixed) {
    this.client = information
    const issuer = (information as { issuer?: unknown }).issuer
    if (typeof issuer === "string") this.registry?.set(issuer, this.redirectUri, information)
  }
  /** The service refused the registration or the tokens: they aren't offered again. */
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    if (scope === "all" || scope === "client") {
      if (this.issuer !== undefined) this.registry?.delete(this.issuer, this.redirectUri)
      this.client = undefined
    }
    if (scope === "all" || scope === "tokens") this.saved = undefined
  }
  tokens() {
    return this.saved
  }
  saveTokens(tokens: OAuthTokens) {
    this.saved = tokens
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url
  }
  saveCodeVerifier(verifier: string) {
    this.verifier = verifier
  }
  codeVerifier() {
    return this.verifier
  }
  saveDiscoveryState(state: OAuthDiscoveryState) {
    this.discovery = state
  }
  discoveryState() {
    return this.discovery
  }
}

const expiryOf = (tokens: OAuthTokens, now: number) =>
  typeof tokens.expires_in === "number" && Number.isFinite(tokens.expires_in) && tokens.expires_in > 0
    ? now + tokens.expires_in * 1000
    : null

/**
 * The first step: discovery, the app's registration (kept from an earlier sign-in to the same
 * redirect address), and the authorization page with its PKCE challenge and `state`.
 */
export const startSignIn = async (
  fetchFn: FetchLike,
  serverUrl: URL,
  redirectUri: string,
  previous: StoredSignIn | null,
  options: { readonly registry: ClientRegistry; readonly resourceOrigin: boolean }
): Promise<{ readonly authorizationUrl: URL; readonly pending: PendingSignIn }> => {
  // An earlier sign-in's discovery and registration only for the very address it was made for:
  // a moved server is discovered afresh, so its tokens never go to another server.
  const reuse =
    previous !== null &&
    previous.redirectUri === redirectUri &&
    previous.serverUrl === serverUrl.href &&
    previous.resourceOrigin === options.resourceOrigin
  const provider = new StepProvider(redirectUri, {
    client: reuse ? previous.client : undefined,
    discovery: reuse ? previous.discovery : null,
    registry: options.registry,
    resourceOrigin: options.resourceOrigin
  })
  const result = await auth(provider, { serverUrl, fetchFn })
  if (result !== "REDIRECT" || provider.authorizationUrl === undefined || provider.client === undefined)
    throw new Error("The server's sign-in service didn't give a sign-in page.")
  return {
    authorizationUrl: provider.authorizationUrl,
    pending: {
      serverUrl: serverUrl.href,
      resourceOrigin: options.resourceOrigin,
      client: provider.client,
      redirectUri,
      verifier: provider.verifier,
      discovery: provider.discovery ?? null,
      state: provider.stateValue
    }
  }
}

/** The browser came back with a code: exchanged, with the PKCE verifier, for the user's tokens. */
export const finishSignIn = async (
  fetchFn: FetchLike,
  serverUrl: URL,
  pending: PendingSignIn,
  code: string,
  now: number
): Promise<StoredSignIn> => {
  if (pending.serverUrl !== serverUrl.href) throw new Error("The server's address changed during the sign-in.")
  const provider = new StepProvider(pending.redirectUri, {
    client: pending.client,
    verifier: pending.verifier,
    discovery: pending.discovery,
    resourceOrigin: pending.resourceOrigin
  })
  await auth(provider, { serverUrl, authorizationCode: code, fetchFn })
  if (provider.saved === undefined) throw new Error("The server's sign-in service gave no tokens.")
  return {
    serverUrl: pending.serverUrl,
    resourceOrigin: pending.resourceOrigin,
    client: provider.client ?? pending.client,
    redirectUri: pending.redirectUri,
    tokens: provider.saved,
    discovery: provider.discovery ?? null,
    expiresAt: expiryOf(provider.saved, now),
    signedInAt: now
  }
}

/**
 * New tokens for a sign-in whose access token has expired, by its refresh token. Null: the
 * server wants the user to sign in again (no refresh token, or it was refused).
 */
export const refreshSignIn = async (
  fetchFn: FetchLike,
  serverUrl: URL,
  stored: StoredSignIn,
  now: number
): Promise<StoredSignIn | null> => {
  if (!stored.tokens.refresh_token) return null
  // Tokens are refreshed only at the server they were issued for.
  if (stored.serverUrl !== serverUrl.href) return null
  const provider = new StepProvider(stored.redirectUri, {
    client: stored.client,
    tokens: stored.tokens,
    discovery: stored.discovery,
    resourceOrigin: stored.resourceOrigin
  })
  const result = await auth(provider, { serverUrl, fetchFn })
  if (result !== "AUTHORIZED" || provider.saved === undefined || provider.saved === stored.tokens) return null
  // A server may keep the refresh token and send only a new access token.
  const tokens = provider.saved.refresh_token
    ? provider.saved
    : { ...provider.saved, refresh_token: stored.tokens.refresh_token }
  return {
    ...stored,
    client: provider.client ?? stored.client,
    tokens,
    discovery: provider.discovery ?? stored.discovery,
    expiresAt: expiryOf(tokens, now)
  }
}

/** The access token is used up to this long before it expires; then it is refreshed first. */
export const REFRESH_AHEAD_MS = 60_000

/** How long the app waits for the browser to come back from a sign-in page. */
export const SIGN_IN_PENDING_MS = 15 * 60 * 1000

/** A user may have this many sign-ins waiting at once; a newer one replaces their oldest. */
export const SIGN_IN_PENDING_PER_USER = 5

/** At most this many sign-ins wait in all. */
export const SIGN_IN_PENDING_MAX = 1000

const defaultResolve = async (host: string) =>
  (await lookup(host, { all: true, verbatim: true })).map((answer) => answer.address)

/** Raised when a sign-in step would go somewhere it may not. */
class SignInTargetRefused extends Error {
  override readonly name = "SignInTargetRefused"
}

const bareHost = (hostname: string) =>
  hostname
    .replace(/^\[(.*)\]$/, "$1")
    .replace(/\.$/, "")
    .toLowerCase()

/** `localhost` and its subdomains always mean this machine: never asked of DNS. */
const LOOPBACK = ["127.0.0.1", "::1"]
const isLocalhostName = (host: string) => host === "localhost" || host.endsWith(".localhost")

/**
 * Whether the server counts as local, from what the user typed only: an IP literal that isn't
 * public, `localhost` or a name under it, or a name or address on the instance's bypass list.
 * Never from DNS answers, which the server's operator controls.
 */
export const typedAsLocal = (
  server: URL,
  mayReach: (address: string) => boolean = (address) => sandboxMayReach(address),
  bypassed: (host: string) => boolean = () => false
) => {
  const host = bareHost(server.hostname)
  if (isIP(host) !== 0) return !mayReach(host) || bypassed(host)
  return isLocalhostName(host) || bypassed(host)
}

/**
 * Where a sign-in's requests may go (discovery, registration, the code exchange, refresh), as
 * `Network.fetchFor`'s `targetAddresses`: checked at every hop, redirects included, and the
 * connection pinned to the addresses that passed. Each name is looked up once per step, and
 * every later request and redirect to it uses those same addresses, so a DNS answer that
 * changes between the check and the connection (rebinding) is never used.
 *
 * The server's own origin is the user's choice and goes where its calls go, but pinned too.
 * Every other address is chosen by that server (its metadata names the sign-in service and its
 * endpoints), so all of its answers must be public, as the sandbox's own proxy requires: never
 * loopback, the LAN, link-local, a cloud metadata address or this host. A server the user
 * typed as local (`typedAsLocal`) may name a local sign-in service, as a self-hosted one does.
 */
export const signInTargets = (
  server: URL,
  options: {
    readonly resolve?: (host: string) => Promise<ReadonlyArray<string>>
    readonly mayReach?: (address: string) => boolean
    /** Whether a host, as typed, is on the instance's proxy bypass list. */
    readonly bypassed?: (host: string) => boolean
  } = {}
): TargetAddresses => {
  const resolve = options.resolve ?? defaultResolve
  const mayReach = options.mayReach ?? ((address: string) => sandboxMayReach(address))
  const serverIsLocal = typedAsLocal(server, mayReach, options.bypassed)
  const looked = new Map<string, Promise<ReadonlyArray<string>>>()
  const addressesOf = (target: URL) => {
    const host = bareHost(target.hostname)
    if (isIP(host) !== 0) return Promise.resolve([host])
    if (isLocalhostName(host)) return Promise.resolve(LOOPBACK)
    let found = looked.get(host)
    if (found === undefined) {
      found = resolve(host).catch(() => [] as ReadonlyArray<string>)
      looked.set(host, found)
    }
    return found
  }
  return async (target) => {
    if (!/^https?:$/.test(target.protocol) || target.username !== "" || target.password !== "")
      throw new SignInTargetRefused(`the sign-in service's address ${target.origin} isn't allowed`)
    const addresses = await addressesOf(target)
    if (addresses.length === 0) throw new SignInTargetRefused(`can't find ${target.hostname}`)
    if (target.origin !== server.origin && !serverIsLocal && addresses.some((ip) => !mayReach(ip)))
      throw new SignInTargetRefused(
        `the server named a sign-in service at ${target.origin}, which isn't a public address`
      )
    return addresses
  }
}

/**
 * What a sign-in step's failure says to the user: never the body a service answered with (it
 * may be any page the server's metadata pointed at), and short.
 */
export const briefSignInError = (text: string) => {
  const cut = text
    .replace(/(Invalid OAuth error response|Raw body)[\s\S]*$/, "the sign-in service's answer wasn't understood.")
    .trim()
  return cut.length > 200 ? `${cut.slice(0, 199)}…` : cut
}

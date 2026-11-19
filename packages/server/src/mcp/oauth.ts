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
import { auth, type OAuthClientProvider, type OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js"
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js"

/** What the app keeps of one user's sign-in, encrypted on their `mcp_uses` row. */
export interface StoredSignIn {
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

/** A provider over memory: it starts with what the step needs and records what the SDK saves. */
class StepProvider implements OAuthClientProvider {
  client: OAuthClientInformationMixed | undefined
  saved: OAuthTokens | undefined
  verifier = ""
  discovery: OAuthDiscoveryState | undefined
  authorizationUrl: URL | undefined
  readonly stateValue = randomBytes(32).toString("base64url")
  readonly redirectUri: string
  constructor(
    redirectUri: string,
    start: {
      readonly client?: OAuthClientInformationMixed | undefined
      readonly tokens?: OAuthTokens | undefined
      readonly verifier?: string | undefined
      readonly discovery?: OAuthDiscoveryState | null | undefined
    }
  ) {
    this.redirectUri = redirectUri
    this.client = start.client
    this.saved = start.tokens
    this.verifier = start.verifier ?? ""
    this.discovery = start.discovery ?? undefined
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
    return this.client
  }
  saveClientInformation(information: OAuthClientInformationMixed) {
    this.client = information
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
  previous: StoredSignIn | null
): Promise<{ readonly authorizationUrl: URL; readonly pending: PendingSignIn }> => {
  const reuse = previous !== null && previous.redirectUri === redirectUri
  const provider = new StepProvider(redirectUri, {
    client: reuse ? previous.client : undefined,
    discovery: reuse ? previous.discovery : null
  })
  const result = await auth(provider, { serverUrl, fetchFn })
  if (result !== "REDIRECT" || provider.authorizationUrl === undefined || provider.client === undefined)
    throw new Error("The server's sign-in service didn't give a sign-in page.")
  return {
    authorizationUrl: provider.authorizationUrl,
    pending: {
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
  const provider = new StepProvider(pending.redirectUri, {
    client: pending.client,
    verifier: pending.verifier,
    discovery: pending.discovery
  })
  await auth(provider, { serverUrl, authorizationCode: code, fetchFn })
  if (provider.saved === undefined) throw new Error("The server's sign-in service gave no tokens.")
  return {
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
  const provider = new StepProvider(stored.redirectUri, {
    client: stored.client,
    tokens: stored.tokens,
    discovery: stored.discovery
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

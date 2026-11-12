// What the connection screens read. Writes name the same keys to make these stale.
import { providerBaseUrl } from "@rp/shared/providerDefinitions.ts"
import {
  type Connection,
  type ConnectionId,
  originOf,
  type ProviderInfo,
  type ProviderKindInfo
} from "@rp/shared/providers.ts"
import { allOf } from "../../actions.tsx"
import { AppClient } from "../../rpc.ts"
import { defaultsAtom } from "../pickers/defaults.ts"

export const connectionsAtom = AppClient.query("ListConnections", undefined, { reactivityKeys: ["connections"] })
const credentialsAtom = AppClient.query("ListCredentials", undefined, { reactivityKeys: ["credentials"] })
const kindsAtom = AppClient.query("ListProviderKinds", undefined, { timeToLive: "5 minutes" })
const providersAtom = AppClient.query("ListProviders", undefined, { timeToLive: "5 minutes" })
/** What the connection and key screens need, requested together. */
export const providerSetupAtom = allOf({
  kinds: kindsAtom,
  providers: providersAtom,
  connections: connectionsAtom,
  credentials: credentialsAtom
})

/** The account's defaults; the writes that change them name "settings". The pickers' atom: one read for both. */
export const generationDefaultsAtom = defaultsAtom

/** Connections just created here, whose page fetches their model list once as it opens. */
export const freshConnections = new Set<ConnectionId>()

export const modelsAtom = (connectionId: ConnectionId, includeHidden: boolean) =>
  AppClient.query("ListModels", { connectionId, includeHidden }, { reactivityKeys: ["models"] })

/** The providers and API types a connection is described by. */
export interface ProviderSetup {
  readonly kinds: ReadonlyArray<ProviderKindInfo>
  readonly providers: ReadonlyArray<ProviderInfo>
}

/** A connection's provider; undefined when it's no longer offered (a plugin's, removed). */
export const providerOf = (connection: Connection, providers: ReadonlyArray<ProviderInfo>) =>
  providers.find((provider) => provider.id === connection.provider)

/** The URL a connection's requests go to: its own, else its provider's (its region's), else its kind's. */
export const effectiveBaseUrl = (connection: Connection, setup: ProviderSetup) => {
  if (connection.baseUrl !== null) return connection.baseUrl
  const provider = providerOf(connection, setup.providers)
  if (provider) return providerBaseUrl(provider, connection.providerSettings)
  return setup.kinds.find((kind) => kind.id === connection.kind)?.defaultBaseUrl ?? null
}

export const effectiveOrigin = (connection: Connection, setup: ProviderSetup) => {
  const url = effectiveBaseUrl(connection, setup)
  return url === null ? null : originOf(url)
}

/** How a connection is named in lists: its provider, and the API type where the provider has several. */
export const providerLabel = (connection: Connection, setup: ProviderSetup) => {
  const provider = providerOf(connection, setup.providers)
  const kind = setup.kinds.find((entry) => entry.id === connection.kind)
  if (!provider) return kind?.label ?? connection.kind
  const api = provider.apis.length > 1 ? provider.apis.find((entry) => entry.id === connection.kind) : undefined
  return api ? `${provider.label} · ${api.label}` : provider.label
}

/** "" or a whole number at least `min`; anything else is a problem to show. */
export const parseOptionalInt = (text: string, min: number): { value: number | null; problem: string | null } => {
  const trimmed = text.trim()
  if (trimmed === "") return { value: null, problem: null }
  const value = Number(trimmed)
  return Number.isInteger(value) && value >= min
    ? { value, problem: null }
    : { value: null, problem: `Enter a whole number of at least ${min}, or leave it empty.` }
}

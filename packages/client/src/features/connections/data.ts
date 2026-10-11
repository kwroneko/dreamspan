// What the connection screens read. Writes name the same keys to make these stale.
import { type Connection, type ConnectionId, originOf, type ProviderKindInfo } from "@rp/shared/providers.ts"
import { allOf } from "../../actions.tsx"
import { AppClient } from "../../rpc.ts"

export const connectionsAtom = AppClient.query("ListConnections", undefined, { reactivityKeys: ["connections"] })
export const credentialsAtom = AppClient.query("ListCredentials", undefined, { reactivityKeys: ["credentials"] })
export const kindsAtom = AppClient.query("ListProviderKinds", undefined, { timeToLive: "5 minutes" })
/** What the connection and key screens need, requested together. */
export const providerSetupAtom = allOf({ kinds: kindsAtom, connections: connectionsAtom, credentials: credentialsAtom })

export const modelsAtom = (connectionId: ConnectionId, includeHidden: boolean) =>
  AppClient.query("ListModels", { connectionId, includeHidden }, { reactivityKeys: ["models"] })

/** The URL a connection's requests go to: its own, or its kind's default. */
export const effectiveBaseUrl = (connection: Connection, kinds: ReadonlyArray<ProviderKindInfo>) =>
  connection.baseUrl ?? kinds.find((kind) => kind.id === connection.kind)?.defaultBaseUrl ?? null

export const effectiveOrigin = (connection: Connection, kinds: ReadonlyArray<ProviderKindInfo>) => {
  const url = effectiveBaseUrl(connection, kinds)
  return url === null ? null : originOf(url)
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
